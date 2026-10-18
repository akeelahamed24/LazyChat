/**
 * Server-Sent Events helpers shared by the chat run stream (server) and the resilient client transport.
 *
 * Wire contract for /api/chat and /api/chat/runs/:id/events:
 *   - every chunk frame carries `id: N` where N is the number of run chunks consumed *including* that frame,
 *     so reconnecting with `?cursor=N` (or `Last-Event-ID: N`) resumes with exactly chunk N onwards;
 *   - adjacent deltas for the same part are coalesced into one frame (the id is the last chunk it covers);
 *   - `data-heartbeat` frames (transient, no id) prove liveness; the stream ends with `data: [DONE]`.
 */
import type { UIMessageChunk } from "ai";

export const HEARTBEAT_CHUNK = JSON.stringify({ type: "data-heartbeat", data: {}, transient: true });

export function formatFrame(data: string, id?: number): string {
  return `${id !== undefined ? `id: ${id}\n` : ""}data: ${data}\n\n`;
}

type Delta = { type: string; id?: string; toolCallId?: string; delta?: string; inputTextDelta?: string; providerMetadata?: unknown };

function deltaKey(c: Delta): string | null {
  if (c.providerMetadata) return null;
  if ((c.type === "text-delta" || c.type === "reasoning-delta") && typeof c.delta === "string") return `${c.type}:${c.id}`;
  if (c.type === "tool-input-delta" && typeof c.inputTextDelta === "string") return `${c.type}:${c.toolCallId}`;
  return null;
}

/**
 * Chunks [from, to) as frames, merging adjacent deltas of the same part. `id` of each frame is the cursor after
 * the last chunk it covers, so any frame boundary is a valid resume point.
 */
export function coalesceChunks(chunks: readonly UIMessageChunk[], from: number, to: number): Array<{ id: number; chunk: UIMessageChunk }> {
  const out: Array<{ id: number; chunk: UIMessageChunk }> = [];
  let prevKey: string | null = null;
  for (let i = Math.max(0, from); i < Math.min(to, chunks.length); i++) {
    const chunk = chunks[i];
    const key = deltaKey(chunk as Delta);
    const last = out[out.length - 1];
    if (key && key === prevKey && last) {
      const a = last.chunk as Delta;
      const b = chunk as Delta;
      last.chunk = (a.type === "tool-input-delta"
        ? { ...a, inputTextDelta: (a.inputTextDelta ?? "") + (b.inputTextDelta ?? "") }
        : { ...a, delta: (a.delta ?? "") + (b.delta ?? "") }) as unknown as UIMessageChunk;
      last.id = i + 1;
    } else {
      out.push({ id: i + 1, chunk });
    }
    prevKey = key;
  }
  return out;
}

/**
 * Repairs chunk streams that violate the AI SDK's part lifecycle (start -> delta* -> end), which some providers
 * emit (e.g. `reasoning-end` after `finish-step`, or deltas with no start). The client throws on these
 * ("Received reasoning-end for missing reasoning part"), so we fix them once on the server:
 *   - a delta for a part that is not open gets a synthesized start first;
 *   - an end for a part that is not open is dropped (the part was already closed);
 *   - a duplicate start for an open part is dropped;
 *   - `finish-step` / `finish` / `abort` close any parts still open, then pass through.
 */
export class ChunkNormalizer {
  private open = new Map<string, "text" | "reasoning">();

  push(chunk: UIMessageChunk): UIMessageChunk[] {
    const c = chunk as { type: string; id?: string; providerMetadata?: unknown };
    const kind = c.type.startsWith("text-") ? "text" : c.type.startsWith("reasoning-") ? "reasoning" : null;
    if (!kind || c.id === undefined) {
      if (c.type === "finish-step" || c.type === "finish" || c.type === "abort") {
        const closing = [...this.open].map(([key, k]) => ({ type: `${k}-end`, id: key.slice(k.length + 1) }) as unknown as UIMessageChunk);
        this.open.clear();
        return [...closing, chunk];
      }
      return [chunk];
    }
    const key = `${kind}:${c.id}`;
    const phase = c.type.slice(kind.length + 1); // start | delta | end
    if (phase === "start") {
      if (this.open.has(key)) return [];
      this.open.set(key, kind);
      return [chunk];
    }
    if (phase === "delta") {
      if (this.open.has(key)) return [chunk];
      this.open.set(key, kind);
      return [{ type: `${kind}-start`, id: c.id } as unknown as UIMessageChunk, chunk];
    }
    if (phase === "end") {
      if (!this.open.has(key)) return [];
      this.open.delete(key);
      return [chunk];
    }
    return [chunk];
  }
}

export interface SseFrame {
  id?: string;
  data: string;
  retry?: number;
}

/** Incremental SSE parser: feed text as it arrives, get complete frames back. Comments (`:`) are ignored. */
export class SseParser {
  private buf = "";

  feed(text: string): SseFrame[] {
    this.buf += text.replace(/\r\n/g, "\n");
    const frames: SseFrame[] = [];
    let i: number;
    while ((i = this.buf.indexOf("\n\n")) >= 0) {
      const raw = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      let id: string | undefined;
      let retry: number | undefined;
      const data: string[] = [];
      for (const line of raw.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        const c = line.indexOf(":");
        const field = c < 0 ? line : line.slice(0, c);
        const value = c < 0 ? "" : line.slice(c + 1).replace(/^ /, "");
        if (field === "id") id = value;
        else if (field === "retry") retry = Number(value) || undefined;
        else if (field === "data") data.push(value);
      }
      if (data.length || id !== undefined || retry !== undefined) frames.push({ id, retry, data: data.join("\n") });
    }
    return frames;
  }
}
