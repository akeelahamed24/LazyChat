"use client";

import { useState } from "react";
import type { ActivityItem, MemoryNode, Procedure, TraceStep } from "@/lib/brainApi";

/**
 * The explainability surface: exactly which tool ran, which Cypher it executed,
 * how long it took, and what came back. Collapsible per step.
 */
export function ReasoningTrace({
  trace,
  defaultOpen = false,
}: {
  trace: TraceStep[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const total = trace.reduce((a, s) => a + (s.duration_ms ?? 0), 0);

  if (trace.length === 0) return null;

  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-border bg-bg-surface-100 animate-fade-in-up">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-fg-secondary transition-colors hover:bg-bg-hover"
      >
        <span className="flex items-center gap-1.5 font-medium text-fg">
          <span className={`inline-block text-fg-muted transition-transform duration-300 ${open ? "rotate-90" : ""}`}>▸</span>
          Reasoning trace
        </span>
        <span className="rounded-full border border-border bg-bg-surface-200 px-1.5 font-mono text-[10px] leading-4">
          {trace.length} tool call{trace.length === 1 ? "" : "s"}
        </span>
        <span className="rounded-full border border-border bg-bg-surface-200 px-1.5 font-mono text-[10px] leading-4 tabular-nums">
          {total.toFixed(1)}ms
        </span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-fg-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-brand" />
          grounded in FalkorDB
        </span>
      </button>

      {open && (
        <ol className="relative space-y-2 border-t border-border p-2 stagger [--stagger:40ms]">
          {trace.map((s, i) => (
            <li key={`${s.tool}-${i}`} className="rounded-md border border-border-muted bg-bg-elevated p-2.5">
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="rounded border border-brand/30 bg-accent-soft px-1.5 py-0.5 font-mono text-accent">
                  {i + 1}. {s.tool}
                </span>
                <span className="font-mono text-fg-muted">{s.row_count ?? 0} rows</span>
                <span className="font-mono text-fg-muted">{s.duration_ms ?? 0}ms</span>
                {s.error && (
                  <span className="rounded border border-danger/30 bg-danger-soft px-1.5 py-0.5 text-danger">
                    {s.error}
                  </span>
                )}
              </div>
              {s.arguments && Object.keys(s.arguments).length > 0 && (
                <div className="mt-1 font-mono text-[10px] text-fg-muted">
                  args {JSON.stringify(s.arguments)}
                </div>
              )}
              {s.result_summary && (
                <p className="mt-1 text-xs leading-snug text-fg">{s.result_summary}</p>
              )}
              {s.cypher && (
                <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap rounded-md border border-border-muted bg-bg-inset p-2 font-mono text-[10px] leading-relaxed text-fg-secondary">
                  {s.cypher}
                </pre>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Agent Activity panel: what each agent wrote to, and read from, the graph. */
export function AgentActivity({ activity }: { activity: ActivityItem[] }) {
  if (!activity || activity.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {activity.map((a, i) => (
        <div
          key={i}
          className={`rounded-md border p-2 text-[11px] animate-fade-in-up ${
            a.kind === "handoff"
              ? "border-brand/40 bg-accent-soft"
              : "border-border bg-bg-elevated"
          }`}
        >
          <div className="flex items-center gap-1.5">
            <span
              className={`rounded px-1.5 py-0.5 font-mono ${
                a.kind === "handoff" ? "border border-[color:var(--brand-button-border)] bg-[color:var(--brand-button)] text-[color:var(--brand-button-text)]" : "border border-border bg-bg-surface-200"
              }`}
            >
              {a.agent}
            </span>
            <span className="text-fg-muted">{a.kind}</span>
            {a.timestamp && (
              <span className="ml-auto text-[10px] text-fg-muted">
                {a.timestamp.slice(11, 19)}
              </span>
            )}
          </div>
          <p className="mt-1 leading-snug text-fg-secondary">{a.detail}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * Procedures the agent has written for itself.
 *
 * `learned` recipes were derived from tool calls that actually returned rows;
 * `seeded` ones ship with the project. Showing the split is the point — it is
 * the difference between "here is a hardcoded lookup table" and "here is
 * something the agent worked out".
 */
export function ProceduresPanel({
  procedures,
  justLearned,
}: {
  procedures: Procedure[];
  justLearned?: Procedure | null;
}) {
  if (!procedures || procedures.length === 0) {
    return (
      <p className="text-xs text-fg-muted">
        No procedures yet. Ask a question the graph can answer and the agent
        writes a recipe from the tools that worked.
      </p>
    );
  }
  const learned = procedures.filter((p) => p.learned);
  const seeded = procedures.filter((p) => !p.learned);

  const card = (p: Procedure) => (
    <div
      key={p.id}
      className={`rounded-md border p-2 ${
        justLearned?.id === p.id
          ? "border-brand/60 bg-accent-soft shadow-glow animate-scale-in"
          : "border-border bg-bg-elevated transition-colors hover:border-border-strong"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] ${
            p.learned ? "border border-[color:var(--brand-button-border)] bg-[color:var(--brand-button)] text-[color:var(--brand-button-text)]" : "border border-border bg-bg-surface-200 text-fg-muted"
          }`}
        >
          {p.learned ? "learned" : "seeded"}
        </span>
        {(p.uses ?? 0) > 0 && (
          <span className="text-[10px] text-fg-muted">
            used {p.uses}× · applied {p.applied ?? 0} · ok {p.successes ?? 0}
          </span>
        )}
        {justLearned?.id === p.id && (
          <span className="ml-auto flex items-center gap-1.5 text-[10px] text-accent"><span className="live-dot !h-1.5 !w-1.5" />just learned</span>
        )}
      </div>
      <p className="mt-1 text-[11px] font-medium text-fg">{p.task_pattern}</p>
      <p className="mt-1 text-[11px] italic leading-snug text-fg-secondary">{p.rationale}</p>
      {p.applies_when && (
        <p className="mt-1 text-[10px] leading-snug text-fg-secondary">
          <span className="font-medium text-success">applies when</span> {p.applies_when}
        </p>
      )}
      {p.avoid_when && (
        <p className="mt-0.5 text-[10px] leading-snug text-fg-secondary">
          <span className="font-medium text-danger">not when</span> {p.avoid_when}
        </p>
      )}
      <ol className="mt-1.5 space-y-0.5 border-t border-border pt-1.5">
        {(p.steps ?? []).map((s, i) => (
          <li key={i} className="font-mono text-[10px] leading-snug text-fg-secondary">
            {i + 1}. {s}
          </li>
        ))}
      </ol>
    </div>
  );

  return (
    <div className="space-y-2">
      {learned.length > 0 && (
        <div>
          <p className="eyebrow pb-1.5 !text-[10px]">
            Written by the agent ({learned.length})
          </p>
          <div className="space-y-1.5">{learned.map(card)}</div>
        </div>
      )}
      {seeded.length > 0 && (
        <div>
          <p className="eyebrow pb-1.5 !text-[10px]">
            Shipped with the project ({seeded.length})
          </p>
          <div className="space-y-1.5">{seeded.map(card)}</div>
        </div>
      )}
    </div>
  );
}

/** Memory panel: what this user has remembered across sessions. */
/** Keep the first occurrence of each memory id (React keys must be unique). */
function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((x) => !seen.has(x.id) && !!seen.add(x.id));
}

export function MemoryPanel({
  memories,
  stats,
  onPick,
}: {
  memories: MemoryNode[];
  stats?: Record<string, number>;
  onPick?: (id: string) => void;
}) {
  if (!memories || memories.length === 0) {
    return (
      <p className="text-xs text-fg-muted">
        No memory yet. Ask a few questions in this session — the agent
        consolidates what it learns into episodic and semantic memory.
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      {stats && Object.keys(stats).length > 0 && (
        <div className="flex gap-1.5">
          {Object.entries(stats).map(([k, v]) => (
            <span
              key={k}
              className="rounded-full border border-border bg-bg-surface-200 px-2 py-0.5 font-mono text-[10px] text-fg-secondary"
            >
              {k}: {v}
            </span>
          ))}
        </div>
      )}
      {uniqueById(memories).map((m) => (
        <button
          key={m.id}
          onClick={() => onPick?.(m.id)}
          className="lift block w-full rounded-md border border-border bg-bg-elevated p-2 text-left hover:border-border-strong hover:bg-bg-hover"
        >
          <div className="flex items-center gap-1.5">
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] ${
                m.kind === "episodic"
                  ? "border border-brand/30 bg-success-soft text-success"
                  : "border border-info/30 bg-info-soft text-info"
              }`}
            >
              {m.kind}
            </span>
            {m.timestamp && (
              <span className="ml-auto text-[10px] text-fg-muted">
                {m.timestamp.slice(0, 16).replace("T", " ")}
              </span>
            )}
          </div>
          <p className="mt-1 line-clamp-3 text-[11px] leading-snug text-fg-secondary">
            {m.summary}
          </p>
        </button>
      ))}
    </div>
  );
}
