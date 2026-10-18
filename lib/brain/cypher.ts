/**
 * Reusable Cypher query library for the Company Brain.
 *
 * Every function runs a named query and returns plain objects, so results are
 * safe to serialise into reasoning traces. The Cypher is kept verbatim from the
 * original backend — these queries are a deliverable in their own right.
 */
import { GraphError, coerceNode, collectSubgraph, nodeToDict, type FalkorClient } from "./graph";
import type { BrainNode, SubGraph } from "./types";

export const FIND_PERSON_BY_NAME = `
MATCH (p:Person)
WHERE toLower(p.name) CONTAINS toLower($name)
OPTIONAL MATCH (p)-[:MEMBER_OF]->(t:Team)
RETURN p, t.name AS team
`;

/**
 * WHERE clause that resolves a service by name, id or alias.
 * Users say "notifications"; the node is "notification-service".
 */
export function serviceMatch(v = "s", param = "service"): string {
  return `WHERE toLower(${v}.name) CONTAINS toLower($${param})
   OR toLower(${v}.id) CONTAINS toLower($${param})
   OR any(a IN coalesce(${v}.aliases, []) WHERE toLower(a) CONTAINS toLower($${param}))`;
}

export const SERVICE_MATCH = serviceMatch();

export const FIND_EXPERTS_ON_SERVICE = `
MATCH (s:Service)
${SERVICE_MATCH}
OPTIONAL MATCH (p:Person)-[k:KNOWS_ABOUT]->(s)
OPTIONAL MATCH (p)-[:MEMBER_OF]->(t:Team)
RETURN p, k.level AS level, t.name AS team, s
ORDER BY CASE k.level WHEN 'expert' THEN 0 ELSE 1 END
`;

export const FIND_TICKETS_FOR_SERVICE = `
MATCH (s:Service)
${SERVICE_MATCH}
OPTIONAL MATCH (t:Ticket)-[:RELATES_TO]->(s)
OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(assignee:Person)
RETURN t, assignee.name AS assignee, s
ORDER BY CASE t.status WHEN 'blocked' THEN 0 WHEN 'open' THEN 1 WHEN 'in_progress' THEN 2 ELSE 3 END
`;

export const FIND_DECISION_RATIONALE = `
MATCH (d:Decision)
WHERE toLower(d.title) CONTAINS toLower($topic)
   OR toLower(d.rationale) CONTAINS toLower($topic)
   OR any(t IN coalesce(d.topics, []) WHERE toLower(t) CONTAINS toLower($topic))
OPTIONAL MATCH (d)-[:DECIDED_BY]->(p:Person)
OPTIONAL MATCH (d)-[:RELATES_TO]->(s:Service)
RETURN d, p.name AS decided_by, collect(DISTINCT s.name) AS services
`;

export const SHORTEST_PATH_BETWEEN = `
MATCH (a {id: $from_id}), (b {id: $to_id})
WITH a, b, shortestPath((a)-[*..6]->(b)) AS path
RETURN path
`;

/** `%d` is substituted with a validated depth. */
export const MULTI_HOP_CONTEXT = `
MATCH (n {id: $node_id})
MATCH path = (n)-[*1..%d]-(m)
WITH path, nodes(path) AS ns, relationships(path) AS rs
UNWIND ns AS node
UNWIND rs AS rel
RETURN DISTINCT node, rel
LIMIT $limit
`;

export const SUBGRAPH_AROUND = `
MATCH (n {id: $node_id})
OPTIONAL MATCH path = (n)-[*1..%d]-(m)
WITH n, path
WITH collect(n) + collect(nodes(path)) AS nodeLists, collect(relationships(path)) AS relLists
UNWIND nodeLists AS nodeList
UNWIND nodeList AS node
WITH collect(DISTINCT node) AS nodes, relLists
UNWIND relLists AS relList
UNWIND relList AS rel
RETURN nodes, collect(DISTINCT rel) AS rels
`;

export const SCHEMA_COUNTS = `
MATCH (n)
RETURN head(labels(n)) AS label, count(*) AS count
ORDER BY label
`;

export const EDGE_COUNTS = `
MATCH ()-[r]->()
RETURN type(r) AS type, count(*) AS count
ORDER BY type
`;

export type ExpertHit = {
  person: BrainNode;
  level: string | null;
  team: string | null;
  service: BrainNode | null;
};

export type TicketHit = BrainNode & { assignee: string | null };
export type DecisionHit = BrainNode & {
  decided_by: string | null;
  services: string[];
  service: string | null;
};

export async function findPersonByName(
  client: FalkorClient,
  name: string,
): Promise<Array<BrainNode & { team: string | null }>> {
  const rows = await client.query(FIND_PERSON_BY_NAME, { name });
  const out: Array<BrainNode & { team: string | null }> = [];
  for (const row of rows) {
    const person = coerceNode(row.p);
    if (!person) continue;
    out.push({ ...person, team: (row.team as string) ?? null });
  }
  return out;
}

