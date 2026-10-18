/**
 * Graph algorithms exposed as first-class agent tools (Track 1).
 *
 *   shortest_path       native Cypher shortestPath
 *   pagerank            FalkorDB's algo.pageRank, with degree-centrality fallback
 *   dependency_impact   reverse transitive DEPENDS_ON ("what breaks if X dies")
 *   expert_finder       multi-hop expertise ranking with a score breakdown
 *   bridge_finder       betweenness-style bottleneck proxy
 */
import { GraphError, coerceNode, nodeToDict, type FalkorClient, type RawEdge, type RawNode, type RawPath } from "./graph";
import { serviceMatch } from "./cypher";
import type { BrainNode } from "./types";

export const ALGO_PAGERANK =
  "CALL algo.pageRank(null, null) YIELD node, score RETURN node, score ORDER BY score DESC LIMIT $limit";

export const DEGREE_CENTRALITY = `
MATCH (s:Service)
OPTIONAL MATCH (s)-[r:DEPENDS_ON]-()
RETURN s, count(r) AS score
ORDER BY score DESC
LIMIT $limit
`;

export const DEPENDENCY_IMPACT = `
MATCH (root:Service)
${serviceMatch("root")}
MATCH path = (affected:Service)-[:DEPENDS_ON*1..5]->(root)
RETURN DISTINCT affected, min(length(path)) AS distance
ORDER BY distance, affected.name
`;

export const EXPERT_FINDER = `
MATCH (root:Service)
${serviceMatch("root")}
OPTIONAL MATCH (p:Person)-[k:KNOWS_ABOUT]->(root)
WITH root, collect(DISTINCT {person: p, level: k.level, hops: 1}) AS direct
OPTIONAL MATCH (t:Ticket)-[:RELATES_TO]->(root)
WHERE t.status <> 'done'
OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(active:Person)
WITH root, direct, collect(DISTINCT {person: active, level: 'hands-on', hops: 2}) AS ticketed
OPTIONAL MATCH (root)<-[:OWNS]-(team:Team)
OPTIONAL MATCH (member:Person)-[:MEMBER_OF]->(team)
WITH direct, ticketed, collect(DISTINCT {person: member, level: 'owning-team', hops: 2}) AS owners
RETURN direct + ticketed + owners AS candidates
`;

export const BRIDGE_FINDER = `
MATCH (a:Service)-[:DEPENDS_ON*1..]->(mid:Service)-[:DEPENDS_ON*1..]->(b:Service)
WHERE a <> b
WITH mid, count(DISTINCT a) * count(DISTINCT b) AS bridge_score
RETURN mid, bridge_score
ORDER BY bridge_score DESC
LIMIT $limit
`;

export const SHORTEST_SERVICE_PATH = `
MATCH (a:Service)
WHERE toLower(a.name) CONTAINS toLower($from_name)
   OR toLower(a.id) CONTAINS toLower($from_name)
   OR any(x IN coalesce(a.aliases, []) WHERE toLower(x) CONTAINS toLower($from_name))
MATCH (b:Service)
WHERE toLower(b.name) CONTAINS toLower($to_name)
   OR toLower(b.id) CONTAINS toLower($to_name)
   OR any(x IN coalesce(b.aliases, []) WHERE toLower(x) CONTAINS toLower($to_name))
WITH a, b, shortestPath((a)-[:DEPENDS_ON*..6]->(b)) AS path
RETURN path
`;

export const BETWEENNESS_SERVICES =
  "CALL algo.betweenness({nodeLabels:['Service']}) YIELD node, score RETURN node, score ORDER BY score DESC LIMIT $limit";
export const BETWEENNESS_ALL =
  "CALL algo.betweenness() YIELD node, score RETURN node, score ORDER BY score DESC LIMIT $limit";
export const HARMONIC_CENTRALITY =
  "CALL algo.HarmonicCentrality({nodeLabels:['Service']}) YIELD node, score RETURN node, score ORDER BY score DESC LIMIT $limit";
export const COMMUNITIES = "CALL algo.labelPropagation() YIELD node RETURN node";

/** Conversation/memory labels are excluded: they describe talking, not structure. */
const MEMORY_LABELS = new Set([
  "Session",
  "Turn",
  "Finding",
  "AgentHandoff",
  "EpisodicMemory",
  "SemanticMemory",
  "ProceduralMemory",
]);

export type Scored = { node: BrainNode; score: number; approx?: boolean };

