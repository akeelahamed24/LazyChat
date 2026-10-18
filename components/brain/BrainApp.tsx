"use client";

import * as React from "react";
import { api, streamChat, API_URL, type ActivityItem, type GraphNode, type MemoryNode, type Procedure, type SchemaInfo, type SessionSummary, type SubGraph, type TraceStep, type Turn } from "@/lib/brainApi";
import { GraphCanvas, Legend, nodeColor } from "./GraphCanvas";
import { OverviewGraph } from "./OverviewGraph";
import { AgentActivity, MemoryPanel, ProceduresPanel, ReasoningTrace } from "./Panels";
import { Button, cn, Segmented, SpotlightCard, Toggle } from "@/components/ui";
import { OmniaMark } from "@/components/brand/OmniaLogo";
import { BrandIcon } from "@/components/brand/BrandIcon";
import { ArrowUp, ArrowUpRight, Network, Plus, RefreshCw } from "lucide-react";
import { useAuth } from "@/lib/auth/AuthProvider";


const SUGGESTIONS = [
  "Which tickets are blocked by the auth migration?",
  "If the notifications service goes down, what breaks?",
  "Who knows the auth system?",
  "What did we decide about the database and why?",
  "Which services are bottlenecks?",
  "Who worked on the payments service and what decisions did they make?",
  "File a p1 ticket for the auth outage and assign it to the best expert",
];

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  trace?: TraceStep[];
  agents?: string[];
  sources?: string[];
  streaming?: boolean;
};

function mergeProcedures(current: Procedure[], incoming: Procedure[]): Procedure[] {
  const byId = new Map(current.map((p) => [p.id, p]));
  for (const p of incoming) {
    if (!p?.id) continue;
    const prev = byId.get(p.id);
    byId.set(p.id, { ...prev, ...p, uses: Math.max(prev?.uses ?? 0, p.uses ?? 0) });
  }
  return [...byId.values()].sort(
    (a, b) => Number(!!b.learned) - Number(!!a.learned) || (b.uses ?? 0) - (a.uses ?? 0),
  );
}

