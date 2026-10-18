/**
 * Demo tenant: one organization, five Firebase users (Gmail "+" addresses that all land in one inbox), and for each
 * user a few finished chats that showcase the product - GenUI dashboards/forms/calculators streamed by render_ui,
 * and real .docx/.xlsx/.pdf files shown as inline cards. Idempotent: re-running updates the same accounts/chats.
 *
 *   npx tsx scripts/demo-seed.mts [--base you@gmail.com]
 *
 * Needs the super admin in .env.local (npm run seed:admin) and the published firestore.rules.
 * Credentials are written to data/demo-credentials.txt (gitignored).
 */
import fs from "node:fs";
import path from "node:path";

for (const l of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const i = l.indexOf("=");
  if (i > 0 && !(l.slice(0, i) in process.env)) process.env[l.slice(0, i)] = l.slice(i + 1);
}
const env = process.env as Record<string, string>;
const KEY = env.NEXT_PUBLIC_FIREBASE_API_KEY;
const PID = env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
const baseArg = process.argv.indexOf("--base");
const BASE_EMAIL = baseArg > 0 ? process.argv[baseArg + 1] : "akeelahamed24.2k5@gmail.com";
const [local, domain] = BASE_EMAIL.split("@");

// Library modules read NEXT_PUBLIC_FIREBASE_* at import time, so they must be imported after the env is loaded above.
const { buildDocx } = await import("../lib/documents/docx");
const { buildPdf } = await import("../lib/documents/pdf");
const { buildXlsx } = await import("../lib/documents/xlsx");
type Block = import("../lib/documents/spec").Block;
const { validateEnvelope } = await import("../lib/genui/envelope");
const { commit, fieldsOf } = await import("../lib/firestore-rest");
type Write = import("../lib/firestore-rest").Write;
const { toMessageDocs } = await import("../lib/chat-store");
const { withUser } = await import("../lib/auth/context");
const { importArtifactFile, ARTIFACTS_DIR } = await import("../lib/artifacts");

