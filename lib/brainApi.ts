"use client";

/**
 * Typed client for the Company Brain API.
 *
 * The brain backend now lives inside this Next.js app (`app/api/brain/*`),
 * so the default base URL is same-origin. `NEXT_PUBLIC_API_URL` can still
 * point at a full origin (e.g. a deployed frontend talking to a deployed
 * app) — the `/api/brain` prefix is always appended.
 */

const API_BASE = (process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") || "") + "/api/brain";

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ||
  (typeof window !== "undefined" ? window.location.origin : "");

export type GraphNode = {
  id: string;
  label: string;
  name: string;
  labels: string[];
  properties: Record<string, unknown>;
  color?: string;
};

export type GraphEdge = {
  source: string;
  target: string;
  type: string;
  properties?: Record<string, unknown>;
};

export type SubGraph = { nodes: GraphNode[]; edges: GraphEdge[] };

export type OverviewNode = GraphNode & { group: string; degree: number };
export type Overview = {
  nodes: OverviewNode[];
  edges: GraphEdge[];
  counts: Record<string, number>;
  relationCounts: Record<string, number>;
  truncated: boolean;
  generatedAt: string;
};

export type TraceStep = {
  tool: string;
  arguments: Record<string, unknown>;
  cypher?: string | null;
  result_summary?: string | null;
  row_count?: number;
  duration_ms?: number;
  error?: string | null;
  round?: number;
};

export type ChatResponse = {
  answer: string;
  reasoning_trace: TraceStep[];
  graph_context: SubGraph;
  session_id: string;
  user_id: string;
  sources: string[];
  agents_involved: string[];
  tool_count: number;
  memories_used?: MemoryNode[];
  activity?: ActivityItem[];
  intent?: string;
  procedures_used?: Procedure[];
  procedure_learned?: Procedure | null;
};

export type MemoryNode = {
  id: string;
  summary: string;
  kind: "episodic" | "semantic";
  timestamp?: string;
  about?: string[];
};

export type ActivityItem = {
  kind: "finding" | "handoff";
  agent: string;
  detail: string;
  timestamp?: string;
};

export type Procedure = {
  id: string;
  task_pattern: string;
  steps: string[];
  uses?: number;
  applied?: number;
  successes?: number;
  learned?: boolean;
  rationale?: string;
  applies_when?: string;
  avoid_when?: string;
};

export type SessionSummary = {
  session_id: string;
  started_at?: string | null;
  last_active_at?: string | null;
  turn_count: number;
  preview?: string | null;
};

export type Turn = {
  id: string;
  role: string;
  content: string;
  timestamp?: string | null;
  agent?: string | null;
};

export type SchemaInfo = {
  labels: { label: string; color: string }[];
  relationships: string[];
  relationship_properties: Record<string, string[]>;
  node_counts: Record<string, number>;
  edge_counts: Record<string, number>;
};

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`${res.status} ${path}: ${detail.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => jsonFetch<{ status: string; llm: string }>("/health"),

  chat: (message: string, session_id: string | null, user_id: string) =>
    jsonFetch<ChatResponse>("/chat", {
      method: "POST",
      body: JSON.stringify({ message, session_id, user_id }),
    }),

  schema: () => jsonFetch<SchemaInfo>("/graph/schema"),

  overview: () => jsonFetch<Overview>("/graph/overview"),

  subgraph: (node_id: string, depth = 2) =>
    jsonFetch<SubGraph>(
      `/graph/subgraph?node_id=${encodeURIComponent(node_id)}&depth=${depth}`,
    ),

  node: (id: string) =>
    jsonFetch<{
      id: string;
      label: string;
      name: string;
      color: string;
      properties: Record<string, unknown>;
      neighbours: { id: string; name: string; label: string; rel: string }[];
    }>(`/graph/node/${encodeURIComponent(id)}`),

  sessions: (user_id: string) =>
    jsonFetch<{ sessions: SessionSummary[] }>(`/sessions/${encodeURIComponent(user_id)}`),

  turns: (session_id: string) =>
    jsonFetch<{ turns: Turn[] }>(`/sessions/${encodeURIComponent(session_id)}/turns`),

  activity: (session_id: string) =>
    jsonFetch<{ activity: ActivityItem[] }>(
      `/sessions/${encodeURIComponent(session_id)}/activity`,
    ),

  memory: (user_id: string, q = "") =>
    jsonFetch<{
      memories: MemoryNode[];
      stats: Record<string, number>;
      procedures: Procedure[];
    }>(`/memory/${encodeURIComponent(user_id)}?q=${encodeURIComponent(q)}`),
};

export type StreamEvent =
  | { type: "start"; session_id: string }
  | { type: "tool"; tool: string; arguments: Record<string, unknown>; cypher?: string; result_summary: string; row_count: number; duration_ms: number; error?: string | null }
  | { type: "handoff"; from: string; to: string; findings: number }
  | { type: "memory"; memories: MemoryNode[] }
  | { type: "procedures"; procedures: Procedure[] }
  | { type: "procedure_learned"; procedure: Procedure }
  | { type: "delta"; text: string }
  | {
      type: "done";
      answer: string;
      reasoning_trace: TraceStep[];
      graph_context: SubGraph;
      sources: string[];
      agents_involved: string[];
      session_id: string;
      activity: ActivityItem[];
      procedures_used?: Procedure[];
      procedure_learned?: Procedure | null;
    }
  | { type: "error"; message: string };

/**
 * Stream one chat turn over Server-Sent Events, invoking `onEvent` per frame.
 *
 * `onClose` fires only when the stream ends WITHOUT a `done` (or `error`)
 * frame — the caller keeps the REST path as a safety net, so a failed stream
 * degrades instead of breaking.
 */
export function streamChat(
  payload: { message: string; session_id: string | null; user_id: string },
  onEvent: (e: StreamEvent) => void,
  onClose?: () => void,
): () => void {
  let aborted = false;
  let finished = false;
  const controller = new AbortController();

  const fail = () => {
    if (!finished && !aborted) {
      finished = true;
      onClose?.();
    }
  };

  (async () => {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch {
      fail();
      return;
    }
    if (!res.ok || !res.body) {
      fail();
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of chunk.split("\n")) {
            const text = line.startsWith(":") ? "" : line.replace(/^data:\s?/, "");
            if (!text.trim()) continue;
            try {
              const ev = JSON.parse(text) as StreamEvent;
              if (ev.type === "done" || ev.type === "error") finished = true;
              onEvent(ev);
            } catch {
              /* ignore malformed frame */
            }
          }
        }
      }
    } catch {
      // network cut mid-stream
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
    if (!finished && !aborted) {
      finished = true;
      onClose?.();
    }
  })();

  return () => {
    aborted = true;
    controller.abort();
  };
}
