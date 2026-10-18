/**
 * Agent tools: the only way the agent is allowed to touch the graph.
 *
 * Every tool returns a `ToolResult` carrying
 *   - a human-readable `summary` (goes straight into the reasoning trace),
 *   - the `cypher` that ran (so the UI can show it),
 *   - the nodes/edges it touched (so the answer can be visualised), and
 *   - a row count.
 *
 * That triple — summary, query, contributing subgraph — is what makes an answer
 * explainable rather than merely correct.
 */
import { GraphError, coerceNode, type FalkorClient } from "./graph";
import * as queries from "./cypher";
import * as algorithms from "./algorithms";
import type { BrainNode, ToolResult } from "./types";

export { GraphError };

export type InputSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
};

export type ToolDef = {
  name: string;
  description: string;
  input_schema: InputSchema;
  executor: (client: FalkorClient, args: Record<string, unknown>) => Promise<ToolResult>;
};

export const REGISTRY = new Map<string, ToolDef>();

function empty(tool: string, overrides: Partial<ToolResult> = {}): ToolResult {
  return {
    tool,
    ok: true,
    summary: "",
    nodes: [],
    edges: [],
    row_count: 0,
    ...overrides,
  };
}

function tool(
  name: string,
  description: string,
  input_schema: InputSchema,
  executor: ToolDef["executor"],
): void {
  REGISTRY.set(name, { name, description, input_schema, executor });
}

