/**
 * Tests for ported dsh-tool-session-query tools (session_search, session_event_read).
 *
 * Run: npx tsx --test tests/unit/session-query.test.ts
 */
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "@/lib/store";
import { enabledTools } from "@/lib/tools";

const CONV_ID = "test-session-" + Date.now();

beforeEach(async () => {
  const fp = path.join(DATA_DIR, "conversations.json");
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
});

after(async () => {
  const fp = path.join(DATA_DIR, "conversations.json");
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
});

function writeConv(conv: any): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "conversations.json"), JSON.stringify([conv]));
}

describe("session query tools", () => {
  const tools = enabledTools([], {
    provider: "openai",
    model: "gpt-4",
    conversationId: CONV_ID,
  });

  it("session_search finds matching conversations", async () => {
    writeConv({
      id: CONV_ID,
      title: "My test conversation about Python",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: "openai",
      model: "gpt-4",
      messages: [
        { role: "user", id: "msg-1", parts: [{ type: "text", text: "How do I use async/await in Python?" }] },
        { role: "assistant", id: "msg-2", parts: [{ type: "text", text: "You can use asyncio for async programming." }] },
      ],
    });

    const result = await tools.session_search.execute({ query: "async", limit: 10 });
    const typed = result as { count: number; results: Array<{ id: string; title: string; snippet: string }> };
    assert.equal(typed.count, 1);
    assert.equal(typed.results[0].id, CONV_ID);
    assert.ok(typed.results[0].snippet.includes("async"));
  });

  it("session_event_read reads messages from a conversation", async () => {
    writeConv({
      id: CONV_ID + "-read",
      title: "Read test",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: "openai",
      model: "gpt-4",
      messages: [
        { role: "user", id: "m1", parts: [{ type: "text", text: "Hello" }] },
        { role: "assistant", id: "m2", parts: [{ type: "text", text: "Hi there" }] },
        { role: "user", id: "m3", parts: [{ type: "text", text: "Bye" }] },
      ],
    });

    const result = await tools.session_event_read.execute({
      conversation_id: CONV_ID + "-read",
      limit: 50,
    });
    const typed = result as { count: number; messages: Array<{ role: string; text: string }> };
    assert.equal(typed.count, 3);
    assert.equal(typed.messages[0].text, "Bye");
    assert.equal(typed.messages[0].role, "user");
  });

  it("session_event_read returns error for unknown conversation", async () => {
    const result = await tools.session_event_read.execute({
      conversation_id: "nonexistent-conv",
      limit: 50,
    });
    assert.ok((result as { error: string }).error?.includes("not found"));
  });
});