// ---------------------------------------------------------------------------------------------------------------
// Firebase REST helpers
// ---------------------------------------------------------------------------------------------------------------
const post = async (url: string, body: unknown) => (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<Record<string, any>>;
const idt = (m: string) => `https://identitytoolkit.googleapis.com/v1/accounts:${m}?key=${KEY}`;

async function signInOrUp(email: string, password: string, displayName: string) {
  let r = await post(idt("signInWithPassword"), { email, password, returnSecureToken: true });
  if (!r.idToken) {
    r = await post(idt("signUp"), { email, password, returnSecureToken: true });
    if (!r.idToken) throw new Error(`cannot create ${email}: ${JSON.stringify(r.error?.message ?? r)}`);
  }
  await post(idt("update"), { idToken: r.idToken, displayName, returnSecureToken: false });
  return { uid: r.localId as string, token: r.idToken as string };
}

const admin = await post(idt("signInWithPassword"), { email: env.SUPER_ADMIN_EMAIL, password: env.SUPER_ADMIN_PASSWORD, returnSecureToken: true });
if (!admin.idToken) throw new Error("super admin sign-in failed - run `npm run seed:admin` first");
const ADMIN_TOKEN: string = admin.idToken;

// ---------------------------------------------------------------------------------------------------------------
// People and organization
// ---------------------------------------------------------------------------------------------------------------
const ORG_ID = "meridian-labs";
const ORG_NAME = "Meridian Labs";
const PEOPLE = [
  { key: "alice", name: "Alice Johnson", role: "owner" as const, password: "Alice@Omnia26" },
  { key: "bob", name: "Bob Martinez", role: "admin" as const, password: "Bob@Omnia26!" },
  { key: "carol", name: "Carol Singh", role: "member" as const, password: "Carol@Omnia26" },
  { key: "dan", name: "Dan Okafor", role: "member" as const, password: "Dan@Omnia26!" },
  { key: "eve", name: "Eve Nakamura", role: "member" as const, password: "Eve@Omnia26!" },
].map((p) => ({ ...p, email: `${local}+${p.key}@${domain}` }));

type Person = (typeof PEOPLE)[number] & { uid: string; token: string };
const people: Person[] = [];
for (const p of PEOPLE) people.push({ ...p, ...(await signInOrUp(p.email, p.password, p.name)) });
const owner = people[0];

await commit(ADMIN_TOKEN, [
  { set: { path: `orgs/${ORG_ID}`, data: { name: ORG_NAME, ownerUid: owner.uid, status: "active", createdAt: Date.now() } } },
  ...people.map((p): Write => ({ set: { path: `users/${p.uid}`, data: { email: p.email.toLowerCase(), displayName: p.name, orgId: ORG_ID, orgRole: p.role, status: "active", createdAt: Date.now() } } })),
  // One pending invite, to show the invite flow in the org dialog.
  { set: { path: `invites/${`${local}+frank@${domain}`.toLowerCase()}`, data: { orgId: ORG_ID, orgRole: "member", invitedBy: owner.uid, createdAt: Date.now() } } },
]);
console.log(`org "${ORG_NAME}" + ${people.length} users written`);

// ---------------------------------------------------------------------------------------------------------------
// Demo content
// ---------------------------------------------------------------------------------------------------------------
const seed = JSON.parse(fs.readFileSync("lib/brain/seed-data.json", "utf8")) as {
  TICKETS: Array<{ id: string; title: string; status: string; priority: string; service: string; assignee: string }>;
  PEOPLE: Array<{ id: string; name: string; team: string }>;
  SERVICES: Array<{ id: string; name: string; tier: string; owner: string }>;
  TEAMS: Array<{ id: string; name: string }>;
};
const personName = new Map(seed.PEOPLE.map((p) => [p.id, p.name]));
const serviceName = new Map(seed.SERVICES.map((s) => [s.id, s.name]));
const teamName = new Map(seed.TEAMS.map((t) => [t.id, t.name]));
const byStatus = (s: string) => seed.TICKETS.filter((t) => t.status === s);
const statusCounts = ["open", "in_progress", "blocked", "done"].map((s) => ({ status: s.replace("_", " "), tickets: byStatus(s).length }));
const ticketRows = seed.TICKETS.filter((t) => t.status !== "done").map((t) => ({
  key: t.id.replace("ticket:", ""),
  title: t.title,
  service: serviceName.get(t.service) ?? t.service,
  assignee: personName.get(t.assignee) ?? "-",
  priority: t.priority.toUpperCase(),
  status: t.status.replace("_", " "),
}));
const teamLoad = seed.TEAMS.map((t) => ({
  team: t.name,
  open: seed.TICKETS.filter((k) => k.status !== "done" && seed.PEOPLE.find((p) => p.id === k.assignee)?.team === t.id).length,
}));

const U = (e: unknown) => {
  const v = validateEnvelope(e);
  if (!v.ok) throw new Error("demo UI invalid: " + v.errors.join("; "));
  return { ui: e as Record<string, unknown>, components: v.nodes };
};

// 1. Engineering health dashboard (real Meridian numbers)
const healthUi = U({
  version: "0.3",
  state: { rows: ticketRows, statusData: statusCounts, teamData: teamLoad, priority: "all", q: "" },
  view: {
    type: "Column",
    cssClass: "gap-4",
    children: [
      { type: "H3", content: "Meridian engineering health" },
      {
        type: "Grid",
        minColumnWidth: "150px",
        cssClass: "gap-4",
        children: [
          { type: "Metric", label: "Open work", value: String(seed.TICKETS.filter((t) => t.status !== "done").length), description: "tickets not done" },
          { type: "Metric", label: "Blocked", value: String(byStatus("blocked").length), delta: "needs attention", trend: "down" },
          { type: "Metric", label: "In progress", value: String(byStatus("in_progress").length), delta: "+3 this week", trend: "up" },
          { type: "Metric", label: "Services", value: String(seed.SERVICES.length), description: `${seed.SERVICES.filter((s) => s.tier === "critical").length} critical` },
        ],
      },
      { type: "Alert", variant: "warning", children: [{ type: "AlertTitle", content: "Auth v3 is the main blocker" }, { type: "AlertDescription", content: "Most blocked tickets trace back to the auth short-lived-token migration." }] },
      {
        type: "Tabs",
        children: [
          { type: "Tab", title: "By status", children: [{ type: "BarChart", data: "{{ statusData }}", series: [{ dataKey: "tickets", label: "Tickets" }], xAxis: "status", height: 220 }] },
          { type: "Tab", title: "Team load", children: [{ type: "BarChart", data: "{{ teamData }}", series: [{ dataKey: "open", label: "Open tickets" }], xAxis: "team", height: 220 }] },
          {
            type: "Tab",
            title: "All open tickets",
            children: [
              {
                type: "DataTable",
                search: true,
                paginated: true,
                pageSize: 8,
                columns: [
                  { key: "key", header: "Ticket" },
                  { key: "title", header: "Title" },
                  { key: "service", header: "Service" },
                  { key: "assignee", header: "Assignee" },
                  { key: "priority", header: "Priority" },
                  { key: "status", header: "Status" },
                ],
                rows: "{{ rows }}",
              },
            ],
          },
        ],
      },
      { type: "Button", label: "Who can unblock auth?", onClick: { action: "sendMessage", content: "Who are the experts that can unblock the Auth v3 migration, and what is each blocked on?" } },
    ],
  },
});

// 2. Pricing & break-even calculator (live, no model turn needed)
const calcUi = U({
  version: "0.3",
  state: { price: 49, cost: 18, fixed: 12000, units: 600 },
  view: {
    type: "Column",
    cssClass: "gap-4",
    children: [
      { type: "H3", content: "Pricing & break-even calculator" },
      {
        type: "Grid",
        minColumnWidth: "220px",
        cssClass: "gap-4",
        children: [
          { type: "Column", cssClass: "gap-1", children: [{ type: "Label", content: "Price per unit: {{ price | currency }}" }, { type: "Slider", name: "price", min: 5, max: 200, step: 1 }] },
          { type: "Column", cssClass: "gap-1", children: [{ type: "Label", content: "Unit cost: {{ cost | currency }}" }, { type: "Slider", name: "cost", min: 1, max: 150, step: 1 }] },
          { type: "Column", cssClass: "gap-1", children: [{ type: "Label", content: "Fixed costs: {{ fixed | currency }}" }, { type: "Slider", name: "fixed", min: 0, max: 100000, step: 500 }] },
          { type: "Column", cssClass: "gap-1", children: [{ type: "Label", content: "Units sold: {{ units | number }}" }, { type: "Slider", name: "units", min: 0, max: 5000, step: 25 }] },
        ],
      },
      {
        type: "Grid",
        minColumnWidth: "150px",
        cssClass: "gap-4",
        children: [
          { type: "Metric", label: "Profit", value: "{{ ((price - cost) * units - fixed) | currency }}" },
          { type: "Metric", label: "Margin", value: "{{ ((price - cost) / price * 100) | number }}%" },
          { type: "Metric", label: "Break-even units", value: "{{ price > cost ? (fixed / (price - cost)) | number : 'never' }}" },
          { type: "Metric", label: "Revenue", value: "{{ (price * units) | currency }}" },
        ],
      },
      {
        type: "Condition",
        cases: [
          { when: "(price - cost) * units - fixed < 0", children: [{ type: "Alert", variant: "destructive", children: [{ type: "AlertTitle", content: "Selling at a loss" }, { type: "AlertDescription", content: "Raise the price, cut unit cost, or sell more units to cover fixed costs." }] }] },
          { when: "(price - cost) * units - fixed >= 0", children: [{ type: "Alert", variant: "success", children: [{ type: "AlertTitle", content: "Profitable" }, { type: "AlertDescription", content: "At these numbers the business covers its fixed costs." }] }] },
        ],
      },
      { type: "Button", label: "Suggest a better price", onClick: { action: "sendMessage", content: "Given a unit cost of $18 and fixed costs of $12,000, suggest a price strategy and expected volume." } },
    ],
  },
});

// 3. Sprint tracker with filters and derived progress
const tasks = [
  { id: "T-101", task: "Design onboarding flow", owner: "Carol", status: "done", points: 5 },
  { id: "T-102", task: "Implement SSO login", owner: "Dan", status: "doing", points: 8 },
  { id: "T-103", task: "Billing webhooks", owner: "Bob", status: "doing", points: 8 },
  { id: "T-104", task: "Usage analytics dashboard", owner: "Eve", status: "todo", points: 5 },
  { id: "T-105", task: "Rate limit public API", owner: "Dan", status: "todo", points: 3 },
  { id: "T-106", task: "Write migration runbook", owner: "Carol", status: "done", points: 2 },
  { id: "T-107", task: "Load test checkout", owner: "Alice", status: "todo", points: 5 },
  { id: "T-108", task: "Fix flaky e2e tests", owner: "Eve", status: "doing", points: 3 },
];
const trackerUi = U({
  version: "0.3",
  state: { tasks, filter: "all", compact: false },
  view: {
    type: "Column",
    cssClass: "gap-4",
    children: [
      { type: "H3", content: "Sprint 14 tracker" },
      {
        type: "Row",
        cssClass: "gap-4 items-center flex-wrap",
        children: [
          {
            type: "Select",
            name: "filter",
            placeholder: "Filter by status",
            children: [
              { type: "SelectOption", value: "all", label: "All tasks" },
              { type: "SelectOption", value: "todo", label: "To do" },
              { type: "SelectOption", value: "doing", label: "In progress" },
              { type: "SelectOption", value: "done", label: "Done" },
            ],
          },
          { type: "Switch", name: "compact", label: "Compact" },
        ],
      },
      { type: "Progress", value: 28.6, max: 100 },
      { type: "Muted", content: "7 of 39 points done (about 18%) - 3 tasks in flight." },
      {
        type: "ForEach",
        key: "tasks",
        children: [
          {
            type: "Condition",
            cases: [
              {
                when: "filter == 'all' || filter == $item.status",
                children: [
                  {
                    type: "Card",
                    children: [
                      {
                        type: "CardContent",
                        cssClass: "flex items-center gap-3 py-3",
                        children: [
                          { type: "Badge", label: "{{ $item.status }}" },
                          { type: "Text", content: "{{ $item.id }} - {{ $item.task }}" },
                          { type: "Muted", content: "{{ $item.owner }} - {{ $item.points }} pts" },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
});

// 4. Trip planner form -> SendMessage
const tripUi = U({
  version: "0.3",
  state: { dest: "Lisbon", budget: 1800, days: 5, food: true, museums: true, nightlife: false },
  view: {
    type: "Card",
    children: [
      { type: "CardHeader", children: [{ type: "CardTitle", content: "Plan my trip" }, { type: "CardDescription", content: "Tell me what you like and I will build an itinerary." }] },
      {
        type: "CardContent",
        cssClass: "flex flex-col gap-4",
        children: [
          { type: "Input", name: "dest", placeholder: "Destination" },
          { type: "Label", content: "Budget: {{ budget | currency }}" },
          { type: "Slider", name: "budget", min: 300, max: 6000, step: 50 },
          { type: "Label", content: "Days: {{ days }}" },
          { type: "Slider", name: "days", min: 2, max: 21, step: 1 },
          { type: "Checkbox", name: "food", label: "Food & markets" },
          { type: "Checkbox", name: "museums", label: "Museums & history" },
          { type: "Checkbox", name: "nightlife", label: "Nightlife" },
        ],
      },
      {
        type: "CardFooter",
        children: [
          {
            type: "Button",
            label: "Plan my trip",
            onClick: { action: "sendMessage", content: "Plan a {{ days }}-day trip to {{ dest }} with a budget of ${{ budget }}. Interests - food: {{ food }}, museums: {{ museums }}, nightlife: {{ nightlife }}. Give me a day-by-day itinerary." },
          },
        ],
      },
    ],
  },
});

// 5. Laptop comparison (tabs, radar, cards)
const laptopUi = U({
  version: "0.3",
  state: {
    scores: [
      { metric: "Performance", Aero: 82, Titan: 96, Slate: 70 },
      { metric: "Battery", Aero: 90, Titan: 62, Slate: 95 },
      { metric: "Display", Aero: 88, Titan: 92, Slate: 74 },
      { metric: "Portability", Aero: 92, Titan: 55, Slate: 96 },
      { metric: "Value", Aero: 80, Titan: 68, Slate: 90 },
    ],
    specs: [
      { laptop: "Aero 14", cpu: "8-core 3.8GHz", ram: "16 GB", battery: "18 h", weight: "1.2 kg", price: "$1,299" },
      { laptop: "Titan 16", cpu: "16-core 5.2GHz", ram: "32 GB", battery: "7 h", weight: "2.3 kg", price: "$2,399" },
      { laptop: "Slate 13", cpu: "6-core 3.2GHz", ram: "16 GB", battery: "22 h", weight: "1.0 kg", price: "$899" },
    ],
  },
  view: {
    type: "Column",
    cssClass: "gap-4",
    children: [
      { type: "H3", content: "Laptop comparison" },
      { type: "Badge", label: "Best overall: Aero 14", variant: "success" },
      {
        type: "Tabs",
        children: [
          { type: "Tab", title: "Specs", children: [{ type: "DataTable", columns: [{ key: "laptop", header: "Laptop" }, { key: "cpu", header: "CPU" }, { key: "ram", header: "RAM" }, { key: "battery", header: "Battery" }, { key: "weight", header: "Weight" }, { key: "price", header: "Price" }], rows: "{{ specs }}" }] },
          { type: "Tab", title: "Scores", children: [{ type: "BarChart", data: "{{ scores }}", series: [{ dataKey: "Aero", label: "Aero 14" }, { dataKey: "Titan", label: "Titan 16" }, { dataKey: "Slate", label: "Slate 13" }], xAxis: "metric", height: 260 }] },
          {
            type: "Tab",
            title: "Pros & cons",
            children: [
              {
                type: "Grid",
                minColumnWidth: "200px",
                cssClass: "gap-4",
                children: [
                  { type: "Card", children: [{ type: "CardHeader", children: [{ type: "CardTitle", content: "Aero 14" }, { type: "CardDescription", content: "The balanced pick" }] }, { type: "CardContent", children: [{ type: "P", content: "+ Great battery and display" }, { type: "P", content: "- Mid-range GPU" }] }] },
                  { type: "Card", children: [{ type: "CardHeader", children: [{ type: "CardTitle", content: "Titan 16" }, { type: "CardDescription", content: "The workstation" }] }, { type: "CardContent", children: [{ type: "P", content: "+ Fastest by far" }, { type: "P", content: "- Heavy, short battery" }] }] },
                  { type: "Card", children: [{ type: "CardHeader", children: [{ type: "CardTitle", content: "Slate 13" }, { type: "CardDescription", content: "The traveller" }] }, { type: "CardContent", children: [{ type: "P", content: "+ Lightest, best value" }, { type: "P", content: "- Dimmer screen" }] }] },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
});

// 6. Onboarding checklist with live progress
const items = ["Create your account", "Join the #eng channel", "Set up your dev environment", "Ship a first pull request", "Meet your buddy"];
const checklistUi = U({
  version: "0.3",
  state: { c0: true, c1: true, c2: false, c3: false, c4: false },
  view: {
    type: "Card",
    children: [
      { type: "CardHeader", children: [{ type: "CardTitle", content: "Week-one onboarding" }, { type: "CardDescription", content: "{{ (c0 ? 1 : 0) + (c1 ? 1 : 0) + (c2 ? 1 : 0) + (c3 ? 1 : 0) + (c4 ? 1 : 0) }} of 5 done" }] },
      {
        type: "CardContent",
        cssClass: "flex flex-col gap-3",
        children: [
          { type: "Progress", value: "{{ ((c0 ? 1 : 0) + (c1 ? 1 : 0) + (c2 ? 1 : 0) + (c3 ? 1 : 0) + (c4 ? 1 : 0)) * 20 }}", max: 100 },
          ...items.map((label, i) => ({ type: "Checkbox", name: `c${i}`, label })),
          {
            type: "Condition",
            cases: [{ when: "c0 && c1 && c2 && c3 && c4", children: [{ type: "Alert", variant: "success", children: [{ type: "AlertTitle", content: "All set!" }, { type: "AlertDescription", content: "Onboarding complete - welcome aboard." }] }] }],
          },
        ],
      },
    ],
  },
});

// ---- documents -----------------------------------------------------------------------------------------------------
const authReport: Block[] = [
  { type: "heading", level: 1, text: "Executive summary" },
  { type: "paragraph", text: "The **Auth v3** migration moves sessions to 15-minute tokens. It reduces blast radius after the October 3 latency incident but currently blocks **several downstream tickets**." },
  { type: "list", items: ["Decision accepted on 2026-07-09, owner: Priya Raghavan", "Dual-validate window protects partner IdPs", "Legacy refresh-token backfill is the critical path"], ordered: false },
  { type: "heading", level: 1, text: "Ticket status" },
  { type: "table", header: ["Ticket", "Title", "Status", "Priority"], rows: seed.TICKETS.filter((t) => t.service === "service:auth").map((t) => [t.id.replace("ticket:", ""), t.title, t.status.replace("_", " "), t.priority.toUpperCase()]), caption: "Source: Company Brain" },
  { type: "heading", level: 1, text: "Risks and next steps" },
  { type: "list", items: ["**Risk:** partner IdPs not ready for short-lived tokens", "**Mitigation:** extend the dual-validate window by two weeks", "*Next:* schedule the backfill dry-run"], ordered: true },
  { type: "pagebreak" },
  { type: "heading", level: 2, text: "Appendix - affected services" },
  { type: "table", header: ["Service", "Tier"], rows: seed.SERVICES.map((s) => [s.name, s.tier]) },
];
const invoice: Block[] = [
  { type: "paragraph", text: "**Invoice #1042** - issued 2026-10-01, due 2026-10-31" },
  { type: "paragraph", text: "Bill to: Northwind Traders, 42 Harbour Road, Mumbai" },
  { type: "table", header: ["Description", "Qty", "Unit price", "Amount"], rows: [["Platform subscription (Oct)", 1, "$2,400.00", "$2,400.00"], ["Additional seats", 12, "$25.00", "$300.00"], ["Priority support", 1, "$450.00", "$450.00"]] },
  { type: "paragraph", text: "**Total due: $3,150.00**", align: "right" },
  { type: "paragraph", text: "Thank you for your business. Payment by bank transfer within 30 days." },
];
const budgetXlsx = buildXlsx({
  sheets: [
    {
      name: "Income",
      header: ["Month", "Subscriptions", "Services", "Total"],
      rows: ["Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map((m, i) => [m, 42000 + i * 3500, 8000 + i * 900, { formula: `B${i + 2}+C${i + 2}` }]).concat([["Total", { formula: "SUM(B2:B7)" }, { formula: "SUM(C2:C7)" }, { formula: "SUM(D2:D7)" }] as never]),
      numberFormats: { B: "$#,##0", C: "$#,##0", D: "$#,##0" },
    },
    {
      name: "Expenses",
      header: ["Category", "Monthly", "Annual"],
      rows: [["Payroll", 61000], ["Cloud", 9400], ["Marketing", 7200], ["Office", 3100], ["Tools", 2600]].map(([c, v], i) => [c, v, { formula: `B${i + 2}*12` }]).concat([["Total", { formula: "SUM(B2:B6)" }, { formula: "SUM(C2:C6)" }] as never]),
      numberFormats: { B: "$#,##0", C: "$#,##0" },
    },
    {
      name: "Summary",
      header: ["Metric", "Value"],
      rows: [["Half-year income", { formula: "Income!D8" }], ["Annual expenses", { formula: "Expenses!C7" }], ["Monthly burn", { formula: "Expenses!B7" }], ["Gross margin %", { formula: "ROUND((Income!D8*2-Expenses!C7)/(Income!D8*2)*100,1)" }]],
    },
  ],
});

// ---------------------------------------------------------------------------------------------------------------
// Chat builders
// ---------------------------------------------------------------------------------------------------------------
type Msg = { id: string; role: "user" | "assistant"; parts: unknown[] };
let mid = 0;
const nid = (p: string) => `${p}${(++mid).toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const user = (text: string): Msg => ({ id: nid("u"), role: "user", parts: [{ type: "text", text }] });
const asst = (...parts: unknown[]): Msg => ({ id: nid("a"), role: "assistant", parts: [{ type: "step-start" }, ...parts] });
const text = (t: string) => ({ type: "text", text: t, state: "done" });
const renderUi = (title: string, built: { ui: Record<string, unknown>; components: number }) => ({
  type: "tool-render_ui",
  toolCallId: nid("call"),
  state: "output-available",
  input: { title, ui: built.ui },
  output: { ok: true, title, components: built.components, warnings: [] },
});
const docPart = (title: string, kind: string, meta: { id: string; filename: string; size?: number }, detail: Record<string, unknown> = {}) => ({
  type: "tool-generate_document",
  toolCallId: nid("call"),
  state: "output-available",
  input: { kind, title, spec: { blocks: [] } },
  output: { ok: true, artifactId: meta.id, title, type: kind, filename: meta.filename, size: meta.size, url: `/api/files/${meta.id}/${encodeURIComponent(meta.filename)}`, ...detail, message: `Created ${meta.filename}` },
});

// remove earlier demo artifacts so reruns do not pile up
const idxFile = path.join(ARTIFACTS_DIR, "_index.json");
if (fs.existsSync(idxFile)) {
  const uids = new Set(people.map((p) => p.uid));
  const idx = JSON.parse(fs.readFileSync(idxFile, "utf8")) as Array<{ id: string; ownerId?: string }>;
  for (const a of idx.filter((x) => x.ownerId && uids.has(x.ownerId))) fs.rmSync(path.join(ARTIFACTS_DIR, a.id), { recursive: true, force: true });
  fs.writeFileSync(idxFile, JSON.stringify(idx.filter((x) => !(x.ownerId && uids.has(x.ownerId))), null, 2));
}

const artifact = (p: Person, conv: string, title: string, type: "docx" | "pdf" | "xlsx", filename: string, data: Buffer) =>
  withUser({ uid: p.uid, email: p.email, orgId: ORG_ID, orgRole: p.role, isSuper: false }, () => importArtifactFile({ title, type, filename, data, conversationId: conv }));

const [alice, bob, carol, dan, eve] = people;
const t0 = Date.now() - 6 * 24 * 3600_000;
type Chat = { id: string; owner: Person; title: string; messages: Msg[]; ageHours: number };
const chats: Chat[] = [];

{
  const cid = "demo-alice-health";
  chats.push({
    id: cid, owner: alice, title: "Engineering health dashboard", ageHours: 5,
    messages: [
      user("Using the company brain, build me an engineering health dashboard: KPIs, tickets by status, load per team, and every open ticket."),
      asst(text("I pulled the live ticket graph from the Company Brain and built this dashboard. The blocked work is concentrated around the Auth v3 migration."), renderUi("Meridian engineering health", healthUi), text("Use the tabs to switch between status, team load and the full ticket list, and the table is searchable.")),
      user("Who are the experts that can unblock the Auth v3 migration, and what is each blocked on?"),
      asst(text("**Priya Raghavan** (Staff Platform Engineer) owns the Auth v3 decision and the token migration. **Yuki Tanaka** is blocked on the legacy refresh-token backfill (MER-1002), which waits on MER-1001. **Dan Osei** is the second expert on auth-service and can pair on the dual-validate window for partner IdPs.")),
    ],
  });
  const docCid = "demo-alice-report";
  const meta = await artifact(alice, docCid, "Auth v3 Migration Status", "docx", "Auth-v3-Migration-Status.docx", await buildDocx("Auth v3 Migration Status", authReport));
  chats.push({
    id: docCid, owner: alice, title: "Auth v3 migration report (Word)", ageHours: 28,
    messages: [
      user("Write a Word report on the Auth v3 migration: summary, ticket table, risks and an appendix of services."),
      asst(text("Here is the report - it includes the live ticket table, risks with mitigations, and an appendix page."), docPart("Auth v3 Migration Status", "docx", meta, { sections: authReport.length }), text("You can open it in the side panel or download the .docx.")),
    ],
  });
  void cid;
}
{
  chats.push({
    id: "demo-bob-calc", owner: bob, title: "Pricing & break-even calculator", ageHours: 9,
    messages: [
      user("Make me an interactive pricing calculator: price, unit cost, fixed costs, units sold. Show profit, margin and break-even, and warn when we lose money."),
      asst(text("Drag the sliders - everything recalculates instantly, no model round-trip needed."), renderUi("Pricing & break-even calculator", calcUi)),
    ],
  });
  const cid = "demo-bob-budget";
  const meta = await artifact(bob, cid, "H2 Budget Workbook", "xlsx", "H2-Budget-Workbook.xlsx", budgetXlsx);
  chats.push({
    id: cid, owner: bob, title: "H2 budget workbook (Excel)", ageHours: 52,
    messages: [
      user("Build an Excel budget: monthly income for six months, expense categories with annual totals, and a summary sheet with formulas and margin."),
      asst(text("The workbook has three sheets with live formulas (totals, annualisation and gross margin)."), docPart("H2 Budget Workbook", "xlsx", meta, { sheets: 3 })),
    ],
  });
}
{
  chats.push({
    id: "demo-carol-sprint", owner: carol, title: "Sprint 14 tracker", ageHours: 12,
    messages: [
      user("Create a sprint tracker with 8 tasks, a status filter, a compact switch and an overall progress bar."),
      asst(text("Pick a status in the filter to narrow the list - it filters instantly in the UI."), renderUi("Sprint 14 tracker", trackerUi)),
    ],
  });
  const cid = "demo-carol-invoice";
  const meta = await artifact(carol, cid, "Invoice 1042", "pdf", "Invoice-1042.pdf", await buildPdf("Invoice 1042", invoice));
  chats.push({
    id: cid, owner: carol, title: "Invoice #1042 (PDF)", ageHours: 70,
    messages: [
      user("Generate a one-page PDF invoice for Northwind Traders: subscription, 12 extra seats and priority support."),
      asst(text("Invoice ready - total due is **$3,150.00**."), docPart("Invoice 1042", "pdf", meta)),
    ],
  });
}
{
  chats.push({
    id: "demo-dan-trip", owner: dan, title: "Trip planner form", ageHours: 3,
    messages: [
      user("Build a trip planner form: destination, budget slider, days and interests, with a button that asks you to plan it."),
      asst(text("Set your preferences and press the button - it sends them to me as a message."), renderUi("Plan my trip", tripUi)),
    ],
  });
  chats.push({
    id: "demo-dan-oauth", owner: dan, title: "OAuth vs OIDC", ageHours: 40,
    messages: [
      user("Explain OAuth 2.0 vs OpenID Connect with a comparison table and a short code example."),
      asst({ type: "reasoning", text: "The user wants a concise but accurate contrast: authorization vs authentication, tokens involved, typical flow.", state: "done" }, text(
        "**OAuth 2.0** is an *authorization* framework: it lets an app act on a user's behalf. **OpenID Connect (OIDC)** is an *authentication* layer on top of it that tells the app who the user is.\n\n| | OAuth 2.0 | OIDC |\n|---|---|---|\n| Purpose | Delegated access | Sign-in / identity |\n| Token | Access token | ID token (JWT) + access token |\n| Scope | `read:mail`, ... | `openid profile email` |\n\n```ts\n// OIDC authorization request\nconst url = new URL(\"https://idp.example.com/authorize\");\nurl.searchParams.set(\"scope\", \"openid profile email\");\nurl.searchParams.set(\"response_type\", \"code\");\n```\n\nUse OAuth alone for API access; add OIDC when you need to know *who* signed in."
      )),
    ],
  });
}
{
  chats.push({
    id: "demo-eve-laptops", owner: eve, title: "Laptop comparison", ageHours: 7,
    messages: [
      user("Compare three laptops (Aero 14, Titan 16, Slate 13) with specs, scores per category and pros/cons cards."),
      asst(text("Aero 14 is the best all-rounder; Titan wins on raw power and Slate on portability and price."), renderUi("Laptop comparison", laptopUi)),
    ],
  });
  chats.push({
    id: "demo-eve-onboarding", owner: eve, title: "Week-one onboarding checklist", ageHours: 30,
    messages: [
      user("Make an onboarding checklist with five steps, live progress and a celebration when all are done."),
      asst(text("Tick the boxes - progress updates live and a success banner appears at 100%."), renderUi("Week-one onboarding", checklistUi)),
    ],
  });
}

// ---- write chats to Firestore (as each owner, like the app does) -----------------------------------------------------
for (const c of chats) {
  const created = Date.now() - c.ageHours * 3600_000;
  const writes: Write[] = [
    {
      set: {
        path: `conversations/${c.id}`,
        data: {
          ownerId: c.owner.uid,
          orgId: ORG_ID,
          title: c.title,
          createdAt: created,
          updatedAt: created + 90_000,
          provider: "nvidia",
          model: "nvidia/nemotron-3-super-120b-a12b",
          usage: { inputTokens: 2400 + c.messages.length * 900, outputTokens: 1100 + c.messages.length * 500 },
          lastRun: { inputTokens: 2600, outputTokens: 1400, decodeMs: 14_000, at: created + 90_000 },
          messageCount: c.messages.length,
        },
      },
    },
    ...toMessageDocs(c.messages).map((d): Write => ({ set: { path: `conversations/${c.id}/messages/${d.id}`, data: d.data } })),
  ];
  await commit(c.owner.token, writes);
  console.log(`chat  ${c.owner.key.padEnd(6)} ${c.title}`);
}
void fieldsOf;
void t0;

// ---- credentials -----------------------------------------------------------------------------------------------------
const lines = [
  `Organization: ${ORG_NAME} (${ORG_ID})`,
  `Sign in at /login. Every address below delivers to ${BASE_EMAIL}.`,
  "",
  ...people.map((p) => `${p.role.padEnd(7)} ${p.name.padEnd(15)} ${p.email.padEnd(44)} ${p.password}`),
  "",
  `Pending invite: ${local}+frank@${domain} (sign up with it to join automatically)`,
  `Super admin: ${env.SUPER_ADMIN_EMAIL} (opens /admin)`,
];
fs.mkdirSync("data", { recursive: true });
fs.writeFileSync("data/demo-credentials.txt", lines.join("\n") + "\n");
console.log("\n" + lines.join("\n"));
process.exit(0);