export async function findExpertsOnService(
  client: FalkorClient,
  service: string,
): Promise<ExpertHit[]> {
  const rows = await client.query(FIND_EXPERTS_ON_SERVICE, { service });
  const out: ExpertHit[] = [];
  for (const row of rows) {
    const person = coerceNode(row.p);
    if (!person) continue;
    out.push({
      person,
      level: (row.level as string) ?? null,
      team: (row.team as string) ?? null,
      service: coerceNode(row.s),
    });
  }
  return out;
}

export async function findTicketsForService(
  client: FalkorClient,
  service: string,
): Promise<TicketHit[]> {
  const rows = await client.query(FIND_TICKETS_FOR_SERVICE, { service });
  const out: TicketHit[] = [];
  for (const row of rows) {
    const ticket = coerceNode(row.t);
    if (!ticket) continue;
    out.push({ ...ticket, assignee: (row.assignee as string) ?? null });
  }
  return out;
}

export async function findDecisionRationale(
  client: FalkorClient,
  topic: string,
): Promise<DecisionHit[]> {
  const rows = await client.query(FIND_DECISION_RATIONALE, { topic });
  const out: DecisionHit[] = [];
  for (const row of rows) {
    const decision = coerceNode(row.d);
    if (!decision) continue;
    const services = ((row.services as unknown[]) ?? []).filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    out.push({
      ...decision,
      decided_by: (row.decided_by as string) ?? null,
      services,
      service: services[0] ?? null,
    });
  }
  return out;
}

/** Raw path value from the driver, or null when no path exists. */
export async function shortestPathBetween(
  client: FalkorClient,
  fromId: string,
  toId: string,
): Promise<unknown | null> {
  // FalkorDB supports only directed shortestPath: try both directions and keep the shorter.
  const forward = (await client.query(SHORTEST_PATH_BETWEEN, { from_id: fromId, to_id: toId }))[0]?.path;
  const backward = (await client.query(SHORTEST_PATH_BETWEEN, { from_id: toId, to_id: fromId }))[0]?.path;
  const len = (p: unknown) => ((p as { edges?: unknown[] } | null)?.edges?.length ?? Infinity);
  const best = len(forward) <= len(backward) ? forward : backward;
  return best ?? null;
}

/** Subgraph of everything within `depth` hops of a node (de-duplicated). */
export async function multiHopContext(
  client: FalkorClient,
  nodeId: string,
  depth = 2,
  limit = 50,
): Promise<SubGraph> {
  const safeDepth = Math.max(1, Math.min(depth, 4));
  const cypher = MULTI_HOP_CONTEXT.replace("%d", String(safeDepth));
  const rows = await client.query(cypher, { node_id: nodeId, limit });
  return collectSubgraph(rows);
}

/** Frontend-facing neighbourhood for visualisation. */
export async function subgraphAround(
  client: FalkorClient,
  nodeId: string,
  depth = 2,
): Promise<SubGraph> {
  const safeDepth = Math.max(1, Math.min(depth, 3));
  const cypher = SUBGRAPH_AROUND.replace("%d", String(safeDepth));
  const rows = await client.query(cypher, { node_id: nodeId });
  if (rows.length === 0) return { nodes: [], edges: [] };
  return collectSubgraph(rows);
}

export type SchemaSummary = {
  node_counts: Record<string, number>;
  edge_counts: Record<string, number>;
};

export async function schemaSummary(client: FalkorClient): Promise<SchemaSummary> {
  const nodeRows = await client.query<{ label: string; count: number }>(SCHEMA_COUNTS);
  const edgeRows = await client.query<{ type: string; count: number }>(EDGE_COUNTS);
  return {
    node_counts: Object.fromEntries(nodeRows.map((r) => [r.label, Number(r.count)])),
    edge_counts: Object.fromEntries(edgeRows.map((r) => [r.type, Number(r.count)])),
  };
}

const BANNED = ["CREATE", "MERGE", "SET ", "DELETE", "DETACH", "REMOVE", "DROP", "CALL DB"];

/**
 * Read-only escape hatch for advanced users / text-to-Cypher.
 * Writes are blocked: the agent must use purpose-built tools so every mutation
 * stays structured and auditable.
 */
export async function runCustomQuery(
  client: FalkorClient,
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<{ rows: unknown[][]; subgraph: SubGraph }> {
  const upper = cypher.toUpperCase();
  if (BANNED.some((token) => upper.includes(token))) {
    throw new GraphError("Only read-only queries are allowed via runCustomQuery");
  }
  const rows = await client.query(cypher, params);
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  return {
    rows: rows.map((row) => headers.map((h) => jsonish(row[h]))),
    subgraph: collectSubgraph(rows),
  };
}

function jsonish(value: unknown): unknown {
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.labels) && v.properties) {
      const d = nodeToDict(value as never);
      return { id: d.id, labels: d.labels, properties: d.properties };
    }
    if (typeof v.relationshipType === "string") {
      return { type: v.relationshipType, properties: v.properties ?? {} };
    }
    if (Array.isArray(value)) return value.map(jsonish);
    return value;
  }
  return value;
}
