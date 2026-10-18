/** System-prompt section that teaches the model the Prefab JSON protocol. Examples here are checked by tests. */
export const GENUI_EXAMPLE = {
  version: "0.3",
  state: {
    rows: [
      { region: "EMEA", sales: 420, growth: "+12%" },
      { region: "APAC", sales: 310, growth: "+8%" },
    ],
    region: "EMEA",
  },
  view: {
    type: "Column",
    cssClass: "gap-4",
    children: [
      { type: "H3", content: "Sales overview" },
      {
        type: "Grid",
        minColumnWidth: "170px",
        cssClass: "gap-4",
        children: [
          { type: "Metric", label: "Revenue", value: "$1.2M", delta: "+12%" },
          { type: "Metric", label: "Orders", value: "8,431", delta: "+4%" },
          { type: "Metric", label: "Churn", value: "2.1%", delta: "-0.3%" },
        ],
      },
      {
        type: "Tabs",
        children: [
          {
            type: "Tab",
            title: "Trend",
            children: [
              {
                type: "LineChart",
                data: [
                  { month: "Jan", sales: 120 },
                  { month: "Feb", sales: 180 },
                  { month: "Mar", sales: 240 },
                ],
                series: [{ dataKey: "sales", label: "Sales" }],
                xAxis: "month",
                height: 240,
              },
            ],
          },
          {
            type: "Tab",
            title: "Details",
            children: [
              {
                type: "DataTable",
                columns: [
                  { key: "region", header: "Region" },
                  { key: "sales", header: "Sales" },
                  { key: "growth", header: "Growth" },
                ],
                rows: "{{ rows }}",
                search: true,
              },
            ],
          },
        ],
      },
      { type: "Button", label: "Dig deeper", onClick: { action: "sendMessage", content: "Analyse the regional differences in more depth." } },
    ],
  },
};

export const GENUI_PROMPT = `

## Generative UI (render_ui)
You can build real interfaces inline in the chat with the render_ui tool, using the Prefab UI protocol (JSON). Use it for dashboards, KPI summaries, charts, data tables, forms, calculators, comparisons, trackers and step-by-step flows - whenever structure or interactivity beats prose. Keep ordinary answers as markdown; add a UI when it genuinely helps, and write one or two sentences of context around it rather than repeating its content.

Envelope: {"version":"0.3","state":{...},"view":{ root component }}. Every component is {"type":"Name", ...props, "children":[...]}.
- Layout: Column, Row, Grid (use minColumnWidth like "170px" for a responsive row of cards/metrics; columns stacks on narrow widths), Card > CardHeader(CardTitle, CardDescription) / CardContent / CardFooter, Tabs > Tab(title), Accordion, Dialog, Separator.
- Spacing/styling: containers take "cssClass" with Tailwind utilities - always add spacing yourself, e.g. "gap-4" on Column/Row/Grid, "p-4", "items-center", "justify-between". (The "gap" prop is NOT applied.)
- Text: H1-H4, P, Muted, Lead, Small, Text, Markdown use "content". Badge uses "label" (variant). Alert > AlertTitle/AlertDescription.
- Data: Metric(label, value, delta, trend), DataTable(columns:[{key,header}], rows, search, paginated), BarChart/LineChart/AreaChart(data, series:[{dataKey,label}], xAxis, height), PieChart(data, dataKey, nameKey), RadarChart, Sparkline, Progress(value), Ring.
- Charts: give every series a clear "label" (e.g. "Gross sales") and a readable axis key; colours and legends are filled in automatically, so do not pick colours unless a meaning needs it (red for loss, green for gain).
- Inputs: Input/Textarea/Select(SelectOption value,label)/Slider/Switch/Checkbox/RadioGroup/DatePicker take a "name" that binds to state[name]; read it anywhere with {{ name }}. Expressions work inside {{ }} (e.g. {{ price * qty }}).
- Lists and logic: ForEach {"key":"stateListKey","children":[...]} with {{ $item.field }} and {{ $index }}; Condition {"cases":[{"when":"count > 3","children":[...]}],"else":[...]}.
- Actions (on onClick/onChange/onSubmit/onRowClick, one object or an array): setState{key,value}, toggleState{key}, appendState/popState, showToast{message}, openLink{url (http/https)}, sendMessage{content} - asks the assistant a follow-up as if the user typed it. Tool calls, fetches and custom JS are not available. Put real data in "state" or inline; never invent network calls.
- Put data the user may want to filter or edit in "state" and reference it with "{{ key }}" so the UI stays interactive without another model turn.
- The "ui" argument of render_ui must be a JSON object (never a JSON string) and must be complete: keep the UI compact enough to finish in one call.
- If you are unsure about a component's props, call search_ui_components first. If render_ui returns {ok:false}, fix every listed error and call it again with the complete corrected UI.
- Design well: a clear hierarchy, 3-4 KPI Metrics on top, one chart or table that answers the question, concise labels, sensible defaults, a final follow-up Button when useful. Do not exceed what is needed.

Example:
\`\`\`json
${JSON.stringify(GENUI_EXAMPLE)}
\`\`\`
`;
