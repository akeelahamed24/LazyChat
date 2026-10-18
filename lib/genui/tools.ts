import { jsonSchema, tool } from "ai";
import { z } from "zod";
import { MAX_ENVELOPE_CHARS, searchCatalog, validateEnvelope } from "./envelope";
import { coerceUi } from "./partial";

/**
 * Generative-UI tools. `render_ui` shows a Prefab interface inline in the chat; its *input* is the UI, which the
 * client renders progressively while the model is still writing it. The output only reports validation, so a bad
 * UI comes back to the model as precise errors it can fix on its next step.
 */
const uiShape = z.object({
  version: z.string().optional().describe('Protocol version, always "0.3"'),
  view: z.record(z.string(), z.unknown()).describe('Root component, e.g. {"type":"Column","children":[...]}'),
  state: z.record(z.string(), z.unknown()).optional().describe("Initial client-side state; read with {{ key }}, written by inputs with a matching `name` and by setState actions"),
  defs: z.record(z.string(), z.unknown()).optional().describe('Reusable subtrees referenced by {"$ref":"name","let":{...}}'),
});

/** What the model is told: `ui` is an object. */
const advertised = z.object({
  title: z.string().max(120).optional().describe("Short title for this UI (shown in the chat)"),
  ui: uiShape.describe("The Prefab envelope as a JSON object (not a string)"),
});

/** What we accept: also a JSON string (some models double-encode), with stray tags or a cut-off tail repaired. */
const accepted = z.object({
  title: z.string().max(120).optional(),
  ui: z.preprocess(coerceUi, uiShape),
});

type RenderUiInput = z.infer<typeof advertised>;

export function buildGenUiTools() {
  return {
    render_ui: tool({
      description:
        "Show an interactive interface inline in the chat using the Prefab UI protocol: dashboards, KPI cards, charts, data tables, forms, calculators, comparison grids, status boards, wizards, timelines. " +
        "Prefer this over markdown whenever the user would benefit from structure, interactivity or visuals. " +
        "If unsure of a component's props call search_ui_components first. The result tells you whether the UI was valid; if not, fix the listed errors and call render_ui again.",
      inputSchema: jsonSchema<RenderUiInput>(z.toJSONSchema(advertised, { io: "input" }) as never, {
        validate: (value) => {
          const r = accepted.safeParse(value);
          return r.success ? { success: true, value: r.data as RenderUiInput } : { success: false, error: r.error };
        },
      }),
      execute: async ({ title, ui }) => {
        const v = validateEnvelope(ui);
        if (!v.ok) {
          return { ok: false as const, errors: v.errors.slice(0, 20), warnings: v.warnings.slice(0, 10), hint: "Fix these and call render_ui again with the corrected full UI." };
        }
        return { ok: true as const, title: title ?? null, components: v.nodes, warnings: v.warnings.slice(0, 10) };
      },
    }),

    search_ui_components: tool({
      description:
        "Look up Prefab UI components by keyword (e.g. 'chart', 'table', 'form input', 'tabs', 'progress'). Returns each matching component's exact prop names and types. Use before render_ui when you need a component you have not used recently.",
      inputSchema: z.object({ query: z.string().describe("What you need, e.g. 'bar chart' or 'date picker'") }),
      execute: async ({ query }) => searchCatalog(query),
    }),
  };
}

export { MAX_ENVELOPE_CHARS };
