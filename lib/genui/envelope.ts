/**
 * Prefab protocol envelope: validation (strict, for the model) and repair (lenient, for streaming partial input).
 *
 * Envelope (protocol 0.3): { version, view, defs?, state? }. Nodes are { type, ...props, children? } or { $ref, let? };
 * actions are { action: "setState" | ... }. The same walker serves both modes:
 *   strict  -> collect errors/warnings so the tool can tell the model exactly what to fix;
 *   lenient -> silently drop whatever is unknown/incomplete so a half-streamed tree still renders.
 */
import catalogJson from "./catalog.json";

export const PROTOCOL_VERSION = "0.3";
export const MAX_ENVELOPE_CHARS = 200_000;
export const MAX_NODES = 2_000;
export const MAX_DEPTH = 40;

interface CatalogField {
  name: string;
  type: string;
  description: string;
}
interface CatalogComponent {
  type: string;
  summary: string;
  container: boolean;
  fields: CatalogField[];
}
export const CATALOG = catalogJson as unknown as {
  generatedFrom: string;
  components: CatalogComponent[];
  shapes: Array<{ name: string; summary: string; fields: CatalogField[] }>;
};

const BY_TYPE = new Map(CATALOG.components.map((c) => [c.type, c]));

/** Props every component accepts (base class + events). */
const COMMON_PROPS = new Set([
  "type", "id", "cssClass", "children", "visibleWhen", "if", "onClick", "onChange", "onSubmit", "onFocus", "onBlur",
  "onKeyDown", "onOpenChange", "onValueChange", "onSelect", "onRowClick", "style", "key", "$ref", "let", "name",
]);

/** Components that would load third-party documents into the chat page. */
const BLOCKED_TYPES = new Set(["Embed"]);

/** Series colours: distinct hues that read on both light and dark backgrounds. */
export const CHART_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ec4899", "#8b5cf6", "#06b6d4", "#f97316", "#ef4444"];
const CHART_TYPES = new Set(["BarChart", "LineChart", "AreaChart", "RadarChart", "ScatterChart", "RadialChart", "Sparkline"]);

