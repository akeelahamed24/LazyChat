/**
 * SSE: coalescing, parsing, and the resilient client under random connection drops.
 *
 * Run: npx tsx --test tests/unit/sse.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { UIMessageChunk } from "ai";

import { ChunkNormalizer, HEARTBEAT_CHUNK, SseParser, coalesceChunks, formatFrame } from "@/lib/sse";
import { parseEventsUrl, resilientSse } from "@/lib/resilient-sse";

const chunks = (): UIMessageChunk[] => {
  const out: UIMessageChunk[] = [{ type: "start", messageId: "m1" } as UIMessageChunk, { type: "text-start", id: "t1" } as UIMessageChunk];
  for (let i = 0; i < 40; i++) out.push({ type: "text-delta", id: "t1", delta: `w${i} ` } as UIMessageChunk);
  out.push({ type: "text-end", id: "t1" } as UIMessageChunk);
  out.push({ type: "tool-input-start", toolCallId: "c1", toolName: "render_ui" } as UIMessageChunk);
  for (let i = 0; i < 10; i++) out.push({ type: "tool-input-delta", toolCallId: "c1", inputTextDelta: `{${i}}` } as UIMessageChunk);
  out.push({ type: "finish" } as UIMessageChunk);
  return out;
};

const textOf = (frames: ReturnType<typeof coalesceChunks>) =>
  frames
    .map((f) => f.chunk as unknown as { delta?: string; inputTextDelta?: string })
    .map((c) => c.delta ?? c.inputTextDelta ?? "")
    .join("");

describe("coalesceChunks", () => {
  it("merges adjacent deltas of the same part and keeps content + order", () => {
    const all = chunks();
    const frames = coalesceChunks(all, 0, all.length);
    assert.ok(frames.length < all.length);
    assert.equal(frames.at(-1)!.id, all.length);
    const raw = all.map((c) => (c as unknown as { delta?: string; inputTextDelta?: string }).delta ?? (c as unknown as { inputTextDelta?: string }).inputTextDelta ?? "").join("");
    assert.equal(textOf(frames), raw);
  });

  it("never merges across different parts or non-delta chunks", () => {
    const c = [
      { type: "text-delta", id: "a", delta: "1" },
      { type: "text-delta", id: "b", delta: "2" },
      { type: "text-end", id: "b" },
      { type: "text-delta", id: "b", delta: "3" },
    ] as UIMessageChunk[];
    assert.equal(coalesceChunks(c, 0, 4).length, 4);
  });

  it("any frame id is a valid resume point: resuming from it reproduces the remainder", () => {
    const all = chunks();
    const full = coalesceChunks(all, 0, all.length);
    for (const f of full) {
      const rest = coalesceChunks(all, f.id, all.length);
      const idx = full.indexOf(f);
      assert.equal(textOf(rest), textOf(full.slice(idx + 1)));
    }
  });
});

describe("SseParser", () => {
  it("handles frames split at arbitrary byte boundaries, comments, ids and retry", () => {
    const wire = "retry: 1500\n\n: keepalive\n\n" + formatFrame('{"a":1}', 3) + formatFrame("[DONE]");
    for (let cut = 1; cut < wire.length; cut += 7) {
      const p = new SseParser();
      const got = [...p.feed(wire.slice(0, cut)), ...p.feed(wire.slice(cut))].filter((f) => f.data);
      assert.deepEqual(got.map((f) => [f.id, f.data]), [["3", '{"a":1}'], [undefined, "[DONE]"]]);
    }
  });
});

describe("resilientSse", () => {
  /** A fake /events endpoint that serves chunks from a cursor and may cut the connection after n frames. */
  function server(all: UIMessageChunk[], cutAfter: () => number | null) {
    const calls: number[] = [];
    const respond = (cursor: number): Response => {
      calls.push(cursor);
      const frames = coalesceChunks(all, cursor, all.length);
      const cut = cutAfter();
      const enc = new TextEncoder();
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (cut !== null && i >= cut) return c.error(new Error("network drop"));
          if (i === 0) c.enqueue(enc.encode(formatFrame(HEARTBEAT_CHUNK)));
          if (i < frames.length) c.enqueue(enc.encode(formatFrame(JSON.stringify(frames[i].chunk), frames[i].id)));
          else {
            c.enqueue(enc.encode(formatFrame("[DONE]")));
            return c.close();
          }
          i++;
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
    const fetchFn = (async (url: string) => respond(Number(new URL(url, "http://x").searchParams.get("cursor") ?? 0))) as unknown as typeof fetch;
    return { respond, fetchFn, calls };
  }

  async function collect(res: Response) {
    const parser = new SseParser();
    const dec = new TextDecoder();
    const got: UIMessageChunk[] = [];
    let done = false;
    const reader = res.body!.getReader();
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      for (const f of parser.feed(dec.decode(r.value, { stream: true }))) {
        if (f.data === "[DONE]") done = true;
        else if (f.data) got.push(JSON.parse(f.data));
      }
    }
    return { got, done };
  }

  const joined = (cs: UIMessageChunk[]) =>
    cs.map((c) => (c as unknown as { delta?: string; inputTextDelta?: string }).delta ?? (c as unknown as { inputTextDelta?: string }).inputTextDelta ?? c.type).join("|");

  it("is a no-op on a healthy connection (and strips heartbeats)", async () => {
    const all = chunks();
    const s = server(all, () => null);
    const { got, done } = await collect(resilientSse(s.respond(0), { runId: "r1", fetchFn: s.fetchFn, baseDelayMs: 1 }));
    assert.ok(done);
    assert.equal(joined(got), joined(coalesceChunks(all, 0, all.length).map((f) => f.chunk)));
    assert.deepEqual(s.calls, [0]);
  });

  it("survives repeated random drops: the assembled stream equals the uninterrupted one", async () => {
    const all = chunks();
    for (let trial = 0; trial < 25; trial++) {
      let n = 0;
      const s = server(all, () => (n++ < 6 ? 1 + ((trial * 7 + n * 3) % 5) : null));
      const { got, done } = await collect(resilientSse(s.respond(0), { runId: "r1", fetchFn: s.fetchFn, baseDelayMs: 1 }));
      assert.ok(done, `trial ${trial} finished`);
      // Reassembled text must be identical even though frame boundaries differ after resumes.
      const text = (cs: UIMessageChunk[]) => cs.map((c) => (c as unknown as { delta?: string }).delta ?? "").join("");
      const tools = (cs: UIMessageChunk[]) => cs.map((c) => (c as unknown as { inputTextDelta?: string }).inputTextDelta ?? "").join("");
      const expected = coalesceChunks(all, 0, all.length).map((f) => f.chunk);
      assert.equal(text(got), text(expected), `trial ${trial} text`);
      assert.equal(tools(got), tools(expected), `trial ${trial} tool input`);
      assert.equal(got.filter((c) => c.type === "start").length, 1);
      assert.equal(got.filter((c) => c.type === "finish").length, 1);
    }
  });

  it("gives up with an error frame when the run cannot be resumed", async () => {
    const all = chunks();
    const s = server(all, () => 2);
    const dead = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const { got, done } = await collect(resilientSse(s.respond(0), { runId: "r1", fetchFn: dead, maxRetries: 2, baseDelayMs: 1 }));
    assert.ok(done);
    assert.equal(got.at(-1)!.type, "error");
  });

  it("recovers from a stalled connection via the stall timer", async () => {
    const all = chunks();
    const hang = new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { "content-type": "text/event-stream" } });
    const s = server(all, () => null);
    const { got, done } = await collect(resilientSse(hang, { runId: "r1", fetchFn: s.fetchFn, stallMs: 20, baseDelayMs: 1 }));
    assert.ok(done);
    assert.equal(got.filter((c) => c.type === "finish").length, 1);
  });
});

