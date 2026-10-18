/**
 * FalkorDB connection wrapper + serialisation helpers.
 *
 * This is the one place that talks to the database. Everything above it works
 * in plain objects (`BrainNode` / `BrainEdge` / rows), which keeps the agent
 * tools, memory layer and API routes free of driver details.
 *
 * The Node driver differs from the Python one in two ways that matter here:
 *   - result rows are objects keyed by RETURN alias (not positional lists);
 *   - nodes/edges/paths arrive already parsed into plain objects.
 * Both are handled once, here.
 */
import { FalkorDB } from "falkordb";
import type { Graph } from "falkordb";

import { brainConfig } from "./config";
import type { BrainEdge, BrainNode } from "./types";

export class GraphError extends Error {}

/** A result row, keyed by the RETURN alias. */
export type Row = Record<string, unknown>;

/** Recursive param shape accepted by the driver (mirrors redis QueryParams). */
type QueryParamValue = string | number | boolean | null | QueryParamValue[] | { [key: string]: QueryParamValue };
type QueryParams = { [key: string]: QueryParamValue };

export type RawNode = { id: number; labels: string[]; properties: Record<string, unknown> };
export type RawEdge = {  id: number;
  sourceId: number;
  destinationId: number;
  properties: Record<string, unknown>;
  relationshipType: string;
};
export type RawPath = { nodes: RawNode[]; edges: RawEdge[] };
function isRawNode(value: unknown): value is RawNode {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "number" && Array.isArray(v.labels) && !!v.properties;
}

function isRawEdge(value: unknown): value is RawEdge {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sourceId === "number" &&
    typeof v.destinationId === "number" &&
    typeof v.relationshipType === "string"
  );
}

function isRawPath(value: unknown): value is RawPath {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.nodes) && Array.isArray(v.edges);
}

/** Coerce a driver value into a serialised node, or null if it is not one. */
export function coerceNode(value: unknown): BrainNode | null {
  return isRawNode(value) ? nodeToDict(value) : null;
}

/** Coerce a driver value into a serialised edge, or null if it is not one. */
export function coerceEdge(value: unknown): BrainEdge | null {
  return isRawEdge(value) ? edgeToDict(value) : null;
}

/** Stable business id: the `id` property, falling back to the element id. */
export function nodeId(node: RawNode): string {
  const props = node.properties ?? {};
  if (props.id !== undefined && props.id !== null) return String(props.id);
  return String(node.id);
}

export function nodeToDict(node: RawNode): BrainNode {
  const props = { ...(node.properties ?? {}) };
  const labels = Array.isArray(node.labels) ? node.labels : [];
  const label = labels[0] ?? "Node";
  return {
    id: nodeId(node),
    labels: [...labels],
    label,
    name:
      (props.name as string) ||
      (props.key as string) ||
      (props.title as string) ||
      nodeId(node),
    properties: props,
    element_id: node.id,
  };
}

export function edgeToDict(edge: RawEdge, elementToBusiness?: Map<number, string>): BrainEdge {
  const map = elementToBusiness ?? new Map<number, string>();
  return {
    id: edge.id,
    source: map.get(edge.sourceId) ?? String(edge.sourceId),
    target: map.get(edge.destinationId) ?? String(edge.destinationId),
    type: edge.relationshipType ?? "",
    properties: { ...(edge.properties ?? {}) },
  };
}

/**
 * Scan query rows for nodes/edges/paths and build a de-duplicated subgraph.
 *
 * Values are walked generically because a row may hold a node, a list of
 * nodes, or a whole path — the tools return all three shapes.
 */
