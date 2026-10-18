import type { FalkorClient } from "./graph";
import { groupOf } from "./palette";
import { shapeNode } from "./schema";
import type { BrainNode } from "./types";

/**
 * The "overall view": the whole graph the signed-in user is allowed to see, in one payload.
 *
 *  - company data (people, teams, services, tickets, decisions, ...) is shared by everyone;
 *  - everything personal is limited to the caller: their chat sessions/turns/memories/findings, their workspaces
 *    (plans, todos, commands, sessions, ...) and the shared-memory notes scoped to those.
 */
const COMPANY_LABELS = ["Person", "Team", "Service", "Repo", "Document", "Ticket", "Decision", "Message", "ProceduralMemory"];
const MAX_NODES = 2500;

export interface OverviewGraph {
  nodes: Array<ReturnType<typeof shapeNode> & { group: string; degree: number }>;
  edges: Array<{ source: string; target: string; type: string }>;
  counts: Record<string, number>;
  relationCounts: Record<string, number>;
  truncated: boolean;
  generatedAt: string;
}

export async function buildOverview(client: FalkorClient, uid: string): Promise<OverviewGraph> {
  const byId = new Map<string, BrainNode>();
  const add = (nodes: BrainNode[]) => {
    for (const n of nodes) if (n.id && !byId.has(n.id)) byId.set(n.id, n);
  };

  add(await client.nodes("MATCH (n) WHERE any(l IN labels(n) WHERE l IN $labels) RETURN n LIMIT $cap", { labels: COMPANY_LABELS, cap: MAX_NODES }));

  // personal: chats and memory
  const sessions = await client.nodes("MATCH (s:Session) WHERE s.user_id = $uid RETURN s", { uid });
  add(sessions);
  const sids = sessions.map((s) => s.id);
  if (sids.length) {
    add(await client.nodes("MATCH (s:Session)-[:CONTAINS]->(t:Turn) WHERE s.id IN $sids RETURN t", { sids }));
    add(await client.nodes("MATCH (f:Finding) WHERE f.session_id IN $sids RETURN f", { sids }));
    add(await client.nodes("MATCH (h:AgentHandoff) WHERE h.session_id IN $sids RETURN h", { sids }));
  }
  add(await client.nodes("MATCH (m) WHERE (m:EpisodicMemory OR m:SemanticMemory) AND m.user_id = $uid RETURN m", { uid }));

  // personal: workspaces and what hangs off them
  const workspaces = await client.nodes("MATCH (w:Workspace) WHERE w.owner = $uid AND coalesce(w.status, 'active') <> 'archived' RETURN w", { uid });
  add(workspaces);
  const wids = workspaces.map((w) => w.id);
  const scopes = [`global:${uid}`, ...wids.map((w) => `workspace:${w}`)];
  if (wids.length) add(await client.nodes("MATCH (n) WHERE n.workspace_id IN $wids RETURN n", { wids }));
  add(await client.nodes("MATCH (m:SharedMemory) WHERE m.scope IN $scopes RETURN m", { scopes }));

  const ids = [...byId.keys()].slice(0, MAX_NODES);
  const keep = new Set(ids);
  const edgeRows = ids.length
    ? await client.query<{ s: string; t: string; type: string }>(
        "MATCH (a)-[r]->(b) WHERE a.id IN $ids AND b.id IN $ids RETURN a.id AS s, b.id AS t, type(r) AS type",
        { ids },
      )
    : [];
  const seen = new Set<string>();
  const edges = edgeRows
    .filter((e) => keep.has(e.s) && keep.has(e.t))
    .map((e) => ({ source: e.s, target: e.t, type: e.type }))
    .filter((e) => {
      const k = `${e.source}>${e.type}>${e.target}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });

  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const nodes = ids.map((id) => {
    const shaped = shapeNode(byId.get(id)!);
    return { ...shaped, group: groupOf(shaped.label), degree: degree.get(id) ?? 0 };
  });

  const counts: Record<string, number> = {};
  for (const n of nodes) counts[n.label] = (counts[n.label] ?? 0) + 1;
  const relationCounts: Record<string, number> = {};
  for (const e of edges) relationCounts[e.type] = (relationCounts[e.type] ?? 0) + 1;

  return { nodes, edges, counts, relationCounts, truncated: byId.size > MAX_NODES, generatedAt: new Date().toISOString() };
}
