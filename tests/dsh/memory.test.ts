/**
 * Harness-bridge tests: workspace registry + durable memory on FalkorDB.
 *
 * Covers: create/list/dedup/update/archive, session grouping, shared-memory
 * store/recall/dedup/conflict/redaction/update/delete, TODOs, command logs,
 * and the injected memory context block.
 *
 * Run: `npm run test:brain` (sequential files; live graph required)
 */
import nodePath from "node:path";
import { after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LLM_FORCE_MOCK = "1";

import { FalkorClient } from "../../lib/brain/graph";
import {
  archiveWorkspace,
  createWorkspace,
  getWorkspaceByPath,
  listSessions,
  listWorkspaces,
  recordSession,
  updateWorkspace,
} from "../../lib/dsh/workspaces";
import {
  addTodo,
  buildMemoryContext,
  listTodos,
  recallShared,
  recordCommandRun,
  redactSecrets,
  setTodoStatus,
  storeShared,
  updateShared,
  deleteShared,
  writeWorkspaceRecord,
  readWorkspaceRecords,
} from "../../lib/dsh/memory";

const WS_IDS: string[] = [];
const MEM_IDS: string[] = [];
const TMPDIRS: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ws-"));
  TMPDIRS.push(dir);
  return dir;
}

afterEach(async () => {
  const client = await FalkorClient.get();
  while (WS_IDS.length > 0) {
    const id = WS_IDS.pop() as string;
    await client.write(
      "MATCH (w:Workspace {id: $id}) OPTIONAL MATCH (w)-[]-(x) DETACH DELETE w, x",
      { id },
    );
    await client.write("MATCH (n) WHERE n.workspace_id = $id DETACH DELETE n", { id });
  }
  if (MEM_IDS.length > 0) {
    const ids = MEM_IDS.splice(0);
    await client.write("MATCH (m:SharedMemory) WHERE m.id IN $ids DETACH DELETE m", { ids });
  }
});

after(async () => {
  for (const dir of TMPDIRS.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  await (await FalkorClient.get()).close();
});

describe("workspace registry", () => {
  it("creates, lists, dedups by path, updates and archives", async () => {
    const client = await FalkorClient.get();
    const dir = tmpDir();
    const ws = await createWorkspace(client, { name: "Suite WS", path: dir, tags: ["test"] });
    WS_IDS.push(ws.id);
    assert.equal(ws.name, "Suite WS");
    assert.ok(nodePath.isAbsolute(ws.path)); // "/..." on POSIX, "C:\..." on Windows

    const again = await createWorkspace(client, { name: "Other", path: dir });
    assert.equal(again.id, ws.id, "same directory returns the existing workspace");

    const byPath = await getWorkspaceByPath(client, dir);
    assert.equal(byPath?.id, ws.id);

    const renamed = await updateWorkspace(client, ws.id, { name: "Renamed" });
    assert.equal(renamed.name, "Renamed");

    const listed = await listWorkspaces(client);
    assert.ok(listed.some((w) => w.id === ws.id));

    const archived = await archiveWorkspace(client, ws.id);
    assert.equal(archived.status, "archived");
    const visible = await listWorkspaces(client);
    assert.ok(!visible.some((w) => w.id === ws.id), "archived hidden by default");
  });

  it("rejects a missing directory", async () => {
    const client = await FalkorClient.get();
    await assert.rejects(() => createWorkspace(client, { name: "Ghost", path: "/no/such/dir/xyz" }));
  });

  it("groups sessions by workspace", async () => {
    const client = await FalkorClient.get();
    const ws = await createWorkspace(client, { name: "Sess WS", path: tmpDir() });
    WS_IDS.push(ws.id);
    await recordSession(client, ws.id, "dsh-session-1", "do the thing");
    await recordSession(client, ws.id, "dsh-session-1", "do the thing");
    const sessions = await listSessions(client, ws.id);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].status, "running");
  });
});