describe("ChunkNormalizer", () => {
  const run = (input: Array<Record<string, unknown>>) => {
    const n = new ChunkNormalizer();
    return input.flatMap((c) => n.push(c as unknown as UIMessageChunk)).map((c) => `${c.type}${(c as { id?: string }).id ? ":" + (c as { id?: string }).id : ""}`);
  };

  it("leaves a well-formed lifecycle untouched", () => {
    const input = [
      { type: "start" }, { type: "start-step" },
      { type: "reasoning-start", id: "r0" }, { type: "reasoning-delta", id: "r0", delta: "a" }, { type: "reasoning-end", id: "r0" },
      { type: "text-start", id: "t0" }, { type: "text-delta", id: "t0", delta: "b" }, { type: "text-end", id: "t0" },
      { type: "finish-step" }, { type: "finish" },
    ];
    assert.deepEqual(run(input), input.map((c) => `${c.type}${c.id ? ":" + c.id : ""}`));
  });

  it("drops a reasoning-end that arrives with no open part (the reported error)", () => {
    assert.deepEqual(run([{ type: "reasoning-end", id: "reasoning-0" }, { type: "text-start", id: "t" }]), ["text-start:t"]);
  });

  it("drops an end that arrives after finish-step already closed the part", () => {
    const out = run([
      { type: "start-step" }, { type: "reasoning-start", id: "reasoning-0" }, { type: "reasoning-delta", id: "reasoning-0", delta: "x" },
      { type: "finish-step" }, { type: "reasoning-end", id: "reasoning-0" }, { type: "finish" },
    ]);
    assert.deepEqual(out, ["start-step", "reasoning-start:reasoning-0", "reasoning-delta:reasoning-0", "reasoning-end:reasoning-0", "finish-step", "finish"]);
  });

  it("synthesizes a start for deltas that have none, and ignores duplicate starts", () => {
    assert.deepEqual(run([{ type: "text-delta", id: "t", delta: "hi" }, { type: "text-start", id: "t" }, { type: "text-end", id: "t" }]), ["text-start:t", "text-delta:t", "text-end:t"]);
  });

  it("tracks parts per id and kind", () => {
    assert.deepEqual(run([{ type: "reasoning-start", id: "a" }, { type: "text-start", id: "a" }, { type: "text-end", id: "a" }, { type: "reasoning-end", id: "a" }]), ["reasoning-start:a", "text-start:a", "text-end:a", "reasoning-end:a"]);
  });
});

