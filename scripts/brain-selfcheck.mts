/**
 * Runs every Company Brain tool, the single agent, the researcher/synthesizer crew and the memory pipeline against
 * the live FalkorDB (mock LLM, so no API key is needed) and reports what works.
 *
 *   npx tsx scripts/brain-selfcheck.mts            # needs the seeded graph (scripts/brain-seed.ts)
 *
 * Mutating tools only touch clearly named SELFCHECK nodes, which are removed at the end.
 */
process.env.LLM_FORCE_MOCK = "1";
import { FalkorClient } from "../lib/brain/graph";
import { execute } from "../lib/brain/tools";
import { askAgent } from "../lib/brain/agent";
import { askCrew } from "../lib/brain/crew";
import { consolidateSession } from "../lib/brain/memory/consolidation";
import { ensureSession, getTurns, listSessions, memoryStats, recallMemories } from "../lib/brain/memory/session";
import { getLlm } from "../lib/brain/llm";

const client = await FalkorClient.get();
const results: Array<[string, boolean, string]> = [];
const rec = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail.slice(0, 160) : ""}`);
};
const count = async () => (await client.query<{ n: number }>("MATCH (n) RETURN count(n) AS n"))[0].n;
const before = await count();
if (before < 100) throw new Error(`Graph looks unseeded (${before} nodes). Run: npx tsx scripts/brain-seed.ts`);

type Result = Awaited<ReturnType<typeof execute>>;
type Case = [string, Record<string, unknown>, (r: Result) => boolean];
const hasRows = (r: Result) => r.row_count > 0 || r.nodes.length > 0;
const cases: Case[] = [
  ["find_experts", { service: "auth" }, hasRows],
  ["trace_dependencies", { service: "payments", direction: "dependencies" }, hasRows],
  ["trace_dependencies", { service: "auth", direction: "dependents" }, hasRows],
  ["impact_of_failure", { service: "auth" }, hasRows],
  ["get_decision_context", { topic: "auth" }, hasRows],
  ["tickets_blocked_by", { topic: "auth" }, hasRows],
  ["tickets_for_service", { service: "auth" }, hasRows],
  ["tickets_for_service", { service: "auth", status: "blocked" }, hasRows],
  ["find_people", { name: "Priya" }, hasRows],
  ["shortest_path", { from_service: "auth", to_service: "payments" }, () => true],
  ["pagerank", { limit: 5 }, hasRows],
  ["bridge_services", { limit: 3 }, () => true],
  ["find_bottlenecks", { limit: 3 }, hasRows],
  ["central_services", { limit: 3 }, hasRows],
  ["team_clusters", {}, hasRows],
  ["graph_context", { node_id: "service:auth", depth: 2 }, hasRows],
  ["run_cypher", { cypher: "MATCH (t:Ticket) WHERE t.status = $s RETURN t.id AS id LIMIT 5", params: { s: "blocked" } }, hasRows],
  ["run_cypher", { cypher: "MATCH (n:Service) RETURN n.name AS name, n.tier AS tier ORDER BY name LIMIT 3" }, hasRows],
];
for (const [name, args, ok] of cases) {
  const r = await execute(name, client, args);
  rec(`tool ${name} ${JSON.stringify(args).slice(0, 60)}`, r.ok && ok(r), r.ok ? r.summary : (r.error ?? r.summary));
}
// run_cypher must still refuse writes
const w = await execute("run_cypher", client, { cypher: "CREATE (n:Hack {x:1}) RETURN n" });
rec("run_cypher rejects writes", !w.ok);

// ---- mutating tools, on SELFCHECK data only ------------------------------------------------------------------
const t = await execute("create_ticket", client, { title: "SELFCHECK ticket", service: "auth", priority: "p3", assignee: "Priya Raghavan", description: "temp" });
rec("tool create_ticket", t.ok, t.summary);
const key = (t.data as { key?: string } | undefined)?.key ?? (await client.query<{ k: string }>("MATCH (t:Ticket) WHERE t.title = 'SELFCHECK ticket' RETURN t.key AS k"))[0]?.k;
if (key) {
  const u = await execute("update_ticket", client, { key, status: "in_progress", priority: "p2" });
  rec("tool update_ticket", u.ok, u.summary);
} else rec("tool update_ticket", false, "no ticket key from create_ticket");
const d = await execute("record_decision", client, { title: "SELFCHECK decision", rationale: "temporary check", decided_by: "Priya Raghavan", topics: ["selfcheck"], services: ["auth"] });
rec("tool record_decision", d.ok, d.summary);
rec("get_decision_context finds the new decision", (await execute("get_decision_context", client, { topic: "selfcheck" })).row_count > 0);
const f = await execute("remember_fact", client, { subject: "SELFCHECK-A", predicate: "depends on", object: "SELFCHECK-B", detail: "temp" });
rec("tool remember_fact", f.ok, f.summary);
const kn = await execute("note_knowledge", client, { person: "Priya Raghavan", service: "auth", level: "expert" });
rec("tool note_knowledge", kn.ok, kn.summary);
rec("missing args return an error result, not a crash", !(await execute("find_experts", client, {})).ok);
rec("unknown tool is handled", !(await execute("nope", client, {})).ok);

// ---- agent, crew, memory -------------------------------------------------------------------------------------
const llm = getLlm({ knownServices: [], knownTopics: [] });
try {
  const a = await askAgent("Who are the experts on the auth service?", { userId: "selfcheck-user", client });
  rec("askAgent answers with tool trace", !!a.answer && a.tool_count >= 0, `${a.tool_count} tool calls: ${a.answer.slice(0, 80)}`);
  const a2 = await askAgent("What tickets are blocked by the auth migration?", { userId: "selfcheck-user", client, sessionId: a.session_id });
  rec("askAgent multi-turn (same session)", a2.session_id === a.session_id);
  const turns = await getTurns(client, a.session_id, 50);
  rec("session turns persisted", turns.length >= 4, `${turns.length} turns`);
  const c = await askCrew(client, "Why is the auth migration blocked and who should I talk to?", "selfcheck-crew", { userId: "selfcheck-user", llm });
  rec("askCrew (researcher + synthesizer, writes Findings)", !!c.answer, c.answer.slice(0, 80));
  const findings = await client.query<{ n: number }>("MATCH (f:Finding) RETURN count(f) AS n");
  rec("Finding nodes written (the reported crash)", findings[0].n > 0, `${findings[0].n} findings`);
  const cons = await consolidateSession(client, a.session_id, "selfcheck-user", { force: true, llm });
  rec("consolidateSession", !!cons, JSON.stringify(cons).slice(0, 100));
  const mem = await recallMemories(client, "selfcheck-user", "auth", 5);
  rec("recallMemories", Array.isArray(mem), `${mem.length} memories`);
  rec("memoryStats", !!(await memoryStats(client, "selfcheck-user")));
  rec("listSessions", (await listSessions(client, "selfcheck-user")).length > 0);
  await ensureSession(client, "selfcheck-user", "selfcheck-extra");
} catch (e) {
  rec("agent/crew/memory pipeline", false, (e as Error).message);
}

// ---- cleanup ---------------------------------------------------------------------------------------------------
// Order matters: turns hang off sessions, so remove them while the sessions still exist.
await client.write("MATCH (s:Session) WHERE s.user_id = 'selfcheck-user' OR s.id STARTS WITH 'selfcheck' OPTIONAL MATCH (s)-[:CONTAINS]->(t:Turn) DETACH DELETE t");
await client.write("MATCH (n) WHERE n.user_id = 'selfcheck-user' OR n.title = 'SELFCHECK ticket' OR n.title = 'SELFCHECK decision' OR n.name STARTS WITH 'SELFCHECK' DETACH DELETE n");
await client.write("MATCH (n) WHERE n.id STARTS WITH 'selfcheck' DETACH DELETE n");
await client.write("MATCH (f:Finding) DETACH DELETE f");
await client.write("MATCH (h:AgentHandoff) DETACH DELETE h");
const after = await count();
rec("cleanup leaves the seeded graph intact", after === before, `${before} -> ${after} nodes`);

const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await client.close().catch(() => {});
process.exit(failed.length ? 1 : 0);