describe("shared memory", () => {
  it("stores, recalls, dedups identical content", async () => {
    const client = await FalkorClient.get();
    const a = await storeShared(client, {
      scope: "global",
      kind: "pattern",
      text: "Suite pattern: confirm destructive commands.",
      tags: ["suite"],
    });
    MEM_IDS.push(a.id);
    const b = await storeShared(client, {
      scope: "global",
      kind: "pattern",
      text: "Suite pattern: confirm destructive commands.",
    });
    assert.equal(b.id, a.id, "identical content dedups");
    assert.equal(b.use_count, a.use_count + 1);

    const found = await recallShared(client, "whatever", "destructive commands suite");
    assert.ok(found.some((m) => m.id === a.id));
  });

  it("resolves same-slot conflicts to the newest", async () => {
    const client = await FalkorClient.get();
    const v1 = await storeShared(client, {
      scope: "global",
      kind: "preference",
      text: "Suite editor: nano",
      slot: "suite.editor",
    });
    MEM_IDS.push(v1.id);
    const v2 = await storeShared(client, {
      scope: "global",
      kind: "preference",
      text: "Suite editor: helix",
      slot: "suite.editor",
    });
    MEM_IDS.push(v2.id);
    assert.notEqual(v2.id, v1.id);
    const found = await recallShared(client, "", "suite editor");
    const slotted = found.filter((m) => m.slot === "suite.editor");
    assert.ok(slotted.some((m) => m.text.includes("helix")));
    const old = await client.query("MATCH (m:SharedMemory {id: $id}) RETURN m.text AS t", { id: v1.id });
    assert.ok(old.length === 1, "old node kept with REPLACED_BY edge");
  });

  it("redacts secrets before storage", async () => {
    const client = await FalkorClient.get();
    const m = await storeShared(client, {
      scope: "global",
      kind: "reference",
      text: "Deploy with api_key: sk-live-1234567890abcdef",
    });
    MEM_IDS.push(m.id);
    assert.ok(!m.text.includes("sk-live"), `secret leaked: ${m.text}`);
    assert.ok(m.text.includes("[REDACTED]"));
    assert.ok(redactSecrets("password= hunter2 hunter2").includes("[REDACTED]"));
  });

  it("updates and deletes", async () => {
    const client = await FalkorClient.get();
    const m = await storeShared(client, { scope: "global", kind: "note", text: "Suite temp note" });
    const updated = await updateShared(client, m.id, { text: "Suite temp note v2" });
    assert.equal(updated?.text, "Suite temp note v2");
    assert.equal(await deleteShared(client, m.id), true);
    assert.equal(await deleteShared(client, m.id), false);
  });
});

describe("workspace memory records", () => {
  it("writes plans/decisions/errors and builds the injected context", async () => {
    const client = await FalkorClient.get();
    const ws = await createWorkspace(client, { name: "Mem WS", path: tmpDir() });
    WS_IDS.push(ws.id);
    await writeWorkspaceRecord(client, ws.id, "plan", { title: "Suite plan", body: "Land the skeleton." });
    await writeWorkspaceRecord(client, ws.id, "decision", {
      title: "Suite decision",
      body: "FalkorDB for memory.",
    });
    await writeWorkspaceRecord(client, ws.id, "error", { error: "Suite boom", fix: "Suite fix" });
    await addTodo(client, ws.id, "Suite todo one");
    const t2 = await addTodo(client, ws.id, "Suite todo two");
    await setTodoStatus(client, t2.id, "done");

    const plans = await readWorkspaceRecords(client, ws.id, "plan");
    assert.equal(plans.length, 1);
    const todos = await listTodos(client, ws.id);
    assert.equal(todos.filter((t) => t.status !== "done").length, 1);

    await recordCommandRun(client, ws.id, "echo suite-hi", "suite-hi\n".repeat(5000), 0, 12);
    const ctx = await buildMemoryContext(client, ws.id);
    assert.ok(ctx.includes("Suite plan"));
    assert.ok(ctx.includes("Suite fix"));
    assert.ok(ctx.includes("Suite todo one"));
  });
});