export async function betweennessCentrality(
  client: FalkorClient,
  limit = 8,
  servicesOnly = true,
): Promise<Scored[]> {
  const cypher = servicesOnly ? BETWEENNESS_SERVICES : BETWEENNESS_ALL;
  try {
    const rows = await client.query(cypher, { limit });
    const out: Scored[] = [];
    for (const row of rows) {
      const node = coerceNode(row.node);
      if (node) out.push({ node, score: Number(row.score), approx: false });
    }
    return out;
  } catch (err) {
    if (!(err instanceof GraphError)) throw err;
    const fallback = await bridgeServices(client, limit);
    return fallback.map((b) => ({ node: b.service, score: b.bridge_score, approx: true }));
  }
}

export async function harmonicCentrality(client: FalkorClient, limit = 8): Promise<Scored[]> {
  try {
    const rows = await client.query(HARMONIC_CENTRALITY, { limit });
    return rows
      .map((row) => {
        const node = coerceNode(row.node);
        return node ? { node, score: Number(row.score) } : null;
      })
      .filter((x): x is Scored => x !== null);
  } catch {
    return [];
  }
}

export type Community = {
  community: string;
  size: number;
  members: Array<{ id: string; name: string }>;
};

export async function communities(client: FalkorClient): Promise<Community[]> {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await client.query(COMMUNITIES);
  } catch {
    return [];
  }
  const home = await homeTeams(client);
  const groups = new Map<string, BrainNode[]>();
  for (const row of rows) {
    const node = coerceNode(row.node);
    if (!node) continue;
    const label = node.labels[0] ?? "";
    if (MEMORY_LABELS.has(label)) continue;
    const key = home.get(node.id) ?? communityLabel(node);
    const bucket = groups.get(key) ?? [];
    bucket.push(node);
    groups.set(key, bucket);
  }
  return [...groups.entries()]
    .map(([community, members]) => ({
      community,
      size: members.length,
      members: members.slice(0, 25).map((n) => ({ id: n.id, name: display(n) })),
    }))
    .sort((a, b) => b.size - a.size);
}

/** Team membership resolved from the graph rather than assumed from the label. */
const HOME_TEAM_QUERIES = [
  "MATCH (p:Person)-[:MEMBER_OF]->(t:Team) RETURN p.id AS id, t.name AS team",
  "MATCH (s:Service)<-[:OWNS]-(t:Team) RETURN s.id AS id, t.name AS team",
  "MATCH (x)-[:RELATES_TO]->(s:Service)<-[:OWNS]-(t:Team) RETURN x.id AS id, t.name AS team",
  "MATCH (m:Message)<-[:AUTHORED]-(p:Person)-[:MEMBER_OF]->(t:Team) RETURN m.id AS id, t.name AS team",
  "MATCH (x)<-[:DISCUSSED_IN]-(m:Message)<-[:AUTHORED]-(p:Person)-[:MEMBER_OF]->(t:Team) RETURN x.id AS id, t.name AS team",
];

async function homeTeams(client: FalkorClient): Promise<Map<string, string>> {
  const home = new Map<string, string>();
  for (const cypher of HOME_TEAM_QUERIES) {
    try {
      const rows = await client.query<{ id: string; team: string }>(cypher);
      for (const row of rows) {
        if (row.team && row.id && !home.has(String(row.id))) home.set(String(row.id), row.team);
      }
    } catch {
      // A missing relationship shape is not fatal — skip that query.
    }
  }
  return home;
}

function communityLabel(node: BrainNode): string {
  const props = node.properties;
  const label = node.labels[0] ?? "Node";
  if (label === "Person") return (props.team as string) || "unassigned";
  if (label === "Team") return (props.name as string) || label;
  if (label === "Service") {
    const owner = (props.owner as string) || "";
    return owner ? owner.split(":").slice(-1)[0] : label;
  }
  return label;
}

function display(node: BrainNode): string {
  const p = node.properties;
  return (p.name as string) || (p.key as string) || (p.title as string) || node.id;
}

export async function pagerank(client: FalkorClient, limit = 10): Promise<Scored[]> {
  try {
    const rows = await client.query(ALGO_PAGERANK, { limit });
    return rows
      .map((row) => {
        const node = coerceNode(row.node);
        return node ? { node, score: Number(row.score) } : null;
      })
      .filter((x): x is Scored => x !== null);
  } catch {
    const rows = await client.query(DEGREE_CENTRALITY, { limit });
    return rows
      .map((row) => {
        const node = coerceNode(row.s);
        return node ? { node, score: Number(row.score) } : null;
      })
      .filter((x): x is Scored => x !== null);
  }
}

export type Impact = { service: BrainNode; distance: number };

/** Services that transitively depend on `service` — what breaks if it dies. */
export async function dependencyImpact(client: FalkorClient, service: string): Promise<Impact[]> {
  const rows = await client.query(DEPENDENCY_IMPACT, { service });
  return rows
    .map((row) => {
      const node = coerceNode(row.affected);
      return node ? { service: node, distance: Number(row.distance) } : null;
    })
    .filter((x): x is Impact => x !== null);
}