/** "monthlyRevenue" / "monthly_revenue" -> "Monthly revenue". */
export function humanize(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  if (!spaced) return key;
  // sentence case, but keep acronyms (ARR, MRR) as they are
  const words = spaced.split(" ").map((w) => (w.length > 1 && w === w.toUpperCase() ? w : w.toLowerCase()));
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Charts the model writes are often bare: no series names, no colours, no legend. Fill those in so every chart is
 * readable and distinct without the model having to remember: named series, one colour each, a legend when there is
 * more than one series, a tooltip and a sensible height. Explicit values from the model always win.
 */
function polishChart(type: string, props: Node): void {
  if (CHART_TYPES.has(type) && Array.isArray(props.series)) {
    const series = props.series as Array<Record<string, unknown>>;
    series.forEach((s, i) => {
      if (!isObj(s)) return;
      if (typeof s.dataKey === "string" && !s.label) s.label = humanize(s.dataKey);
      if (!s.color) s.color = CHART_COLORS[i % CHART_COLORS.length];
    });
    if (props.showLegend === undefined && series.length > 1) props.showLegend = true;
  }
  if (type === "PieChart" && props.showLegend === undefined) props.showLegend = true;
  if ((CHART_TYPES.has(type) || type === "PieChart") && props.showTooltip === undefined) props.showTooltip = true;
  if ((CHART_TYPES.has(type) || type === "PieChart") && type !== "Sparkline" && props.height === undefined) props.height = 260;
}

const ALLOWED_ACTIONS = new Set(["setState", "toggleState", "appendState", "popState", "showToast", "sendMessage", "openLink", "closeOverlay"]);
const ACTION_HINTS: Record<string, string> = {
  toolCall: "tool calls are not available here; use sendMessage to ask the assistant to do something",
  fetch: "network fetches are not allowed",
  callHandler: "custom JavaScript handlers are not allowed",
  openFilePicker: "file pickers are not available",
  updateContext: "use sendMessage instead",
  requestDisplayMode: "display modes are fixed",
  setInterval: "timers are not allowed",
};

export interface Envelope {
  version: string;
  view: Node;
  defs?: Record<string, Node>;
  state?: Record<string, unknown>;
}
type Node = Record<string, unknown>;

export interface Validation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  envelope: Envelope | null;
  nodes: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function closest(name: string): string | undefined {
  let best: [number, string] | undefined;
  for (const t of BY_TYPE.keys()) {
    const d = distance(name.toLowerCase(), t.toLowerCase());
    if (!best || d < best[0]) best = [d, t];
  }
  return best && best[0] <= Math.max(2, Math.floor(name.length / 3)) ? best[1] : undefined;
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

interface Ctx {
  lenient: boolean;
  errors: string[];
  warnings: string[];
  nodes: number;
}

function walkValue(v: unknown, path: string, ctx: Ctx, depth: number): unknown {
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    v.forEach((x, i) => {
      const r = walkValue(x, `${path}[${i}]`, ctx, depth + 1);
      if (r !== DROP) out.push(r);
    });
    return out;
  }
  if (!isObj(v)) return v;
  if (typeof v.action === "string") return walkAction(v, path, ctx);
  if (typeof v.type === "string" && /^[A-Z]/.test(v.type) && !("action" in v)) {
    // A component nested inside a prop (e.g. a cell template or ComboboxOption inside `options`).
    return walkNode(v, path, ctx, depth + 1);
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    const r = walkValue(x, `${path}.${k}`, ctx, depth + 1);
    if (r !== DROP) out[k] = r;
  }
  return out;
}

const DROP = Symbol("drop");

function walkAction(a: Record<string, unknown>, path: string, ctx: Ctx): unknown {
  const name = a.action as string;
  if (!ALLOWED_ACTIONS.has(name)) {
    if (ctx.lenient) return DROP;
    ctx.errors.push(`${path}: action "${name}" is not allowed - ${ACTION_HINTS[name] ?? `use one of ${[...ALLOWED_ACTIONS].join(", ")}`}`);
    return DROP;
  }
  if (name === "openLink") {
    const url = typeof a.url === "string" ? a.url : "";
    if (!/^https?:\/\//i.test(url) && !url.includes("{{")) {
      if (!ctx.lenient) ctx.errors.push(`${path}: openLink url must be http(s)`);
      return DROP;
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(a)) {
    const r = walkValue(x, `${path}.${k}`, ctx, 0);
    if (r !== DROP) out[k] = r;
  }
  return out;
}

function walkNode(node: unknown, path: string, ctx: Ctx, depth: number): Node | typeof DROP {
  if (!isObj(node)) {
    if (!ctx.lenient) ctx.errors.push(`${path}: expected a component object like {"type": "Card", ...}`);
    return DROP;
  }
  if (depth > MAX_DEPTH) {
    if (!ctx.lenient) ctx.errors.push(`${path}: nesting deeper than ${MAX_DEPTH}`);
    return DROP;
  }
  if (typeof node.$ref === "string") {
    ctx.nodes++;
    const out: Node = { $ref: node.$ref };
    if (isObj(node.let)) out.let = walkValue(node.let, `${path}.let`, ctx, depth + 1);
    return out;
  }
  const type = node.type;
  if (typeof type !== "string" || !type) {
    if (!ctx.lenient) ctx.errors.push(`${path}: missing "type"`);
    return DROP;
  }
  const spec = BY_TYPE.get(type);
  if (!spec) {
    if (!ctx.lenient) {
      const hint = closest(type);
      ctx.errors.push(`${path}: unknown component type "${type}"${hint ? ` (did you mean "${hint}"?)` : ""}. Use search_ui_components to find valid types.`);
    }
    return DROP;
  }
  if (BLOCKED_TYPES.has(type)) {
    if (!ctx.lenient) ctx.errors.push(`${path}: component "${type}" is not allowed`);
    return DROP;
  }
  if (++ctx.nodes > MAX_NODES) {
    if (!ctx.lenient && ctx.nodes === MAX_NODES + 1) ctx.errors.push(`UI has more than ${MAX_NODES} components; simplify it`);
    return DROP;
  }

  const known = new Set([...COMMON_PROPS, ...spec.fields.map((f) => f.name)]);
  const out: Node = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "children") continue;
    if (k === "gap" && !ctx.lenient) ctx.warnings.push(`${path}: the "gap" prop has no effect; use cssClass "gap-4" (Tailwind)`);
    else if (!known.has(k) && !k.startsWith("on") && !ctx.lenient) ctx.warnings.push(`${path}: "${type}" has no prop "${k}"`);
    const r = walkValue(v, `${path}.${k}`, ctx, depth + 1);
    if (r !== DROP) out[k] = r;
  }
  polishChart(type, out);
  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) {
      if (!ctx.lenient) ctx.errors.push(`${path}.children: must be an array of components`);
    } else {
      const kids: Node[] = [];
      node.children.forEach((c, i) => {
        // Bare strings are a common model slip: wrap them as Text so the UI still reads right.
        const child = typeof c === "string" ? { type: "Text", content: c } : c;
        if (typeof c === "string" && !ctx.lenient) ctx.warnings.push(`${path}.children[${i}]: bare string wrapped as Text`);
        const r = walkNode(child, `${path}.children[${i}]`, ctx, depth + 1);
        if (r !== DROP) kids.push(r);
      });
      out.children = kids;
    }
  }
  return out;
}

