/**
 * Makes a chat SSE response survive network drops and stalls.
 *
 * Wraps the first response and re-emits its frames unchanged. If the connection dies (error, EOF before
 * `[DONE]`, or no bytes - not even a heartbeat - for `stallMs`), it reconnects to
 * `/api/chat/runs/:id/events?cursor=<last frame id>` with exponential backoff and keeps emitting, so the
 * consumer (the AI SDK's own SSE parser) sees one continuous, gap-free, duplicate-free stream.
 * Heartbeats are swallowed here; the stream always ends with `[DONE]`, an `error` frame if it had to give up.
 */
import type { UIMessageChunk } from "ai";
import { ChunkNormalizer, SseParser, formatFrame } from "@/lib/sse";

export interface ResilientOptions {
  runId: string | null;
  /** Cursor the first response started at (0 for a POST). */
  cursor?: number;
  signal?: AbortSignal | null;
  fetchFn?: typeof fetch;
  stallMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

export function resilientSse(first: Response, opts: ResilientOptions): Response {
  const fetchFn = opts.fetchFn ?? fetch;
  const stallMs = opts.stallMs ?? 35_000;
  const maxRetries = opts.maxRetries ?? 8;
  const baseDelay = opts.baseDelayMs ?? 500;
  const enc = new TextEncoder();
  let cancelled = false;
  // Whatever reaches the AI SDK must be a well-formed part lifecycle, even if this stream joined a run mid-way
  // (reconnect/attach) or a provider misordered its chunks: the SDK throws on "end" without "start".
  const normalizer = new ChunkNormalizer();
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const out = (text: string) => {
        try {
          controller.enqueue(enc.encode(text));
        } catch {
          cancelled = true;
        }
      };
      let res: Response | null = first;
      let cursor = opts.cursor ?? 0;
      let finished = false;
      let attempt = 0;

      while (!finished && !cancelled && !opts.signal?.aborted) {
        if (res?.body) {
          const dec = new TextDecoder();
          const parser = new SseParser();
          const reader = res.body.getReader();
          activeReader = reader;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const arm = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => void reader.cancel().catch(() => {}), stallMs);
          };
          arm();
          try {
            while (!finished) {
              const { done, value } = await reader.read();
              if (done) break;
              arm();
              for (const f of parser.feed(dec.decode(value, { stream: true }))) {
                if (f.data === "[DONE]") {
                  out(formatFrame("[DONE]"));
                  finished = true;
                  break;
                }
                if (!f.data || f.data.includes('"data-heartbeat"')) continue;
                const id = f.id !== undefined ? Number(f.id) : undefined;
                if (id !== undefined && Number.isFinite(id)) cursor = id;
                let chunk: unknown;
                try {
                  chunk = JSON.parse(f.data);
                } catch {
                  chunk = undefined;
                }
                if (chunk && typeof chunk === "object" && typeof (chunk as { type?: unknown }).type === "string") {
                  const fixed = normalizer.push(chunk as UIMessageChunk);
                  // The event id belongs to the last chunk produced from this frame (it is the resume point).
                  fixed.forEach((c, i) => out(formatFrame(JSON.stringify(c), i === fixed.length - 1 ? id : undefined)));
                } else {
                  out(formatFrame(f.data, id));
                }
                attempt = 0; // progress resets the retry budget
              }
            }
          } catch {
            /* connection dropped: fall through to reconnect */
          } finally {
            if (timer) clearTimeout(timer);
            activeReader = null;
          }
        }
        if (finished || cancelled || opts.signal?.aborted) break;

        if (!opts.runId || attempt >= maxRetries) {
          out(formatFrame(JSON.stringify({ type: "error", errorText: "Connection lost. Reload to see the final answer." })));
          out(formatFrame("[DONE]"));
          finished = true;
          break;
        }
        await sleep(Math.min(8_000, baseDelay * 2 ** attempt), opts.signal);
        attempt++;
        try {
          res = await fetchFn(`/api/chat/runs/${opts.runId}/events?cursor=${cursor}`, {
            cache: "no-store",
            signal: opts.signal ?? undefined,
          });
          if (res.status === 204 || res.status === 404 || res.status === 403) {
            // The run is gone: nothing left to resume. The finished chat is loaded from storage.
            out(formatFrame("[DONE]"));
            finished = true;
          } else if (!res.ok) {
            res = null;
          }
        } catch {
          res = null;
        }
      }
      try {
        controller.close();
      } catch {
        /* consumer went away */
      }
    },
    cancel() {
      cancelled = true;
      void activeReader?.cancel().catch(() => {});
    },
  });

  return new Response(body, { status: first.status, statusText: first.statusText, headers: first.headers });
}

/** Extract the run id (and cursor) from an `/api/chat/runs/:id/events` URL. */
export function parseEventsUrl(url: string): { runId: string; cursor: number } | null {
  const m = url.match(/\/api\/chat\/runs\/([^/?#]+)\/events(?:\?([^#]*))?/);
  if (!m) return null;
  const cursor = Number(new URLSearchParams(m[2] ?? "").get("cursor") ?? 0);
  return { runId: decodeURIComponent(m[1]), cursor: Number.isFinite(cursor) ? cursor : 0 };
}