export type ExpertRank = {
  person: BrainNode;
  score: number;
  evidence: string[];
  rank: number;
};

/** Multi-hop expert ranking with an explainable score breakdown. */
export async function expertFinder(client: FalkorClient, service: string): Promise<ExpertRank[]> {
  const rows = await client.query<{ candidates: unknown[] }>(EXPERT_FINDER, { service });
  if (rows.length === 0) return [];
  const candidates = (rows[0].candidates as Array<Record<string, unknown>>) ?? [];
  const scores = new Map<string, { person: BrainNode; score: number; evidence: string[] }>();
  const weights: Record<string, number> = {
    expert: 3.0,
    familiar: 1.0,
    "hands-on": 1.5,
    "owning-team": 0.5,
  };
  for (const cand of candidates) {
    const person = coerceNode(cand.person);
    if (!person) continue;
    const level = (cand.level as string) || "familiar";
    const hops = Number(cand.hops) || 1;
    const entry = scores.get(person.id) ?? { person, score: 0, evidence: [] };
    entry.score += (weights[level] ?? 0.5) / hops;
    entry.evidence.push(`${level} (hops=${hops})`);
    scores.set(person.id, entry);
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map((entry, i) => ({ ...entry, rank: i + 1 }));
}

export type Bridge = { service: BrainNode; bridge_score: number };

export async function bridgeServices(client: FalkorClient, limit = 5): Promise<Bridge[]> {
  const rows = await client.query(BRIDGE_FINDER, { limit });
  return rows
    .map((row) => {
      const node = coerceNode(row.mid);
      return node ? { service: node, bridge_score: Number(row.bridge_score) } : null;
    })
    .filter((x): x is Bridge => x !== null);
}

export type FormattedPath = {
  length: number;
  nodes: BrainNode[];
  edges: Array<{ type: string; source: string | null; target: string | null }>;
};

/**
 * Shortest DEPENDS_ON path between two services (either direction), formatted for traces.
 *
 * FalkorDB only supports *directed* shortestPath, so "how are A and B connected?" (which ignores edge direction)
 * is answered with a breadth-first search over the service dependency edges done here, then the nodes on the
 * winning path are loaded for the trace.
 */
export async function shortestPathBetweenServices(
  client: FalkorClient,
  fromName: string,
  toName: string,
  maxHops = 6,
): Promise<FormattedPath | null> {
  const resolve = async (needle: string) =>
    (
      await client.query<{ id: string }>(
        "MATCH (s:Service) WHERE toLower(s.name) CONTAINS toLower($needle) OR toLower(s.id) CONTAINS toLower($needle) " +
          "OR any(x IN coalesce(s.aliases, []) WHERE toLower(x) CONTAINS toLower($needle)) RETURN s.id AS id ORDER BY s.name LIMIT 1",
        { needle },
      )
    )[0]?.id;
  const [from, to] = [await resolve(fromName), await resolve(toName)];
  if (!from || !to) return null;
  if (from === to) {
    const n = await client.query("MATCH (s:Service {id: $id}) RETURN s", { id: from });
    const node = coerceNode(n[0]?.s);
    return node ? { length: 0, nodes: [node], edges: [] } : null;
  }

  const edges = await client.query<{ a: string; b: string }>(
    "MATCH (x:Service)-[:DEPENDS_ON]->(y:Service) RETURN x.id AS a, y.id AS b",
  );
  const adj = new Map<string, string[]>();
  for (const { a, b } of edges) {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  const prev = new Map<string, string | null>([[from, null]]);
  let frontier = [from];
  for (let hop = 0; hop < maxHops && !prev.has(to); hop++) {
    const next: string[] = [];
    for (const id of frontier) for (const nb of adj.get(id) ?? []) if (!prev.has(nb)) (prev.set(nb, id), next.push(nb));
    frontier = next;
  }
  if (!prev.has(to)) return null;
  const ids: string[] = [];
  for (let cur: string | null | undefined = to; cur; cur = prev.get(cur)) ids.unshift(cur);

  const rows = await client.query<{ s: RawNode }>("MATCH (s:Service) WHERE s.id IN $ids RETURN s", { ids });
  const byId = new Map(rows.map((r) => [nodeToDict(r.s).id, nodeToDict(r.s)]));
  const nodes = ids.map((id) => byId.get(id)).filter((n): n is BrainNode => !!n);
  const forward = new Set(edges.map((e) => `${e.a}>${e.b}`));
  const hops = ids.slice(1).map((id, i) => ({
    type: "DEPENDS_ON",
    // keep the real direction of each dependency on the path
    source: forward.has(`${ids[i]}>${id}`) ? ids[i] : id,
    target: forward.has(`${ids[i]}>${id}`) ? id : ids[i],
  }));
  return { length: hops.length, nodes, edges: hops };
}
