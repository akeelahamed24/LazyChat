/**
 * Populates the graph database for the demo tenant: clears the instance, loads the Meridian company data, then gives
 * each demo user real-looking workspaces (folders with files, plans, decisions, fixes, command history, todos,
 * sessions), shared memory, Omnia chat memory and Company Brain sessions.
 *
 *   npx tsx scripts/demo-graph.mts [--keep]          # --keep: do not wipe first
 *   FALKORDB_HOST=... FALKORDB_PORT=... FALKORDB_USERNAME=... FALKORDB_PASSWORD=... npx tsx scripts/demo-graph.mts
 *
 * Wiping removes EVERY graph on the connected FalkorDB instance. Run scripts/demo-seed.mts first (it creates the users).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

for (const l of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const i = l.indexOf("=");
  if (i > 0 && !(l.slice(0, i) in process.env)) process.env[l.slice(0, i)] = l.slice(i + 1); // real env wins
}
process.env.LLM_FORCE_MOCK = "1"; // deterministic brain answers; no API key needed for seeding
const env = process.env as Record<string, string>;
const keep = process.argv.includes("--keep");

const { FalkorClient } = await import("../lib/brain/graph");
const { brainConfig } = await import("../lib/brain/config");
const { createWorkspace, recordSession, endSession } = await import("../lib/dsh/workspaces");
const { addTodo, setTodoStatus, writeWorkspaceRecord, recordCommandRun, storeShared } = await import("../lib/dsh/memory");
const { withUser } = await import("../lib/auth/context");
const { ensureSession, recordTurn } = await import("../lib/brain/memory/session");
const { consolidateSession } = await import("../lib/brain/memory/consolidation");
const { captureOmniaMemory } = await import("../lib/brain/omnia-memory");
const { askAgent } = await import("../lib/brain/agent");
const { getLlm } = await import("../lib/brain/llm");
const { ensureReady } = await import("../lib/brain/bootstrap");

const cfg = brainConfig().falkordb;
console.log(`FalkorDB ${cfg.host}:${cfg.port} graph=${cfg.graphName} user=${cfg.username || "-"} tls=${cfg.tls}`);
const client = await FalkorClient.get();
if (!(await client.ping())) throw new Error("FalkorDB did not answer PING");

// ---- 1. wipe ---------------------------------------------------------------------------------------------------------
if (!keep) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (client as any).db as { list(): Promise<string[]>; selectGraph(n: string): { delete(): Promise<unknown> } };
  const graphs = await db.list();
  for (const g of graphs) await db.selectGraph(g).delete();
  console.log(`cleared ${graphs.length} graph(s): ${graphs.join(", ") || "(none)"}`);
}

// ---- 2. company data -----------------------------------------------------------------------------------------------
await ensureReady();
const seedRun = spawnSync("npx", ["tsx", "scripts/brain-seed.ts"], { stdio: "inherit", shell: true, env: process.env });
if (seedRun.status !== 0) throw new Error("brain-seed failed");

// ---- 3. demo users (uids come from Firebase) -------------------------------------------------------------------------
const KEY = env.NEXT_PUBLIC_FIREBASE_API_KEY;
const baseEmail = "akeelahamed24.2k5@gmail.com";
const [local, domain] = baseEmail.split("@");
const users = [
  { key: "alice", name: "Alice Johnson", password: "Alice@Omnia26", role: "owner" },
  { key: "bob", name: "Bob Martinez", password: "Bob@Omnia26!", role: "admin" },
  { key: "carol", name: "Carol Singh", password: "Carol@Omnia26", role: "member" },
  { key: "dan", name: "Dan Okafor", password: "Dan@Omnia26!", role: "member" },
  { key: "eve", name: "Eve Nakamura", password: "Eve@Omnia26!", role: "member" },
];
const uidOf = new Map<string, string>();
for (const u of users) {
  const r = await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${KEY}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `${local}+${u.key}@${domain}`, password: u.password, returnSecureToken: true }) })).json() as { localId?: string };
  if (!r.localId) throw new Error(`demo user ${u.key} missing - run scripts/demo-seed.mts first`);
  uidOf.set(u.key, r.localId);
}
const asUser = <T,>(key: string, fn: () => Promise<T>) => {
  const u = users.find((x) => x.key === key)!;
  return withUser({ uid: uidOf.get(key)!, email: `${local}+${key}@${domain}`, orgId: "meridian-labs", orgRole: u.role as never, isSuper: false }, fn);
};

// ---- 4. workspaces: real folders with files + graph memory -----------------------------------------------------------
interface WsSpec {
  user: string;
  name: string;
  description: string;
  files: Record<string, string>;
  goal: string[];
  plan: { title: string; steps: string[] };
  decision: { title: string; rationale: string };
  fix: { error: string; fix: string };
  commands: Array<[string, string, number]>;
  todos: Array<[string, "open" | "doing" | "done"]>;
  notes: string[];
  preference: string;
}
const WS: WsSpec[] = [
  {
    user: "alice", name: "auth-v3-migration", description: "Short-lived token migration for auth-service",
    files: {
      "README.md": "# Auth v3 migration\n\nMoves sessions from long-lived cookies to 15-minute access tokens with refresh rotation.\n\n## Status\n- dual-validate window: in progress\n- legacy refresh backfill: blocked (MER-1002)\n",
      "src/token.ts": "import { sign, verify } from './jwt';\n\nexport const ACCESS_TTL_SECONDS = 15 * 60;\n\nexport function issueAccessToken(userId: string) {\n  return sign({ sub: userId }, { expiresIn: ACCESS_TTL_SECONDS });\n}\n\nexport function validate(token: string) {\n  return verify(token);\n}\n",
      "src/migrate.ts": "// Backfills legacy refresh tokens in batches of 500.\nexport async function backfill(batch = 500) {\n  let migrated = 0;\n  // TODO: respect partner IdP dual-validate window\n  return migrated;\n}\n",
      "docs/runbook.md": "# Rollout runbook\n1. Enable dual-validate for partner IdPs\n2. Backfill refresh tokens (dry run first)\n3. Flip default TTL to 15 minutes\n4. Monitor 401 rate for 24h\n",
    },
    goal: ["Ship Auth v3 dual-validate window", "Dry-run the refresh-token backfill"],
    plan: { title: "Auth v3 rollout", steps: ["Dual-validate for partner IdPs", "Backfill legacy refresh tokens", "Switch default TTL to 15 minutes", "Remove legacy session path"] },
    decision: { title: "Use opaque refresh tokens with rotation", rationale: "Rotation limits replay; opaque tokens avoid leaking claims and allow server-side revocation." },
    fix: { error: "401 spike for partner IdP after TTL change", fix: "Extend the dual-validate window to 14 days and add a clock-skew allowance of 60s." },
    commands: [["npm test -- token", "PASS src/token.test.ts\n  issueAccessToken\n    ✓ expires in 15 minutes (4 ms)\n    ✓ rejects tampered tokens (2 ms)\n\nTests: 2 passed, 2 total", 0], ["npm run backfill -- --dry-run", "dry-run: 18,420 refresh tokens eligible, 0 written", 0], ["npm run lint", "src/migrate.ts\n  6:3  warning  Unresolved TODO  no-warning-comments\n\n1 problem (0 errors, 1 warning)", 0]],
    todos: [["Implement dual-validate middleware", "done"], ["Backfill dry-run on staging", "doing"], ["Notify partner IdP owners", "open"], ["Write rollback plan", "open"]],
    notes: ["Auth v3 uses 15-minute access tokens", "Partner IdPs need a 14-day dual-validate window"], preference: "Keep commit messages in the imperative mood",
  },
  {
    user: "bob", name: "billing-service", description: "Subscriptions, invoices and payment webhooks",
    files: {
      "README.md": "# Billing service\n\nHandles subscription lifecycle, proration and Stripe-style webhooks.\n",
      "src/webhooks.ts": "export async function handleInvoicePaid(event: { id: string; amount: number }) {\n  // idempotency: ignore events we have already processed\n  if (await seen(event.id)) return;\n  await markPaid(event);\n}\n",
      "src/proration.ts": "export function prorate(amount: number, daysUsed: number, daysInPeriod: number) {\n  return Math.round((amount * (daysInPeriod - daysUsed)) / daysInPeriod);\n}\n",
      "docs/payments.md": "# Payments\nAll webhooks are idempotent via event id. Retries use exponential backoff up to 24h.\n",
    },
    goal: ["Make payment webhooks idempotent", "Add proration tests"],
    plan: { title: "Webhook hardening", steps: ["Persist processed event ids", "Add retry with backoff", "Alert on repeated failures"] },
    decision: { title: "Store processed webhook ids in Postgres", rationale: "A unique constraint gives exactly-once semantics without a separate cache." },
    fix: { error: "Duplicate invoice emails after webhook retry", fix: "Check the processed-events table before side effects; wrap in a transaction." },
    commands: [["npm test -- proration", "PASS src/proration.test.ts\n  ✓ prorates mid-month upgrades\n  ✓ handles 31-day periods\n\nTests: 2 passed", 0], ["npm run typecheck", "src/webhooks.ts(3,12): error TS2304: Cannot find name 'seen'.", 1]],
    todos: [["Create processed_events table", "done"], ["Implement seen()/markPaid()", "doing"], ["Backoff retries", "open"]],
    notes: ["Webhooks must be idempotent by event id", "Billing runs on Postgres 16"], preference: "Prefer small PRs under 300 lines",
  },
  {
    user: "carol", name: "design-system", description: "Shared UI components and tokens",
    files: {
      "README.md": "# Design system\n\nTokens, primitives and documentation for every product surface.\n",
      "tokens/colors.json": "{\n  \"brand\": \"#3ecf8e\",\n  \"danger\": \"#e54d2e\",\n  \"surface\": \"#ffffff\"\n}\n",
      "src/Button.tsx": "export function Button({ variant = 'primary', children }: { variant?: 'primary' | 'ghost'; children: React.ReactNode }) {\n  return <button className={`btn btn-${variant}`}>{children}</button>;\n}\n",
    },
    goal: ["Ship dark mode tokens", "Audit accessibility contrast"],
    plan: { title: "Dark mode rollout", steps: ["Define semantic tokens", "Migrate Button/Card/Input", "Run contrast audit", "Publish v2.0"] },
    decision: { title: "Semantic color tokens over raw palette", rationale: "Semantic names let themes change without touching components." },
    fix: { error: "Low contrast on ghost buttons in dark mode", fix: "Raise ghost foreground to #ededed and add a 1px border token." },
    commands: [["npm run storybook:build", "Storybook build completed: 48 stories", 0], ["npm run a11y", "2 violations: color-contrast on .btn-ghost (dark)", 1]],
    todos: [["Define semantic tokens", "done"], ["Migrate Button", "done"], ["Migrate Card and Input", "doing"], ["Contrast audit", "open"]],
    notes: ["Brand green is #3ecf8e", "Components must meet WCAG AA"], preference: "Use named exports and co-locate stories with components",
  },
  {
    user: "dan", name: "mobile-app", description: "React Native client for iOS and Android",
    files: {
      "README.md": "# Mobile app\n\nReact Native client sharing the API with the web app.\n",
      "src/auth/login.ts": "export async function login(email: string, password: string) {\n  const res = await fetch('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) });\n  if (!res.ok) throw new Error('Login failed');\n  return res.json();\n}\n",
      "src/screens/Home.tsx": "export function Home() {\n  return <Text>Welcome back</Text>;\n}\n",
    },
    goal: ["Add biometric login", "Reduce cold start time"],
    plan: { title: "Cold start optimisation", steps: ["Profile startup", "Lazy-load heavy screens", "Cache the session securely"] },
    decision: { title: "Adopt Hermes engine on both platforms", rationale: "Hermes cuts cold start by ~30% and reduces memory use." },
    fix: { error: "Crash on Android 12 when requesting biometrics", fix: "Request BIOMETRIC_STRONG and fall back to device credentials." },
    commands: [["npx expo doctor", "No issues found", 0], ["npm test", "Tests: 14 passed, 14 total", 0]],
    todos: [["Biometric login prototype", "doing"], ["Hermes on iOS", "done"], ["Secure session cache", "open"]],
    notes: ["Target iOS 16+ and Android 10+", "Use Expo EAS for builds"], preference: "Show loading skeletons rather than spinners",
  },
  {
    user: "eve", name: "analytics-dashboard", description: "Product analytics UI and event pipeline client",
    files: {
      "README.md": "# Analytics dashboard\n\nCharts and funnels over the event pipeline.\n",
      "src/queries.ts": "export const dailyActiveUsers = `SELECT date_trunc('day', ts) d, count(distinct user_id) FROM events GROUP BY 1`;\n",
      "src/Funnel.tsx": "export function Funnel({ steps }: { steps: { name: string; count: number }[] }) {\n  return <div>{steps.map((s) => <p key={s.name}>{s.name}: {s.count}</p>)}</div>;\n}\n",
    },
    goal: ["Add retention cohort chart", "Speed up the funnel query"],
    plan: { title: "Retention cohorts", steps: ["Define cohorts by signup week", "Query weekly retention", "Render heatmap", "Add CSV export"] },
    decision: { title: "Pre-aggregate daily events in the warehouse", rationale: "Dashboards query rollups instead of raw events, cutting p95 from 9s to 700ms." },
    fix: { error: "Funnel query timeouts on large accounts", fix: "Add a composite index on (account_id, ts) and use the daily rollup table." },
    commands: [["npm run test:queries", "✓ dailyActiveUsers returns 30 rows\n✓ funnel handles empty steps", 0], ["npm run build", "Compiled successfully in 14.2s", 0]],
    todos: [["Cohort definition", "done"], ["Heatmap component", "doing"], ["CSV export", "open"], ["Docs for query helpers", "open"]],
    notes: ["Warehouse is ClickHouse", "p95 dashboard latency target: under 1s"], preference: "Write SQL in uppercase keywords",
  },
];

for (const w of WS) {
  const uid = uidOf.get(w.user)!;
  const dir = path.join(process.cwd(), "data", "users", uid.replace(/[^A-Za-z0-9_-]/g, "_"), "workspaces", w.name);
  for (const [rel, content] of Object.entries(w.files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  const ws = await createWorkspace(client, { name: w.name, path: dir, description: w.description, owner: uid, tags: ["demo"] });
  for (let i = 0; i < w.goal.length; i++) {
    const sid = `demo-session:${w.user}:${i}`;
    await recordSession(client, ws.id, sid, w.goal[i]);
    await writeWorkspaceRecord(client, ws.id, "summary", { text: `Worked on: ${w.goal[i]}.` }, sid);
    await endSession(client, sid, "ended");
  }
  await writeWorkspaceRecord(client, ws.id, "plan", { title: w.plan.title, steps: JSON.stringify(w.plan.steps), status: "active" });
  await writeWorkspaceRecord(client, ws.id, "decision", w.decision);
  await writeWorkspaceRecord(client, ws.id, "error", { error: w.fix.error, fix: w.fix.fix });
  await writeWorkspaceRecord(client, ws.id, "preference", { text: w.preference });
  await writeWorkspaceRecord(client, ws.id, "change", { path: Object.keys(w.files)[1], summary: "Initial implementation", kind: "edit" });
  for (const [cmd, out, code] of w.commands) await recordCommandRun(client, ws.id, cmd, out, code, 900 + Math.floor(Math.random() * 4000), `demo-session:${w.user}:0`);
  for (const [text, status] of w.todos) {
    const t = await addTodo(client, ws.id, text);
    if (status !== "open") await setTodoStatus(client, t.id, status);
  }
  await asUser(w.user, async () => {
    for (const n of w.notes) await storeShared(client, { scope: `workspace:${ws.id}`, kind: "note", text: n, tags: ["demo"] });
    await storeShared(client, { scope: "global", kind: "preference", text: w.preference, tags: ["style"] });
    await storeShared(client, { scope: "global", kind: "user_profile", text: `${users.find((u) => u.key === w.user)!.name} works at Meridian Labs`, slot: "user.employer" });
  });
  console.log(`workspace ${w.user.padEnd(6)} ${w.name}`);
}

// ---- 5. Omnia chat memory + Company Brain sessions per user ----------------------------------------------------------
const llm = getLlm({ knownServices: [], knownTopics: [] });
const chatTurns: Record<string, Array<[string, string, string]>> = {
  alice: [["demo-alice-health", "Build me an engineering health dashboard. Remember that I prefer concise status updates.", "Dashboard built from the ticket graph: 8 blocked tickets, mostly behind Auth v3."], ["demo-alice-report", "Write a Word report on the Auth v3 migration.", "Report created with ticket table, risks and appendix."]],
  bob: [["demo-bob-calc", "Make a pricing and break-even calculator. Remember my unit cost is 18 dollars.", "Calculator built with live profit, margin and break-even."], ["demo-bob-budget", "Build an Excel budget workbook for H2.", "Workbook created with Income, Expenses and Summary sheets."]],
  carol: [["demo-carol-sprint", "Create a sprint tracker for sprint 14. My name is Carol.", "Tracker built with status filter and progress."], ["demo-carol-invoice", "Generate an invoice PDF for Northwind Traders.", "Invoice created, total due 3150 dollars."]],
  dan: [["demo-dan-trip", "Build a trip planner form. I prefer window seats.", "Planner form created."], ["demo-dan-oauth", "Explain OAuth versus OIDC.", "OAuth is authorization; OIDC adds authentication."]],
  eve: [["demo-eve-laptops", "Compare three laptops. I mostly care about battery life.", "Aero 14 is the balanced pick."], ["demo-eve-onboarding", "Make an onboarding checklist.", "Checklist created with live progress."]],
};
for (const u of users) {
  const uid = uidOf.get(u.key)!;
  await asUser(u.key, async () => {
    for (const [conv, ask, answer] of chatTurns[u.key]) {
      const sid = await ensureSession(client, uid, `omnia:${conv}`);
      await recordTurn(client, sid, "user", ask);
      await recordTurn(client, sid, "assistant", answer);
      await recordTurn(client, sid, "user", "Thanks, that is what I needed.");
      await recordTurn(client, sid, "assistant", "Glad it helps - ask any time.");
      await captureOmniaMemory(conv, ask, uid);
      await consolidateSession(client, sid, uid, { force: true, llm });
    }
    // Company Brain tab: real tool-backed conversations (mock LLM; answers come straight from the graph).
    const qs = ["Who are the experts on the auth service?", "Which tickets are blocked and by what?", "What depends on payments-api?"];
    let session: string | undefined;
    for (const q of qs) {
      const r = await askAgent(q, { userId: uid, client, sessionId: session, llm });
      session = r.session_id;
    }
  });
  console.log(`memory     ${u.key}`);
}

// ---- 6. summary --------------------------------------------------------------------------------------------------------
const counts = await client.query<{ l: string; n: number }>("MATCH (n) RETURN labels(n)[0] AS l, count(n) AS n ORDER BY n DESC");
console.log("\nGraph now holds:\n" + counts.map((c) => `  ${String(c.n).padStart(4)}  ${c.l}`).join("\n"));
await client.close().catch(() => {});
process.exit(0);