export function BrainApp() {
  // The server ignores any client-supplied id and uses the verified uid; this is only the URL key.
  const USER_ID = useAuth().user?.uid ?? "me";
  const [messages, setMessages] = React.useState<Msg[]>([]);
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [sessionId, setSessionId] = React.useState<string | null>(null);

  const [graph, setGraph] = React.useState<SubGraph>({ nodes: [], edges: [] });
  const [highlight, setHighlight] = React.useState<Set<string>>(new Set());
  const [traverse, setTraverse] = React.useState<string[]>([]);
  const [showReasoning, setShowReasoning] = React.useState(true);

  const [schema, setSchema] = React.useState<SchemaInfo | null>(null);
  const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
  const [activity, setActivity] = React.useState<ActivityItem[]>([]);
  const [memories, setMemories] = React.useState<MemoryNode[]>([]);
  const [memStats, setMemStats] = React.useState<Record<string, number>>({});
  const [procedures, setProcedures] = React.useState<Procedure[]>([]);
  const [justLearned, setJustLearned] = React.useState<Procedure | null>(null);
  const [detail, setDetail] = React.useState<GraphNode | null>(null);
  const [view, setView] = React.useState<"ask" | "overview">("ask");
  const [tab, setTab] = React.useState<"graph" | "activity" | "memory">("graph");
  const [memView, setMemView] = React.useState<"memories" | "procedures">("memories");
  const [error, setError] = React.useState<string | null>(null);
  const [connected, setConnected] = React.useState<boolean | null>(null);

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const closeStream = React.useRef<(() => void) | null>(null);

  // --- bootstrap ---------------------------------------------------------
  React.useEffect(() => {
    api.health().then(() => setConnected(true)).catch(() => setConnected(false));
    api.schema().then(setSchema).catch(() => {});
    api.sessions(USER_ID).then((r) => setSessions(r.sessions)).catch(() => {});
    api.memory(USER_ID).then((r) => {
      setMemories(r.memories);
      setMemStats(r.stats);
      setProcedures(r.procedures);
    }).catch(() => {});
    return () => closeStream.current?.();
  }, []);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // --- send --------------------------------------------------------------
  const applyGraph = React.useCallback((sub: SubGraph) => {
    setGraph(sub);
    setHighlight(new Set(sub.nodes.map((n) => n.id)));
  }, []);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;

    setError(null);
    setInput("");
    setBusy(true);
    const userMsg: Msg = { id: crypto.randomUUID(), role: "user", content: question };
    const replyId = crypto.randomUUID();
    setMessages((m) => [
      ...m,
      userMsg,
      { id: replyId, role: "assistant", content: "", trace: [], streaming: true },
    ]);

    const liveTrace: TraceStep[] = [];
    const appendDelta = (chunk: string) =>
      setMessages((m) =>
        m.map((x) => (x.id === replyId ? { ...x, content: x.content + chunk } : x)),
      );
    const setTrace = () =>
      setMessages((m) =>
        m.map((x) => (x.id === replyId ? { ...x, trace: [...liveTrace] } : x)),
      );

    let gotDone = false;
    // The socket is the primary path. The REST fallback fires only if the
    // socket actually FAILED (error/close) — never merely because the answer
    // is slow. A time-based fallback would double every question's cost with a
    // 20-90s model while both calls run concurrently.
    let socketFailed = false;
    let poll: number | undefined;
    try {
      closeStream.current = streamChat(
        { message: question, session_id: sessionId, user_id: USER_ID },
        (ev) => {
          switch (ev.type) {
            case "start":
              setSessionId(ev.session_id);
              break;
            case "tool":
              liveTrace.push({
                tool: ev.tool,
                arguments: ev.arguments,
                cypher: ev.cypher,
                result_summary: ev.result_summary,
                row_count: ev.row_count,
                duration_ms: ev.duration_ms,
                error: ev.error,
              });
              setTrace();
              break;
            case "handoff":
              setActivity((a) => [
                ...a,
                {
                  kind: "handoff",
                  agent: ev.from,
                  detail: `→ ${ev.to}: ${ev.findings} finding(s) handed off`,
                  timestamp: new Date().toISOString(),
                },
              ]);
              break;
            case "memory":
              if (ev.memories?.length) {
                // A memory recalled again must not be listed twice: newest recall first, one entry per id.
                setMemories((m) => {
                  const seen = new Set<string>();
                  return [...ev.memories, ...m].filter((x: MemoryNode) => !seen.has(x.id) && !!seen.add(x.id));
                });
              }
              break;
            case "procedures":
              if (ev.procedures?.length) setProcedures((p) => mergeProcedures(p, ev.procedures!));
              break;
            case "procedure_learned":
              setJustLearned(ev.procedure ?? null);
              setProcedures((p) => mergeProcedures(p, [ev.procedure!]));
              break;
            case "delta":
              appendDelta(ev.text);
              break;
            case "done": {
              gotDone = true;
              setSessionId(ev.session_id);
              applyGraph(ev.graph_context);
              setTraverse(ev.graph_context.nodes.map((n) => n.id));
              setActivity(ev.activity || []);
              setMessages((m) =>
                m.map((x) =>
                  x.id === replyId
                    ? {
                        ...x,
                        content: ev.answer,
                        trace: ev.reasoning_trace,
                        agents: ev.agents_involved,
                        sources: ev.sources,
                        streaming: false,
                      }
                    : x,
                ),
              );
              break;
            }
            case "error":
              setError(ev.message);
              break;
          }
        },
        () => {
          // Closed without a `done`: the stream failed, so fall back to REST.
          if (!gotDone) socketFailed = true;
        },
      );

      const useRestFallback = async () => {
        if (gotDone || !socketFailed) return;
        try {
          const r = await api.chat(question, sessionId, USER_ID);
          gotDone = true;
          setSessionId(r.session_id);
          applyGraph(r.graph_context);
          setTraverse(r.graph_context.nodes.map((n) => n.id));
          setActivity(r.activity || []);
          if (r.procedure_learned) {
            setJustLearned(r.procedure_learned);
            setProcedures((p) => mergeProcedures(p, [r.procedure_learned!]));
          }
          setMessages((m) =>
            m.map((x) =>
              x.id === replyId
                ? {
                    ...x,
                    content: r.answer,
                    trace: r.reasoning_trace,
                    agents: r.agents_involved,
                    sources: r.sources,
                    streaming: false,
                  }
                : x,
            ),
          );
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          setMessages((m) =>
            m.map((x) => (x.id === replyId ? { ...x, streaming: false } : x)),
          );
        }
      };

      // Poll briefly: if the socket dies we want to react in seconds, but a
      // slow-but-healthy stream must not trigger a duplicate call.
      let waited = 0;
      poll = window.setInterval(async () => {
        waited += 500;
        if (gotDone) {
          window.clearInterval(poll);
          return;
        }
        if (socketFailed) {
          window.clearInterval(poll);
          await useRestFallback();
        } else if (waited > 60000) {
          window.clearInterval(poll);
          setError("The agent is taking longer than a minute. Check the backend logs.");
        }
      }, 500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }

    // Release the UI only when the turn really finished. A 20-90s model must
    // keep the Send button disabled, otherwise the user can fire a second
    // question into the same session mid-answer.
    const finish = () => {
      if (poll !== undefined) window.clearInterval(poll);
      setBusy(false);
      closeStream.current?.();
      api.sessions(USER_ID).then((r) => setSessions(r.sessions)).catch(() => {});
      api.memory(USER_ID).then((r) => {
        setMemories(r.memories);
        setMemStats(r.stats);
        setProcedures(r.procedures);
      }).catch(() => {});
    };
    const watch = window.setInterval(() => {
      if (gotDone) {
        window.clearInterval(watch);
        finish();
      }
    }, 300);
  }

  // --- sessions ----------------------------------------------------------
  async function loadSession(sid: string) {
    try {
      const { turns } = await api.turns(sid);
      const msgs: Msg[] = turns.map((t) => ({
        id: t.id,
        role: (t.role === "user" ? "user" : "assistant") as "user" | "assistant",
        content: t.content,
      }));
      setMessages(msgs);
      setSessionId(sid);
      const act = await api.activity(sid);
      setActivity(act.activity);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function newSession() {
    setSessionId(null);
    setMessages([]);
    setGraph({ nodes: [], edges: [] });
    setHighlight(new Set());
    setTraverse([]);
    setActivity([]);
    setDetail(null);
  }

  // --- graph interaction --------------------------------------------------
  async function onNodeClick(node: GraphNode) {
    setDetail(node);
    try {
      const full = await api.node(node.id);
      setDetail({ ...node, properties: full.properties, label: full.label, name: full.name });
    } catch {
      /* keep the partial node detail */
    }
    try {
      const sub = await api.subgraph(node.id, 2);
      applyGraph(sub);
    } catch {
      /* expansion is best-effort */
    }
  }

  const activeNode = detail ? detail.id : null;

  return (
    <div className="flex h-full w-full overflow-hidden bg-bg text-fg">
      {/* ---------------- sidebar ---------------- */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-bg-alternative animate-slide-in-left">
        <div className="border-b border-border p-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-bg-surface-200 text-accent">
              <Network size={15} />
            </span>
            <div className="min-w-0">
              <h1 className="text-[13.5px] font-medium tracking-tight">Company Brain</h1>
              <p className="flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-wider text-fg-muted">
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    connected === null ? "animate-pulse bg-warning" : connected ? "bg-brand shadow-[0_0_6px_var(--brand)]" : "bg-danger",
                  )}
                />
                {connected === null ? "connecting…" : connected ? "FalkorDB connected" : "backend unreachable"}
              </p>
            </div>
          </div>
          <Segmented
            className="mt-3"
            value={view}
            onChange={setView}
            options={[
              { value: "ask", label: "Ask" },
              { value: "overview", label: "Overview" },
            ]}
          />
          <div className="mt-3 flex gap-1.5">
            <Button size="sm" variant="primary" className="group" onClick={() => { setView("ask"); newSession(); }}>
              <Plus size={13} className="transition-transform duration-300 group-hover:rotate-90" /> New session
            </Button>
            <Button size="sm" variant="secondary" className="group" onClick={() => { setTab("memory"); api.memory(USER_ID).then((r) => { setMemories(r.memories); setMemStats(r.stats); }); }}>
              <RefreshCw size={12} className="transition-transform duration-500 group-hover:rotate-180" /> Refresh memory
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          <p className="eyebrow px-1.5 pb-1.5 pt-2 !text-[10.5px]">
            Past sessions
          </p>
          {sessions.length === 0 && (
            <p className="mx-1 rounded-md border border-dashed border-border px-3 py-3 text-[11.5px] text-fg-muted">No sessions yet.</p>
          )}
          <div className="stagger [--stagger:25ms]">
          {sessions.map((s) => (
            <button
              key={s.session_id}
              onClick={() => loadSession(s.session_id)}
              className={cn(
                "group relative mb-px block w-full rounded-md px-2.5 py-2 text-left transition-colors",
                s.session_id === sessionId
                  ? "bg-bg-surface-300 text-fg"
                  : "text-fg-secondary hover:bg-bg-hover hover:text-fg",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-brand transition-all duration-300",
                  s.session_id === sessionId ? "scale-y-100 opacity-100" : "scale-y-0 opacity-0",
                )}
              />
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[12px]">
                  {s.preview || s.session_id.slice(0, 22)}
                </span>
                <span className="ml-auto shrink-0 rounded-full border border-border bg-bg-surface-200 px-1.5 font-mono text-[9.5px] leading-4 text-fg-muted">
                  {s.turn_count}
                </span>
              </div>
              {s.last_active_at && (
                <p className="mt-0.5 font-mono text-[10px] text-fg-muted">
                  {s.last_active_at.slice(0, 16).replace("T", " ")}
                </p>
              )}
            </button>
          ))}
          </div>
        </div>

        <div className="border-t border-border p-2.5">
          <p className="truncate font-mono text-[10px] text-fg-muted">
            <span className="uppercase tracking-wider">API</span> <span className="text-fg-secondary">{API_URL}</span>
          </p>
        </div>
      </aside>

      {view === "overview" && (
        <section className="flex min-w-0 flex-1 flex-col">
          <OverviewGraph onClose={() => setView("ask")} />
        </section>
      )}

      {/* ---------------- chat ---------------- */}
      <section className={cn("flex min-w-0 flex-1 flex-col", view === "overview" && "hidden")}>
        <div className="glass flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
          <span className="shrink-0 whitespace-nowrap text-[13.5px] font-medium text-fg">Ask the company</span>
          {messages.length === 0 && (
            <span className="hidden truncate text-[11.5px] text-fg-muted md:inline animate-fade-in">
              · every answer is a graph traversal — nothing is invented
            </span>
          )}
        </div>

        <div ref={scrollRef} className="relative flex-1 overflow-y-auto px-4 py-3">
          {messages.length === 0 && (
            <>
              <div className="hero-backdrop" aria-hidden>
                <div className="hero-grid" />
                <div className="hero-aurora" />
                <span className="hero-beam" style={{ top: "30%", animationDelay: "1s" }} />
              </div>
              <div className="relative z-10 mx-auto max-w-2xl pt-10 stagger [--stagger:60ms]">
                <div className="mb-4 flex justify-center">
                  <span className="flex items-center gap-2 rounded-full border border-border bg-bg-surface-100/80 px-3 py-1 text-[11.5px] text-fg-secondary backdrop-blur">
                    <BrandIcon name="neo4j" size={12} monochrome className="text-accent" />
                    FalkorDB knowledge graph
                  </span>
                </div>
                <h2 className="text-center text-[26px] font-medium tracking-[-0.02em]">
                  Ask the <span className="text-brand-gradient">Company Brain</span>
                </h2>
                <p className="mb-6 mt-2 text-center text-[13px] text-fg-muted">
                  Try one of these — each one needs a different graph traversal:
                </p>
                <div className="flex flex-col gap-1.5 stagger [--stagger:45ms]">
                  {SUGGESTIONS.map((s) => (
                    <SpotlightCard
                      as="button"
                      key={s}
                      onClick={() => send(s)}
                      className="group flex items-center gap-2 rounded-md border border-border bg-bg-surface-100 px-3 py-2.5 text-left text-[12.5px] text-fg-secondary transition-colors hover:border-border-strong hover:text-fg"
                    >
                      <span className="flex-1">{s}</span>
                      <ArrowUpRight size={13} className="text-fg-faint transition-all duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-accent" />
                    </SpotlightCard>
                  ))}
                </div>
              </div>
            </>
          )}

          <div className="mx-auto max-w-3xl space-y-4">
            {messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="flex justify-end animate-fade-in-up">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-xl rounded-br-sm border border-border bg-bg-surface-200 px-4 py-2.5 text-[14px] leading-relaxed text-fg">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={m.id} className="flex gap-3 animate-fade-in-up">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center">
                  <OmniaMark size={22} animated={!!m.streaming} />
                </span>
                <div className="min-w-0 flex-1">
                  {m.agents && m.agents.length > 1 && (
                    <div className="mb-1.5 flex gap-1">
                      {m.agents.map((a) => (
                        <span
                          key={a}
                          className="rounded-full border border-border bg-bg-surface-200 px-2 py-0.5 font-mono text-[10px] text-fg-secondary"
                        >
                          {a}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="whitespace-pre-wrap text-[14px] leading-relaxed text-fg">
                    {m.content}
                    {m.streaming && (m.content ? <span className="stream-caret" aria-hidden /> : <span className="text-shine text-[13px]">Traversing the graph…</span>)}
                  </div>
                  {m.trace && m.trace.length > 0 && (
                    <ReasoningTrace trace={m.trace} defaultOpen={showReasoning} />
                  )}
                  {m.sources && m.sources.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {m.sources.slice(0, 10).map((s) => {
                        const id = s.includes(":") ? s.split(":").slice(1).join(":") : s;
                        return (
                          <button
                            key={s}
                            onClick={() => {
                              const node = graph.nodes.find((n) => n.id === id);
                              if (node) onNodeClick(node);
                            }}
                            className="rounded-md border border-border bg-bg-surface-200 px-1.5 py-0.5 font-mono text-[10px] text-fg-secondary transition-colors hover:border-brand/50 hover:text-accent"
                            title="Highlight this source in the graph"
                          >
                            {s}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                </div>
              ),
            )}
          </div>
        </div>

        <div className="p-3 pt-1">
          <div className={cn(
            "mx-auto flex max-w-3xl items-end gap-2 rounded-xl border border-border-strong bg-bg-surface-100 p-2 shadow-soft transition-[border-color,box-shadow] duration-300 hover:border-border-stronger focus-within:border-brand/50 focus-within:shadow-[0_0_0_4px_var(--accent-soft),var(--shadow-soft)]",
            busy && "beam-border",
          )}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              rows={2}
              placeholder="Ask about people, services, tickets, decisions…  (Enter to send)"
              className="flex-1 resize-none bg-transparent px-2 py-1.5 text-[14px] text-fg outline-none placeholder:text-fg-faint"
            />
            <Button variant="primary" className="group" onClick={() => send(input)} disabled={busy || !input.trim()}>
              {busy ? "Thinking…" : <>Send <ArrowUp size={13} className="transition-transform duration-300 group-hover:-translate-y-0.5" /></>}
            </Button>
          </div>
          {error && (
            <p className="mx-auto mt-2 max-w-3xl rounded-md border border-danger/30 bg-danger-soft px-3 py-1.5 text-[12px] text-danger animate-scale-in">
              {error}
            </p>
          )}
        </div>
      </section>

      {/* ---------------- graph panel ---------------- */}
      <aside className={cn("flex w-[460px] shrink-0 flex-col border-l border-border bg-bg-alternative animate-slide-in-right", view === "overview" && "hidden")}>
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3">
          <Segmented
            className="w-[280px]"
            value={tab}
            onChange={setTab}
            options={[
              { value: "graph", label: "Graph" },
              { value: "activity", label: "Agent activity" },
              { value: "memory", label: "Memory" },
            ]}
          />
          <label className="ml-auto flex items-center gap-2 text-[11.5px] text-fg-secondary">
            <Toggle checked={showReasoning} onChange={setShowReasoning} label="show trace" />
            trace
          </label>
        </div>

        {tab === "graph" && (
          <>
            <div className="relative h-[52%] border-b border-border bg-bg dot-grid">
              <GraphCanvas
                data={graph}
                highlight={highlight}
                traverse={traverse}
                onNodeClick={onNodeClick}
              />
            </div>
            <div className="border-b border-border p-3">
              <Legend
                labels={schema?.labels ?? []}
                active={highlight}
                onToggle={() => {}}
              />
              <p className="mt-2 text-[10.5px] text-fg-muted">
                <span className="font-mono text-fg-secondary">{graph.nodes.length}</span> nodes · <span className="font-mono text-fg-secondary">{graph.edges.length}</span> edges contributed to
                the last answer. Click a node to expand its neighbourhood.
              </p>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {detail ? (
                <NodeDetail key={detail.id} node={detail} />
              ) : (
                <p className="rounded-md border border-dashed border-border px-3 py-3 text-[11.5px] text-fg-muted">
                  Click any node to inspect its properties and neighbours.
                </p>
              )}
            </div>
          </>
        )}

        {tab === "activity" && (
          <div className="flex-1 overflow-y-auto p-3 animate-fade-in">
            {activity.length === 0 && (
              <p className="rounded-md border border-dashed border-border px-3 py-3 text-[11.5px] text-fg-muted">No agent activity yet for this session.</p>
            )}
            <AgentActivity activity={activity} />
          </div>
        )}

        {tab === "memory" && (
          <div className="flex-1 overflow-y-auto p-3 animate-fade-in">
            <Segmented
              className="mb-3"
              value={memView}
              onChange={setMemView}
              options={[
                { value: "memories", label: "Memories" },
                { value: "procedures", label: `Procedures (${procedures.filter((p) => p.learned).length} learned)` },
              ]}
            />
            {memView === "procedures" ? (
              <ProceduresPanel procedures={procedures} justLearned={justLearned} />
            ) : (
              <MemoryPanel memories={memories} stats={memStats} />
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

function NodeDetail({ node }: { node: GraphNode }) {
  const entries = Object.entries(node.properties || {}).filter(
    ([, v]) => v !== null && v !== undefined && typeof v !== "object",
  );
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-bg-surface-100 animate-fade-in-up">
      <div className="border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: nodeColor(node.label, node.color), boxShadow: `0 0 8px ${nodeColor(node.label, node.color)}` }}
          />
          <span className="text-[13.5px] font-medium">{node.name}</span>
          <span className="rounded-full border border-border bg-bg-surface-200 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-muted">
            {node.label}
          </span>
        </div>
        <p className="mt-1 truncate font-mono text-[10px] text-fg-muted">{node.id}</p>
      </div>
      <dl className="divide-y divide-border-muted">
        {entries.map(([k, v]) => (
          <div key={k} className="flex gap-2 px-3 py-1.5 text-[11.5px]">
            <dt className="w-28 shrink-0 font-mono text-[10.5px] text-fg-muted">{k}</dt>
            <dd className="min-w-0 flex-1 break-words text-fg-secondary">{String(v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