/** Display name for a node, tolerating any serialised shape. */
function nameOf(value: unknown): string {
  const node = coerceNode(value);
  if (!node) return String(value).slice(0, 40);
  return node.name || node.id;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Expertise
// ---------------------------------------------------------------------------

tool(
  "find_experts",
  "Rank the people who know a service, using declared expertise plus who owns " +
    "the service's team and who is assigned to its open tickets. Returns each " +
    "person's score and the evidence behind it.",
  {
    type: "object",
    properties: { service: { type: "string", description: "Partial service name, e.g. 'auth'" } },
    required: ["service"],
  },
  async (client, args) => {
    const service = asString(args.service);
    const ranked = await algorithms.expertFinder(client, service);
    if (ranked.length === 0) {
      return empty("find_experts", { summary: `No one is recorded as knowing '${service}'.` });
    }
    const top = ranked.slice(0, 5);
    const people = top.map((e) => `${e.person.name} (${round(e.score, 1)})`).join(", ");
    return empty("find_experts", {
      summary: `${ranked.length} people know ${service}. Best matches: ${people}.`,
      data: top,
      cypher: algorithms.EXPERT_FINDER,
      nodes: top.map((e) => e.person),
      row_count: ranked.length,
    });
  },
);

// ---------------------------------------------------------------------------
// Dependencies / blast radius
// ---------------------------------------------------------------------------

tool(
  "trace_dependencies",
  "List the services a service directly depends on (what it needs to run), or " +
    "the services that depend on it when direction is 'dependents'.",
  {
    type: "object",
    properties: {
      service: { type: "string" },
      direction: {
        type: "string",
        enum: ["dependencies", "dependents"],
        default: "dependencies",
      },
    },
    required: ["service"],
  },
  async (client, args) => {
    const service = asString(args.service);
    const direction = asString(args.direction) || "dependencies";
    const cypher =
      direction === "dependents"
        ? "MATCH (root:Service) WHERE toLower(root.name) CONTAINS toLower($service) " +
          "MATCH (dependent:Service)-[:DEPENDS_ON]->(root) RETURN dependent, root"
        : "MATCH (root:Service) WHERE toLower(root.name) CONTAINS toLower($service) " +
          "MATCH (root)-[:DEPENDS_ON]->(dep:Service) RETURN root, dep";
    const rows = await client.query(cypher, { service });
    if (rows.length === 0) {
      return empty("trace_dependencies", {
        summary: `'${service}' has no recorded ${direction}.`,
        cypher,
      });
    }
    let pairs: Array<[string, string]>;
    let nodes: BrainNode[];
    let summary: string;
    if (direction === "dependents") {
      pairs = rows.map((r) => [nameOf(r.dependent), nameOf(r.root)]);
      const names = [...new Set(pairs.map(([a]) => a))].sort();
      nodes = rows.map((r) => coerceNode(r.dependent)).filter((n): n is BrainNode => n !== null);
      summary = `${pairs.length} services depend on ${service}: ${names.join(", ")}.`;
    } else {
      pairs = rows.map((r) => [nameOf(r.root), nameOf(r.dep)]);
      const names = pairs.map(([, b]) => b);
      nodes = rows.map((r) => coerceNode(r.dep)).filter((n): n is BrainNode => n !== null);
      summary = `${service} depends on ${names.length} service(s): ${names.join(", ")}.`;
    }
    return empty("trace_dependencies", {
      summary,
      data: pairs.map(([from, to]) => ({ from, to })),
      cypher,
      nodes,
      row_count: rows.length,
    });
  },
);

tool(
  "impact_of_failure",
  "Blast radius: every service that transitively depends on this one, ordered by " +
    "distance. Use this for 'what breaks if X goes down'.",
  { type: "object", properties: { service: { type: "string" } }, required: ["service"] },
  async (client, args) => {
    const service = asString(args.service);
    const affected = await algorithms.dependencyImpact(client, service);
    if (affected.length === 0) {
      return empty("impact_of_failure", {
        summary: `Nothing in the graph depends on ${service}, so it is not a bottleneck.`,
      });
    }
    const byDistance = new Map<number, string[]>();
    for (const item of affected) {
      const bucket = byDistance.get(item.distance) ?? [];
      bucket.push(item.service.name);
      byDistance.set(item.distance, bucket);
    }
    const lines = [...byDistance.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([dist, names]) => `${dist} hop(s): ${[...names].sort().join(", ")}`);
    return empty("impact_of_failure", {
      summary: `If ${service} goes down, ${affected.length} service(s) are affected — ${lines.join("; ")}`,
      data: affected,
      cypher: algorithms.DEPENDENCY_IMPACT,
      nodes: affected.map((a) => a.service),
      row_count: affected.length,
    });
  },
);

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

tool(
  "get_decision_context",
  "Find architecture decisions matching a topic, with the rationale, who decided, " +
    "the services affected, and the chat messages where it was argued.",
  {
    type: "object",
    properties: {
      topic: { type: "string", description: "e.g. 'auth migration', 'database'" },
    },
    required: ["topic"],
  },
  async (client, args) => {
    const topic = asString(args.topic);
    const rows = await client.query(
      "MATCH (d:Decision) " +
        "WHERE toLower(d.title) CONTAINS toLower($topic) " +
        "   OR toLower(d.rationale) CONTAINS toLower($topic) " +
        "   OR any(t IN d.topics WHERE toLower(t) = toLower($topic)) " +
        "   OR any(t IN d.topics WHERE toLower(t) CONTAINS toLower(split($topic,' ')[0])) " +
        "OPTIONAL MATCH (d)-[:DECIDED_BY]->(p:Person) " +
        "OPTIONAL MATCH (d)-[:DISCUSSED_IN]->(m:Message) " +
        "RETURN d, p.name AS decided_by, m.channel AS channel, left(m.content, 200) AS quote " +
        "ORDER BY d.date DESC LIMIT 10",
      { topic },
    );
    if (rows.length === 0) {
      return empty("get_decision_context", {
        summary: `No decision in the graph mentions '${topic}'.`,
      });
    }
    type Entry = {
      decision: BrainNode;
      title: string;
      rationale: string;
      status: unknown;
      decided_by: unknown;
      discussion: Array<{ channel: unknown; quote: unknown }>;
    };
    const merged = new Map<string, Entry>();
    const nodes: BrainNode[] = [];
    for (const r of rows) {
      const d = coerceNode(r.d);
      if (!d) continue;
      let entry = merged.get(d.id);
      if (!entry) {
        entry = {
          decision: d,
          title: d.name,
          rationale: (d.properties.rationale as string) ?? "",
          status: d.properties.status,
          decided_by: r.decided_by,
          discussion: [],
        };
        merged.set(d.id, entry);
      }
      if (r.channel) entry.discussion.push({ channel: r.channel, quote: r.quote });
      nodes.push(d);
    }
    const results = [...merged.values()];
    if (results.length === 0) {
      return empty("get_decision_context", {
        summary: `No decision in the graph mentions '${topic}'.`,
        cypher: "MATCH (d:Decision) WHERE ... ",
      });
    }
    const lead = results[0];
    const summary =
      `${results.length} decision(s) match '${topic}'. ` +
      `"${lead.title}" (${lead.status}) decided by ${lead.decided_by ?? "unknown"}: ` +
      `${lead.rationale.slice(0, 220)}${lead.rationale.length > 220 ? "..." : ""}`;
    return empty("get_decision_context", {
      summary,
      data: results,
      cypher:
        "MATCH (d:Decision) WHERE ... OR any(t IN d.topics WHERE ...) " +
        "OPTIONAL MATCH (d)-[:DECIDED_BY]->(p:Person) " +
        "OPTIONAL MATCH (d)-[:DISCUSSED_IN]->(m:Message) RETURN ...",
      nodes,
      row_count: results.length,
    });
  },
);

tool(
  "tickets_blocked_by",
  "Tickets blocked by a decision or another ticket matching a topic. Answers " +
    "'what is stuck behind the auth migration?' across services.",
  { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
  async (client, args) => {
    const topic = asString(args.topic);
    const cypher =
      "MATCH (d:Decision) " +
      "WHERE toLower(d.title) CONTAINS toLower($topic) " +
      "   OR any(t IN d.topics WHERE toLower(t) CONTAINS toLower($topic)) " +
      "   OR toLower(d.rationale) CONTAINS toLower($topic) " +
      "MATCH (t:Ticket)-[b:BLOCKED_BY]->(d) " +
      "OPTIONAL MATCH (t)-[:RELATES_TO]->(s:Service) " +
      "OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(p:Person) " +
      "RETURN t, s, d.title AS decision " +
      "ORDER BY t.key";
    const rows = await client.query(cypher, { topic });
    if (rows.length === 0) {
      return empty("tickets_blocked_by", {
        summary: `No tickets are blocked by anything matching '${topic}'.`,
        cypher,
      });
    }
    const ticketNodes = new Map<string, BrainNode>();
    const serviceNodes = new Map<string, BrainNode>();
    const rowsOut: Array<Record<string, unknown>> = [];
    for (const r of rows) {
      const tn = coerceNode(r.t);
      if (!tn) continue;
      if (!ticketNodes.has(tn.id)) ticketNodes.set(tn.id, tn);
      const sn = coerceNode(r.s);
      let serviceName: string | null = null;
      if (sn) {
        if (!serviceNodes.has(sn.id)) serviceNodes.set(sn.id, sn);
        serviceName = sn.name;
      }
      rowsOut.push({
        key: tn.properties.key,
        title: tn.properties.title,
        status: tn.properties.status,
        priority: tn.properties.priority,
        service: serviceName,
        blocked_by_decision: r.decision,
        node_id: tn.id,
      });
    }
    if (rowsOut.length === 0) {
      return empty("tickets_blocked_by", {
        summary: `No tickets are blocked by anything matching '${topic}'.`,
        cypher,
      });
    }
    const serviceNames = [...new Set([...serviceNodes.values()].map((n) => n.name))].sort();
    const keys = rowsOut.map((r) => r.key);
    const summary =
      `${rowsOut.length} ticket(s) are blocked by '${topic}', spanning ` +
      `${serviceNames.length} service(s) (${serviceNames.join(", ")}): ` +
      keys.map((k) => String(k)).join(", ");
    return empty("tickets_blocked_by", {
      summary,
      data: rowsOut,
      cypher,
      nodes: [...ticketNodes.values(), ...serviceNodes.values()],
      row_count: rowsOut.length,
    });
  },
);

// ---------------------------------------------------------------------------
// Tickets / people
// ---------------------------------------------------------------------------

tool(
  "tickets_for_service",
  "Tickets relating to a service, most urgent first, with assignee.",
  {
    type: "object",
    properties: {
      service: { type: "string" },
      status: { type: "string", description: "optional status filter" },
    },
    required: ["service"],
  },
  async (client, args) => {
    const service = asString(args.service);
    const status = typeof args.status === "string" && args.status ? args.status : null;
    let tickets = await queries.findTicketsForService(client, service);
    if (status) {
      tickets = tickets.filter((t) => t.properties.status === status);
    }
    if (tickets.length === 0) {
      return empty("tickets_for_service", { summary: `No tickets recorded for ${service}.` });
    }
    const statuses = tickets.map((t) => t.properties.status as string | undefined);
    const openish = statuses.filter((s) => s === "blocked" || s === "in_progress" || s === "open");
    const keys = tickets.map((t) => t.properties.key);
    const summary =
      `${tickets.length} ticket(s) relate to ${service}, ${openish.length} not done. ` +
      keys
        .map((k, i) => `${k} (${statuses[i]})`)
        .slice(0, 6)
        .join(", ");
    return empty("tickets_for_service", {
      summary,
      data: tickets,
      cypher: queries.FIND_TICKETS_FOR_SERVICE,
      nodes: tickets,
      row_count: tickets.length,
    });
  },
);

tool(
  "find_people",
  "Look up people by name, with their team, role and what they author or own.",
  { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  async (client, args) => {
    const name = asString(args.name);
    const rows = await client.query(
      "MATCH (p:Person) WHERE toLower(p.name) CONTAINS toLower($name) " +
        "OPTIONAL MATCH (p)-[:MEMBER_OF]->(t:Team) " +
        "OPTIONAL MATCH (p)-[:AUTHORED]->(a:Decision) " +
        "OPTIONAL MATCH (p)-[:KNOWS_ABOUT]->(s:Service) " +
        "RETURN p, t.name AS team, collect(DISTINCT a.title) AS decisions, " +
        "collect(DISTINCT s.name) AS services",
      { name },
    );
    if (rows.length === 0) {
      return empty("find_people", { summary: `No person matching '${name}'.` });
    }
    const people: Array<Record<string, unknown>> = [];
    const nodes: BrainNode[] = [];
    for (const r of rows) {
      const p = coerceNode(r.p);
      if (!p) continue;
      people.push({
        person: p.name,
        role: p.properties.role,
        team: r.team,
        decisions: r.decisions,
        services: r.services,
      });
      nodes.push(p);
    }
    const detail = people
      .slice(0, 4)
      .map((x) => `${x.person} (${x.role}, ${x.team}) knows ${(x.services as unknown[]).length} service(s)`)
      .join("; ");
    return empty("find_people", {
      summary: `${people.length} match for '${name}': ${detail}`,
      data: people,
      nodes,
      row_count: people.length,
    });
  },
);

// ---------------------------------------------------------------------------
// Algorithms
// ---------------------------------------------------------------------------

tool(
  "shortest_path",
  "Shortest dependency path between two services, hop by hop.",
  {
    type: "object",
    properties: { from_service: { type: "string" }, to_service: { type: "string" } },
    required: ["from_service", "to_service"],
  },
  async (client, args) => {
    const from = asString(args.from_service);
    const to = asString(args.to_service);
    const path = await algorithms.shortestPathBetweenServices(client, from, to);
    if (!path) {
      return empty("shortest_path", {
        summary: `No dependency path between ${from} and ${to} within 6 hops.`,
      });
    }
    const names = path.nodes.map((n) => n.name);
    return empty("shortest_path", {
      summary: `Shortest path (${path.length} hops): ${names.join(" -> ")}`,
      data: path,
      cypher: algorithms.SHORTEST_SERVICE_PATH,
      nodes: path.nodes,
      row_count: path.length,
    });
  },
);

tool(
  "pagerank",
  "Most central nodes in the whole graph by PageRank (FalkorDB's native algo.pageRank).",
  { type: "object", properties: { limit: { type: "integer", default: 8 } } },
  async (client, args) => {
    const limit = asNumber(args.limit, 8);
    const ranked = await algorithms.pagerank(client, limit);
    if (ranked.length === 0) {
      return empty("pagerank", { summary: "PageRank returned nothing." });
    }
    const named = ranked.map((r) => `${r.node.name} (${round(r.score, 4)})`);
    return empty("pagerank", {
      summary: `Most connected/central nodes: ${named.join(", ")}`,
      data: ranked,
      cypher: algorithms.ALGO_PAGERANK,
      nodes: ranked.map((r) => r.node),
      row_count: ranked.length,
    });
  },
);

tool(
  "bridge_services",
  "Services that sit on many dependency paths — the bottlenecks that would hurt most.",
  { type: "object", properties: { limit: { type: "integer", default: 5 } } },
  async (client, args) => {
    const limit = asNumber(args.limit, 5);
    const ranked = await algorithms.bridgeServices(client, limit);
    if (ranked.length === 0) {
      return empty("bridge_services", { summary: "No bottleneck services found." });
    }
    const named = ranked.map((r) => `${r.service.name} (score ${r.bridge_score})`);
    return empty("bridge_services", {
      summary: `Bottleneck services: ${named.join(", ")}`,
      data: ranked,
      cypher: algorithms.BRIDGE_FINDER,
      nodes: ranked.map((r) => r.service),
      row_count: ranked.length,
    });
  },
);

tool(
  "find_bottlenecks",
  "Betweenness centrality: the services that sit on the most shortest paths " +
    "between other services. These are the highest-leverage places to fix. " +
    "Uses FalkorDB's native algo.betweenness.",
  { type: "object", properties: { limit: { type: "integer", default: 5 } } },
  async (client, args) => {
    const limit = asNumber(args.limit, 5);
    const ranked = await algorithms.betweennessCentrality(client, limit);
    if (ranked.length === 0) {
      return empty("find_bottlenecks", { summary: "No bottleneck services found." });
    }
    const named = ranked.map((r) => `${r.node.name} (${round(r.score, 2)})`);
    const approx = ranked[0].approx ?? false;
    const note = approx ? " (approximated by path counting)" : "";
    return empty("find_bottlenecks", {
      summary:
        `Highest betweenness services — most paths run through them${note}: ` + named.join(", "),
      data: ranked,
      cypher: approx ? algorithms.BRIDGE_FINDER : algorithms.BETWEENNESS_SERVICES,
      nodes: ranked.map((r) => r.node),
      row_count: ranked.length,
    });
  },
);

tool(
  "central_services",
  "Harmonic centrality: services closest on average to every other service. " +
    "Unlike degree it is not dominated by how many edges a service has.",
  { type: "object", properties: { limit: { type: "integer", default: 5 } } },
  async (client, args) => {
    const limit = asNumber(args.limit, 5);
    const ranked = await algorithms.harmonicCentrality(client, limit);
    if (ranked.length === 0) {
      return empty("central_services", { summary: "Harmonic centrality returned nothing." });
    }
    const named = ranked.map((r) => `${r.node.name} (${round(r.score, 2)})`);
    return empty("central_services", {
      summary: `Most central services by harmonic centrality: ${named.join(", ")}`,
      data: ranked,
      cypher: algorithms.HARMONIC_CENTRALITY,
      nodes: ranked.map((r) => r.node),
      row_count: ranked.length,
    });
  },
);

tool(
  "team_clusters",
  "Community detection over the whole graph (label propagation), grouped by " +
    "owning team. Shows how the org clusters around its services and people.",
  { type: "object", properties: {} },
  async (client) => {
    const groups = await algorithms.communities(client);
    if (groups.length === 0) {
      return empty("team_clusters", { summary: "No communities detected." });
    }
    const top = groups.slice(0, 6);
    const summary =
      "Graph clusters by owning team: " +
      top.map((g) => `${g.community} (${g.size} nodes)`).join("; ");
    const nodes: BrainNode[] = [];
    for (const g of top) {
      for (const m of g.members) {
        nodes.push({
          id: m.id,
          labels: [],
          label: "Node",
          name: m.name,
          properties: { name: m.name },
        });
      }
    }
    return empty("team_clusters", {
      summary,
      data: top,
      cypher: algorithms.COMMUNITIES,
      nodes,
      row_count: top.length,
    });
  },
);

tool(
  "graph_context",
  "Neighbourhood of a node up to `depth` hops — everything connected to it.",
  {
    type: "object",
    properties: {
      node_id: { type: "string", description: "e.g. 'service:auth' or 'ticket:MER-1001'" },
      depth: { type: "integer", default: 2, maximum: 3 },
    },
    required: ["node_id"],
  },
  async (client, args) => {
    const nodeId = asString(args.node_id);
    const depth = asNumber(args.depth, 2);
    const sub = await queries.subgraphAround(client, nodeId, depth);
    return empty("graph_context", {
      summary: `${sub.nodes.length} nodes and ${sub.edges.length} edges within ${depth} hop(s) of ${nodeId}.`,
      data: sub,
      cypher: queries.SUBGRAPH_AROUND.replace("%d", String(depth)),
      nodes: sub.nodes,
      edges: sub.edges,
      row_count: sub.nodes.length,
    });
  },
);

tool(
  "run_cypher",
  "Run a read-only Cypher query against the graph. Use when no other tool fits. " +
    "Writes are rejected.",
  {
    type: "object",
    properties: {
      cypher: { type: "string" },
      params: { type: "object", description: "optional query parameters" },
    },
    required: ["cypher"],
  },
  async (client, args) => {
    const cypher = asString(args.cypher);
    const params = (args.params as Record<string, unknown>) ?? {};
    const out = await queries.runCustomQuery(client, cypher, params);
    return empty("run_cypher", {
      summary: `Custom query returned ${out.rows.length} row(s), touching ${out.subgraph.nodes.length} node(s).`,
      data: out.rows.slice(0, 50),
      cypher,
      nodes: out.subgraph.nodes,
      edges: out.subgraph.edges,
      row_count: out.rows.length,
    });
  },
);

// ---------------------------------------------------------------------------
// Actions — the agent acting on what the graph shows (Track 1)
//
// Reads answer questions; these change the graph. Every write is a MERGE keyed
// on a stable business id, links to the existing nodes it touches, and reports
// the created ids — so the action itself is traceable and re-runnable.
// ---------------------------------------------------------------------------

/** Resolve a service name/alias to its node id, or null. */
async function resolveServiceId(client: FalkorClient, name: string): Promise<string | null> {
  if (!name) return null;
  const rows = await client.query<{ id: string }>(
    `MATCH (s:Service) ${queries.serviceMatch("s", "service")} RETURN s.id AS id LIMIT 1`,
    { service: name },
  );
  return rows[0]?.id ?? null;
}

/** Resolve a person name to its node id, or null. */
async function resolvePersonId(client: FalkorClient, name: string): Promise<string | null> {
  if (!name) return null;
  const rows = await client.query<{ id: string }>(
    "MATCH (p:Person) WHERE toLower(p.name) CONTAINS toLower($name) RETURN p.id AS id LIMIT 1",
    { name },
  );
  return rows[0]?.id ?? null;
}

/**
 * Resolve free text to an existing node (exact name/key/title match, any
 * label), so open-ended facts link to the real graph instead of duplicating it.
 */
async function resolveAnyNode(client: FalkorClient, name: string): Promise<string | null> {
  if (!name) return null;
  const rows = await client.query<{ id: string }>(
    "MATCH (n) WHERE toLower(coalesce(n.name, '')) = toLower($name) " +
      "   OR toLower(coalesce(n.key, '')) = toLower($name) " +
      "   OR toLower(coalesce(n.title, '')) = toLower($name) " +
      "RETURN n.id AS id LIMIT 1",
    { name },
  );
  return rows[0]?.id ?? null;
}

/** Next free ticket key (MER-1031 after MER-1001…MER-1030). */
async function nextTicketKey(client: FalkorClient): Promise<string> {
  const rows = await client.query<{ key: string }>("MATCH (t:Ticket) RETURN t.key AS key");
  let max = 1000;
  for (const r of rows) {
    const m = /^MER-(\d+)$/.exec(r.key ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `MER-${max + 1}`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function slug(text: string, maxLen = 40): string {
  return (
    (text ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, maxLen) || "item"
  );
}

/** Re-read nodes by business id for a well-shaped tool result. */
async function fetchNodes(client: FalkorClient, ids: string[]): Promise<BrainNode[]> {
  if (ids.length === 0) return [];
  return client.nodes("MATCH (n) WHERE n.id IN $ids RETURN n", { ids });
}

tool(
  "create_ticket",
  "File a ticket in the graph: creates a Ticket node (next free MER- key, " +
    "status open) linked to its service and assignee. Use when the user asks " +
    "to file, log or raise work — or when the graph shows something that " +
    "needs doing and the user wants action, not just an answer.",
  {
    type: "object",
    properties: {
      title: { type: "string", description: "Short ticket title" },
      service: { type: "string", description: "Service name the work belongs to" },
      priority: { type: "string", enum: ["p0", "p1", "p2", "p3"], default: "p2" },
      assignee: { type: "string", description: "Person name to assign to" },
      description: { type: "string", description: "Longer description" },
    },
    required: ["title"],
  },
  async (client, args) => {
    const title = asString(args.title).slice(0, 200);
    if (!title) {
      return { ...empty("create_ticket"), ok: false, summary: "create_ticket needs a title." };
    }
    const priority = ["p0", "p1", "p2", "p3"].includes(asString(args.priority))
      ? asString(args.priority)
      : "p2";
    const key = await nextTicketKey(client);
    const id = `ticket:${key}`;
    const notes: string[] = [];

    await client.write(
      "CREATE (t:Ticket {id: $id, key: $key, title: $title, status: 'open', " +
        "priority: $priority, opened: $opened, description: $description})",
      { id, key, title, priority, opened: today(), description: asString(args.description) },
    );

    const serviceName = asString(args.service);
    let serviceId: string | null = null;
    if (serviceName) {
      serviceId = await resolveServiceId(client, serviceName);
      if (serviceId) {
        await client.write(
          "MATCH (t:Ticket {id: $tid}), (s:Service {id: $sid}) MERGE (t)-[:RELATES_TO]->(s)",
          { tid: id, sid: serviceId },
        );
        // Inherit the repo, like the seeder does for existing tickets.
        await client.write(
          "MATCH (t:Ticket {id: $tid}), (s:Service {id: $sid})-[:IN_REPO]->(r:Repo) " +
            "MERGE (t)-[:IN_REPO]->(r)",
          { tid: id, sid: serviceId },
        );
      } else {
        notes.push(`service '${serviceName}' not found — ticket filed unlinked`);
      }
    }

    const assigneeName = asString(args.assignee);
    let assigneeId: string | null = null;
    if (assigneeName) {
      assigneeId = await resolvePersonId(client, assigneeName);
      if (assigneeId) {
        await client.write(
          "MATCH (t:Ticket {id: $tid}), (p:Person {id: $pid}) MERGE (t)-[:ASSIGNED_TO]->(p)",
          { tid: id, pid: assigneeId },
        );
      } else {
        notes.push(`person '${assigneeName}' not found — ticket filed unassigned`);
      }
    }

    const nodes = await fetchNodes(
      client,
      [id, ...(serviceId ? [serviceId] : []), ...(assigneeId ? [assigneeId] : [])],
    );
    let summary = `Filed ${key} ("${title}", ${priority}, open)`;
    if (serviceId) summary += ` for ${serviceName}`;
    if (assigneeId) summary += `, assigned to ${assigneeName}`;
    summary += ".";
    if (notes.length > 0) summary += ` Note: ${notes.join("; ")}.`;
    return empty("create_ticket", {
      summary,
      data: { key, node_id: id, service_id: serviceId, assignee_id: assigneeId },
      cypher: "CREATE (t:Ticket {...}) MERGE (t)-[:RELATES_TO]->(s) MERGE (t)-[:ASSIGNED_TO]->(p)",
      nodes,
      row_count: 1,
    });
  },
);

tool(
  "update_ticket",
  "Change a ticket: status, priority and/or assignee. Accepts a bare key " +
    "('MER-1002') or a full id. Use to close, reopen, reprioritise or reassign work.",
  {
    type: "object",
    properties: {
      key: { type: "string", description: "Ticket key, e.g. 'MER-1002'" },
      status: { type: "string", enum: ["open", "in_progress", "blocked", "done"] },
      priority: { type: "string", enum: ["p0", "p1", "p2", "p3"] },
      assignee: { type: "string", description: "Person name to assign to" },
    },
    required: ["key"],
  },
  async (client, args) => {
    const rawKey = asString(args.key);
    const key = (/^MER-\d+$/.exec(rawKey) ? rawKey : /^ticket:(MER-\d+)$/.exec(rawKey)?.[1]) ?? "";
    if (!key) {
      return { ...empty("update_ticket"), ok: false, summary: `No ticket key in '${rawKey}'.` };
    }
    const id = `ticket:${key}`;
    const existing = await fetchNodes(client, [id]);
    if (existing.length === 0) {
      return { ...empty("update_ticket"), ok: false, summary: `No ticket with key '${key}'.` };
    }

    const changes: string[] = [];
    const sets: string[] = [];
    const params: Record<string, unknown> = { tid: id };
    const status = asString(args.status);
    if (["open", "in_progress", "blocked", "done"].includes(status)) {
      sets.push("t.status = $status");
      params.status = status;
      changes.push(`status → ${status}`);
    }
    const priority = asString(args.priority);
    if (["p0", "p1", "p2", "p3"].includes(priority)) {
      sets.push("t.priority = $priority");
      params.priority = priority;
      changes.push(`priority → ${priority}`);
    }
    const assigneeName = asString(args.assignee);
    let assigneeId: string | null = null;
    if (assigneeName) {
      assigneeId = await resolvePersonId(client, assigneeName);
      if (!assigneeId) {
        return { ...empty("update_ticket"), ok: false, summary: `No person matching '${assigneeName}'.` };
      }
      await client.write(
        "MATCH (t:Ticket {id: $tid})-[r:ASSIGNED_TO]->() DELETE r",
        { tid: id },
      );
      await client.write(
        "MATCH (t:Ticket {id: $tid}), (p:Person {id: $pid}) MERGE (t)-[:ASSIGNED_TO]->(p)",
        { tid: id, pid: assigneeId },
      );
      changes.push(`assignee → ${assigneeName}`);
    }
    if (changes.length === 0) {
      return {
        ...empty("update_ticket"),
        ok: false,
        summary: "Nothing to change — pass status, priority and/or assignee.",
      };
    }
    if (sets.length > 0) {
      await client.write(`MATCH (t:Ticket {id: $tid}) SET ${sets.join(", ")}`, params);
    }
    const nodes = await fetchNodes(client, [id, ...(assigneeId ? [assigneeId] : [])]);
    return empty("update_ticket", {
      summary: `Updated ${key}: ${changes.join(", ")}.`,
      data: { key, node_id: id, changes },
      cypher: "MATCH (t:Ticket {id}) SET ... / MERGE (t)-[:ASSIGNED_TO]->(p)",
      nodes,
      row_count: 1,
    });
  },
);

tool(
  "record_decision",
  "Record an architecture decision in the graph: creates a Decision node with " +
    "rationale, topics and links to the decider and affected services. Use " +
    "when the user states what was decided and why — this is how the graph's " +
    "knowledge stays current instead of going stale.",
  {
    type: "object",
    properties: {
      title: { type: "string", description: "Decision title" },
      rationale: { type: "string", description: "Why this was decided" },
      decided_by: { type: "string", description: "Person name who decided" },
      topics: { type: "array", description: "Topic tags, e.g. ['auth', 'tokens']" },
      services: { type: "array", description: "Affected service names" },
      status: { type: "string", enum: ["accepted", "proposed", "deprecated"], default: "accepted" },
    },
    required: ["title", "rationale"],
  },
  async (client, args) => {
    const title = asString(args.title).slice(0, 200);
    const rationale = asString(args.rationale).slice(0, 2000);
    if (!title || !rationale) {
      return { ...empty("record_decision"), ok: false, summary: "record_decision needs a title and a rationale." };
    }
    const status = ["accepted", "proposed", "deprecated"].includes(asString(args.status))
      ? asString(args.status)
      : "accepted";
    const topics = Array.isArray(args.topics)
      ? (args.topics as unknown[]).filter((t): t is string => typeof t === "string").slice(0, 12)
      : [];
    const id = `decision:${slug(title)}`;
    const notes: string[] = [];

    await client.write(
      "MERGE (d:Decision {id: $id}) " +
        "SET d.title = $title, d.rationale = $rationale, d.status = $status, " +
        "    d.topics = $topics, d.date = $date",
      { id, title, rationale, status, topics, date: today() },
    );

    const deciderName = asString(args.decided_by);
    let deciderId: string | null = null;
    if (deciderName) {
      deciderId = await resolvePersonId(client, deciderName);
      if (deciderId) {
        await client.write(
          "MATCH (d:Decision {id: $did}), (p:Person {id: $pid}) " +
            "MERGE (d)-[:DECIDED_BY]->(p) MERGE (p)-[:AUTHORED]->(d)",
          { did: id, pid: deciderId },
        );
      } else {
        notes.push(`person '${deciderName}' not found — decision recorded without decider`);
      }
    }

    const serviceNames = Array.isArray(args.services)
      ? (args.services as unknown[]).filter((s): s is string => typeof s === "string")
      : [];
    const linkedServices: string[] = [];
    for (const name of serviceNames.slice(0, 8)) {
      const sid = await resolveServiceId(client, name);
      if (sid) {
        await client.write(
          "MATCH (d:Decision {id: $did}), (s:Service {id: $sid}) MERGE (d)-[:RELATES_TO]->(s)",
          { did: id, sid },
        );
        linkedServices.push(sid);
      } else {
        notes.push(`service '${name}' not found — skipped`);
      }
    }

    const nodes = await fetchNodes(client, [id, ...(deciderId ? [deciderId] : []), ...linkedServices]);
    let summary = `Recorded decision "${title}" (${status})`;
    if (deciderId) summary += `, decided by ${deciderName}`;
    if (linkedServices.length > 0) summary += `, affecting ${linkedServices.length} service(s)`;
    summary += ".";
    if (notes.length > 0) summary += ` Note: ${notes.join("; ")}.`;
    return empty("record_decision", {
      summary,
      data: { node_id: id, services: linkedServices, decided_by: deciderId },
      cypher: "MERGE (d:Decision {id}) SET ... MERGE (d)-[:DECIDED_BY]->(p) MERGE (d)-[:RELATES_TO]->(s)",
      nodes,
      row_count: 1,
    });
  },
);

tool(
  "note_knowledge",
  "Record who knows a service and how well — the 'keeping knowledge current' " +
    "write behind 'who knows X'. Creates or updates the KNOWS_ABOUT edge.",
  {
    type: "object",
    properties: {
      person: { type: "string", description: "Person name" },
      service: { type: "string", description: "Service name" },
      level: { type: "string", enum: ["expert", "familiar"], default: "familiar" },
    },
    required: ["person", "service"],
  },
  async (client, args) => {
    const person = asString(args.person);
    const service = asString(args.service);
    const level = asString(args.level) === "expert" ? "expert" : "familiar";
    const pid = await resolvePersonId(client, person);
    const sid = await resolveServiceId(client, service);
    if (!pid || !sid) {
      const missing: string[] = [];
      if (!pid) missing.push(`'${person}' (person)`);
      if (!sid) missing.push(`'${service}' (service)`);
      return { ...empty("note_knowledge"), ok: false, summary: `Could not resolve ${missing.join(" and ")}.` };
    }
    await client.write(
      "MATCH (p:Person {id: $pid}), (s:Service {id: $sid}) " +
        "MERGE (p)-[k:KNOWS_ABOUT]->(s) SET k.level = $level",
      { pid, sid, level },
    );
    const nodes = await fetchNodes(client, [pid, sid]);
    return empty("note_knowledge", {
      summary: `Noted: ${person} knows ${service} (${level}).`,
      data: { person_id: pid, service_id: sid, level },
      cypher: "MERGE (p:Person)-[k:KNOWS_ABOUT]->(s:Service) SET k.level",
      nodes,
      row_count: 1,
    });
  },
);

tool(
  "remember_fact",
  "Map anything: store an open-ended fact as a real relationship between two " +
    "nodes (subject —predicate→ object), linking to existing nodes by name " +
    "when they exist and creating lightweight Concept nodes when they don't. " +
    "Use for knowledge that fits no other tool — migrations, ownership, " +
    "dependencies between arbitrary things. Read it back with run_cypher.",
  {
    type: "object",
    properties: {
      subject: { type: "string", description: "The thing the fact is about" },
      predicate: { type: "string", description: "How they relate, e.g. 'depends on', 'owns'" },
      object: { type: "string", description: "The other end of the relationship" },
      detail: { type: "string", description: "Optional extra context stored on the edge" },
    },
    required: ["subject", "predicate", "object"],
  },
  async (client, args) => {
    const subject = asString(args.subject).slice(0, 120);
    const predicate = asString(args.predicate).slice(0, 60);
    const object = asString(args.object).slice(0, 120);
    if (!subject || !predicate || !object) {
      return {
        ...empty("remember_fact"),
        ok: false,
        summary: "remember_fact needs a subject, a predicate and an object.",
      };
    }
    const rel =
      predicate
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 30) || "RELATED_TO";

    // Existence check first: the same relationship between same-named nodes is
    // reported, not duplicated (MERGE would already dedup the exact edge, but
    // the answer should say it knew rather than pretend it learned).
    const known = await client.query<{ src: string; dst: string }>(
      `MATCH (a)-[r:${rel}]->(b) ` +
        "WHERE (toLower(coalesce(a.name, '')) = toLower($s) " +
        "   OR toLower(coalesce(a.key, '')) = toLower($s) " +
        "   OR toLower(coalesce(a.title, '')) = toLower($s)) " +
        "  AND (toLower(coalesce(b.name, '')) = toLower($o) " +
        "   OR toLower(coalesce(b.key, '')) = toLower($o) " +
        "   OR toLower(coalesce(b.title, '')) = toLower($o)) " +
        "RETURN a.id AS src, b.id AS dst LIMIT 1",
      { s: subject, o: object },
    );
    if (known.length > 0) {
      const nodes = await fetchNodes(client, [known[0].src, known[0].dst]);
      return empty("remember_fact", {
        summary: `Already known: ${subject} —${rel}→ ${object}. Nothing new stored.`,
        data: { subject_id: known[0].src, object_id: known[0].dst, relationship: rel, duplicate: true },
        cypher: `MATCH (a)-[:${rel}]->(b)`,
        nodes,
        row_count: 1,
      });
    }

    const ensureNode = async (name: string): Promise<{ id: string; created: boolean }> => {
      const existing = await resolveAnyNode(client, name);
      if (existing) return { id: existing, created: false };
      const id = `concept:${slug(name, 60)}`;
      await client.write("MERGE (c:Concept {id: $id}) SET c.name = $name", { id, name });
      return { id, created: true };
    };
    const src = await ensureNode(subject);
    const dst = await ensureNode(object);
    await client.write(
      `MATCH (a {id: $src}), (b {id: $dst}) MERGE (a)-[r:${rel}]->(b) ` +
        "SET r.detail = $detail, r.source = 'remember_fact', r.timestamp = $ts",
      { src: src.id, dst: dst.id, detail: asString(args.detail), ts: new Date().toISOString() },
    );
    const nodes = await fetchNodes(client, [src.id, dst.id]);
    const created = [src.created ? subject : null, dst.created ? object : null].filter(Boolean);
    let summary = `Noted: ${subject} —${rel}→ ${object}.`;
    if (created.length > 0) summary += ` Mapped as new concept(s): ${created.join(", ")}.`;
    return empty("remember_fact", {
      summary,
      data: { subject_id: src.id, object_id: dst.id, relationship: rel },
      cypher: `MERGE (a)-[:${rel}]->(b)`,
      nodes,
      row_count: 1,
    });
  },
);

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Payload handed back to the model as a tool result message. */
export function compact(result: ToolResult): string {  return JSON.stringify(
    {
      tool: result.tool,
      summary: result.summary,
      row_count: result.row_count,
      data: result.data ?? null,
      error: result.error ?? null,
    },
    (_key, value) => (typeof value === "bigint" ? String(value) : value),
  ).slice(0, 8000);
}

/** Tool definitions in Anthropic tool-use shape. */
export function toolSpecs(): Array<{ name: string; description: string; input_schema: InputSchema }> {
  return [...REGISTRY.values()].map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

/**
 * Dispatch a tool call, capturing duration and turning errors into results.
 *
 * A failing tool must not kill the agent — it returns an error result so the
 * model can retry with different arguments, and the failure still shows up in
 * the reasoning trace.
 */
export async function execute(
  name: string,
  client: FalkorClient,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const entry = REGISTRY.get(name);
  if (!entry) {
    return {
      tool: name,
      ok: false,
      error: `unknown tool '${name}'`,
      summary: `Unknown tool '${name}'.`,
      nodes: [],
      edges: [],
      row_count: 0,
    };
  }
  const start = Date.now();
  let result: ToolResult;
  // Required arguments are checked up front so a model that omits one gets a clear, fixable error.
  const missing = (entry.input_schema.required ?? []).filter((k) => {
    const v = args?.[k];
    return v === undefined || v === null || (typeof v === "string" && !v.trim());
  });
  if (missing.length) {
    return {
      ...empty(name),
      ok: false,
      error: `missing required argument(s): ${missing.join(", ")}`,
      summary: `${name} needs: ${missing.join(", ")}.`,
    };
  }
  try {
    result = await entry.executor(client, args);
  } catch (err) {
    if (err instanceof GraphError) {
      result = { ...empty(name), ok: false, error: err.message, summary: `${name} failed: ${err.message}` };
    } else if (err instanceof TypeError) {
      result = {
        ...empty(name),
        ok: false,
        error: err.message,
        summary: `${name} called with bad arguments: ${err.message}`,
      };
    } else {
      throw err;
    }
  }
  result.duration_ms = Math.round((Date.now() - start) * 100) / 100;
  result.tool = result.tool || name;
  if (!result.summary) result.summary = `${name} returned ${result.row_count} row(s).`;
  return result;
}