export function collectSubgraph(rows: Row[]): { nodes: BrainNode[]; edges: BrainEdge[] } {
  const nodes = new Map<string, BrainNode>();
  const elementToBusiness = new Map<number, string>();
  const rawEdges: RawEdge[] = [];

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (isRawNode(value)) {
      const d = nodeToDict(value);
      nodes.set(d.id, d);
      elementToBusiness.set(value.id, d.id);
      return;
    }
    if (isRawEdge(value)) {
      rawEdges.push(value);
      return;
    }
    if (isRawPath(value)) {
      for (const n of value.nodes) walk(n);
      for (const e of value.edges) walk(e);
    }
  };

  for (const row of rows) {
    for (const value of Object.values(row)) walk(value);
  }

  const edges: BrainEdge[] = [];
  const seen = new Set<string>();
  for (const raw of rawEdges) {
    const d = edgeToDict(raw, elementToBusiness);
    const key = `${d.source}|${d.target}|${d.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(d);
  }
  return { nodes: [...nodes.values()], edges };
}

/** Marker key for the process-wide connection (survives HMR in dev). */
const CONNECTION_KEY = Symbol.for("lazychat.brain.falkordb");

type CachedConnection = { promise: Promise<FalkorClient> };

/**
 * FalkorDB ships parameters as a `CYPHER name=value ...` prefix in front of the query text, so a parameter whose
 * name is itself a Cypher keyword (`$cypher`, `$match`, `$return`, `$limit`...) is misparsed as a clause and the
 * whole query fails with "Invalid input '='". Rename any such parameter (`$cypher` -> `$p_cypher`) in both the
 * parameter map and the query text, so callers can use natural names.
 */
const RESERVED_PARAM_NAMES = new Set(
  (
    "cypher explain profile match optional where return with unwind create merge delete detach set remove call yield " +
    "union all distinct as order by skip limit asc ascending desc descending and or xor not in is null true false " +
    "case when then else end starts ends contains exists any none single count foreach load csv from using index on " +
    "drop constraint unique node relationship"
  ).split(" "),
);

export function safeParams(cypher: string, params: Record<string, unknown>): { cypher: string; params: Record<string, unknown> } {
  let text = cypher;
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(params)) {
    if (RESERVED_PARAM_NAMES.has(name.toLowerCase())) {
      const renamed = `p_${name}`;
      // `[$]` = a literal dollar sign; the lookahead keeps `$cypher` from matching inside `$cypher_text`.
      text = text.replace(new RegExp("[$]" + name + "(?![A-Za-z0-9_])", "g"), () => "$" + renamed);
      out[renamed] = value;
    } else {
      out[name] = value;
    }
  }
  return { cypher: text, params: out };
}

export class FalkorClient {
  readonly graphName: string;
  private readonly db: FalkorDB;
  private readonly graph: Graph;

  private constructor(db: FalkorDB, graphName: string) {
    this.db = db;
    this.graphName = graphName;
    this.graph = db.selectGraph(graphName);
  }

  /** Process-wide singleton. */
  static async get(): Promise<FalkorClient> {
    const globalStore = globalThis as unknown as Record<symbol, CachedConnection | undefined>;
    let cached = globalStore[CONNECTION_KEY];
    if (!cached) {
      cached = { promise: FalkorClient.create() };
      globalStore[CONNECTION_KEY] = cached;
    }
    try {
      return await cached.promise;
    } catch (err) {
      // Do not cache a failed connection — the next request should retry.
      globalStore[CONNECTION_KEY] = undefined;
      throw err;
    }
  }

  private static async create(): Promise<FalkorClient> {
    const { falkordb } = brainConfig();
    try {
      const db = await FalkorDB.connect({
        username: falkordb.username || undefined,
        password: falkordb.password || undefined,
        socket: { host: falkordb.host, port: falkordb.port, tls: falkordb.tls, connectTimeout: 15_000 } as never,
      });
      return new FalkorClient(db, falkordb.graphName);
    } catch (err) {
      throw new GraphError(
        `Cannot connect to FalkorDB at ${falkordb.host}:${falkordb.port}: ${(err as Error).message}`,
      );
    }
  }

  /** Execute a Cypher query and return its rows. */
  async query<T = Row>(cypher: string, rawParams: Record<string, unknown> = {}): Promise<T[]> {
    const start = Date.now();
    const safe = safeParams(cypher, rawParams);
    const params = safe.params;
    cypher = safe.cypher;
    try {
      const reply = await this.graph.query(cypher, { params: params as QueryParams });
      const rows = (reply.data ?? []) as T[];
      this.log(cypher, params, rows.length, Date.now() - start);
      return rows;
    } catch (err) {
      throw new GraphError(`Cypher failed: ${(err as Error).message}; query=${JSON.stringify(cypher)}`);
    }
  }

  /** Execute a write query, discarding the result. */
  async write(cypher: string, params: Record<string, unknown> = {}): Promise<void> {
    await this.query(cypher, params);
  }

  /** Run a query whose rows are all nodes, returning serialised dicts. */
  async nodes(cypher: string, params: Record<string, unknown> = {}): Promise<BrainNode[]> {
    const rows = await this.query(cypher, params);
    const out: BrainNode[] = [];
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (isRawNode(value)) out.push(nodeToDict(value));
      }
    }
    return out;
  }

  async deleteGraph(): Promise<void> {
    try {
      await this.graph.delete();
    } catch {
      // A fresh FalkorDB has no graph to delete; that is not an error here.
    }
  }

  /** Close the underlying connection (used by scripts/tests to exit cleanly). */
  async close(): Promise<void> {
    try {
      await this.db.close();
    } catch {
      // already closed
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.query("RETURN 1");
      return true;
    } catch {
      return false;
    }
  }

  private log(cypher: string, params: Record<string, unknown>, rows: number, ms: number): void {
    if (process.env.BRAIN_QUERY_LOG !== "1") return;
    const brief = Object.entries(params)
      .map(([k, v]) =>
        Array.isArray(v) && v.length > 4 ? `${k}=[${v.length} rows]` : `${k}=${String(v).slice(0, 160)}`,
      )
      .join(", ");
    console.info(
      `[brain] cypher (${ms}ms, ${rows} rows): ${cypher.replace(/\s+/g, " ").trim().slice(0, 200)} | ${brief}`,
    );
  }
}