function run(input: unknown, lenient: boolean): Validation {
  const ctx: Ctx = { lenient, errors: [], warnings: [], nodes: 0 };
  const fail = (msg: string): Validation => ({ ok: false, errors: [...ctx.errors, msg], warnings: ctx.warnings, envelope: null, nodes: ctx.nodes });

  if (!isObj(input)) return fail('The UI must be an object: {"version":"0.3","view":{...},"state":{...}}');
  // Be forgiving: accept a bare component as the root.
  const root = input.view !== undefined ? input : typeof input.type === "string" ? { view: input } : input;
  if (root.view === undefined) return fail('Missing "view" (the root component).');

  if (!lenient) {
    let size = 0;
    try {
      size = JSON.stringify(root).length;
    } catch {
      return fail("The UI is not valid JSON (circular reference?).");
    }
    if (size > MAX_ENVELOPE_CHARS) return fail(`The UI is ${size} characters; the limit is ${MAX_ENVELOPE_CHARS}. Use ForEach/DataTable instead of repeating components.`);
  }

  const view = walkNode(root.view, "view", ctx, 0);
  if (view === DROP) return { ok: false, errors: ctx.errors, warnings: ctx.warnings, envelope: null, nodes: ctx.nodes };

  const defs: Record<string, Node> = {};
  if (isObj(root.defs)) {
    for (const [k, v] of Object.entries(root.defs)) {
      const r = walkNode(v, `defs.${k}`, ctx, 0);
      if (r !== DROP) defs[k] = r;
    }
  }
  let state: Record<string, unknown> | undefined;
  if (isObj(root.state)) {
    state = {};
    for (const [k, v] of Object.entries(root.state)) {
      if (k.startsWith("$")) {
        if (!lenient) ctx.errors.push(`state.${k}: keys starting with "$" are reserved`);
        continue;
      }
      state[k] = v;
    }
  }
  for (const dropped of ["css", "stylesheets", "jsPipes", "jsActions", "js_pipes", "js_actions", "keyBindings"]) {
    if (dropped in root && !lenient) ctx.warnings.push(`"${dropped}" is ignored`);
  }

  const envelope: Envelope = { version: PROTOCOL_VERSION, view, ...(Object.keys(defs).length ? { defs } : {}), ...(state ? { state } : {}) };
  return { ok: ctx.errors.length === 0, errors: ctx.errors, warnings: ctx.warnings, envelope: ctx.errors.length === 0 ? envelope : null, nodes: ctx.nodes };
}

/** Full validation for the render_ui tool. */
export function validateEnvelope(input: unknown): Validation {
  return run(input, false);
}

/** Best-effort envelope from a half-streamed input; never throws, returns null until a renderable root exists. */
export function repairPartialEnvelope(input: unknown): Envelope | null {
  try {
    return run(input, true).envelope;
  } catch {
    return null;
  }
}

/** Search the component catalog (used by the search_ui_components tool). */
export function searchCatalog(query: string, limit = 6) {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const scored = CATALOG.components
    .map((c) => {
      const hay = `${c.type} ${c.summary} ${c.fields.map((f) => f.name + " " + f.description).join(" ")}`.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (c.type.toLowerCase() === t) score += 10;
        else if (c.type.toLowerCase().includes(t)) score += 4;
        if (c.summary.toLowerCase().includes(t)) score += 2;
        if (hay.includes(t)) score += 1;
      }
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const shapeNames = new Set<string>();
  const results = scored.map(({ c }) => {
    for (const f of c.fields) for (const s of CATALOG.shapes) if (f.type.includes(s.name)) shapeNames.add(s.name);
    return {
      type: c.type,
      summary: c.summary,
      acceptsChildren: c.container,
      props: c.fields.map((f) => ({ name: f.name, type: f.type, ...(f.description ? { description: f.description } : {}) })),
    };
  });
  return {
    results,
    shapes: CATALOG.shapes.filter((s) => shapeNames.has(s.name) && !["Component", "ContainerComponent", "UserProfile"].includes(s.name)),
    note: "All components also accept id, cssClass (Tailwind classes) and event props such as onClick/onChange holding an action or a list of actions.",
  };
}