describe("resilientSse joining a run mid-way", () => {
  const sse = (chunks: Array<Record<string, unknown>>) => new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        chunks.forEach((x, i) => c.enqueue(enc.encode(formatFrame(JSON.stringify(x), i + 100))));
        c.enqueue(enc.encode(formatFrame("[DONE]")));
        c.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );

  it("never hands the AI SDK an end without a start (the reported crash)", async () => {
    const { readUIMessageStream } = await import("ai");
    // A stream that begins after reasoning-start / text-start were already sent.
    const res = resilientSse(
      sse([
        { type: "reasoning-delta", id: "reasoning-0", delta: "thinking" },
        { type: "reasoning-end", id: "reasoning-0" },
        { type: "text-delta", id: "t", delta: "answer" },
        { type: "text-end", id: "t" },
        { type: "reasoning-end", id: "reasoning-0" },
        { type: "finish" },
      ]),
      { runId: "r" },
    );
    const parser = new SseParser();
    const dec = new TextDecoder();
    const reader = res.body!.getReader();
    const chunks: UIMessageChunk[] = [];
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      for (const f of parser.feed(dec.decode(r.value, { stream: true }))) if (f.data && f.data !== "[DONE]") chunks.push(JSON.parse(f.data));
    }
    let last: { parts: Array<{ type: string; text?: string }> } | null = null;
    for await (const m of readUIMessageStream({ stream: new ReadableStream<UIMessageChunk>({ start(c) { chunks.forEach((x) => c.enqueue(x)); c.close(); } }) })) last = m as never;
    assert.deepEqual(last!.parts.map((p) => p.type), ["reasoning", "text"]);
    assert.equal(last!.parts[1].text, "answer");
  });
});

describe("parseEventsUrl", () => {
  it("extracts run id and cursor", () => {
    assert.deepEqual(parseEventsUrl("/api/chat/runs/abc123/events?cursor=42"), { runId: "abc123", cursor: 42 });
    assert.deepEqual(parseEventsUrl("http://h/api/chat/runs/abc/events"), { runId: "abc", cursor: 0 });
    assert.equal(parseEventsUrl("/api/chat"), null);
  });
});
