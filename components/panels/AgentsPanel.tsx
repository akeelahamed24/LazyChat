"use client";

import * as React from "react";
import { useEffect, useRef, useState } from "react";
import {
  Bot,
  X,
  Play,
  Square,
  Terminal,
  ChevronDown,
  ChevronRight,
  Monitor,
  Globe,
} from "lucide-react";
import { cn, Button, Badge, IconButton, Spinner } from "@/components/ui";
import { useAppStore, modelLabel, providerGlyph } from "@/lib/app-store";
import type { AgentMeta, ProviderId } from "@/lib/types";
import { BrandIcon, BrandTile, modelIconKey, providerIconKey } from "@/components/brand/BrandIcon";
import { FileIcon } from "@/components/brand/FileIcon";


const STATUS_TONE: Record<string, "neutral" | "info" | "success" | "danger" | "warning"> = {
  queued: "neutral",
  starting: "info",
  running: "info",
  done: "success",
  failed: "danger",
  stopped: "warning",
};

export function AgentsPanel() {
  const agents = useAppStore((s) => s.agents);
  const setAgents = useAppStore((s) => s.setAgents);
  const setPanel = useAppStore((s) => s.setPanel);
  const [showFinished, setShowFinished] = React.useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const res = await fetch("/api/agents", { cache: "no-store" });
        if (res.ok && !cancelled) {
          setAgents(await res.json());
        }
      } catch {
      }
      if (!cancelled) timer = setTimeout(poll, 2500);
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [setAgents]);

  const running = agents
    .filter((a) => ["queued", "starting", "running"].includes(a.status))
    .sort((a, b) => b.createdAt - a.createdAt);
  const finished = agents
    .filter((a) => ["done", "failed", "stopped"].includes(a.status))
    .sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-bg-surface-200 text-accent">
          <Bot size={14} />
        </span>
        <h2 className="flex-1 text-[13.5px] font-medium text-fg">Agents</h2>
        <Badge tone={running.length ? "accent" : "neutral"}>
          {running.length > 0 && <span className="live-dot !h-1.5 !w-1.5" />}
          {running.length} running
        </Badge>
        <IconButton onClick={() => setPanel(null)} title="Close panel">
          <X size={16} />
        </IconButton>
      </div>

      <div className="flex min-h-0 flex-1 flex-col space-y-2 overflow-y-auto p-2.5">
        <SpawnAgent />
        {agents.length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-6 text-center text-[13px] text-fg-muted animate-fade-in-up">
            <BrandIcon name="docker" size={22} />
            No agents yet. Ask the model to run a task, or spawn one above.
          </div>
        )}
        {running.map((a) => (
          <AgentCard key={a.id} agent={a} />
        ))}
        {finished.length > 0 && (
          <div>
            <button
              onClick={() => setShowFinished(!showFinished)}
              className="eyebrow flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors hover:bg-bg-hover hover:text-fg-secondary"
            >
              {showFinished ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              Completed ({finished.length})
            </button>
            {showFinished &&
              finished.map((a) => <AgentCard key={a.id} agent={a} />)}
          </div>
        )}
      </div>
    </div>
  );
}


function SpawnAgent() {
  const [task, setTask] = useState("");
  const [provider, setProvider] = useState<ProviderId>("");
  const [engine, setEngine] = useState<"tool-loop" | "agent-sdk">("tool-loop");
  const [research, setResearch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const customProviders = useAppStore((s) => s.customProviders);

  const agentProviders = React.useMemo(() => {
    const builtins: ProviderId[] = ["opencode", "anthropic", "openai", "sarvam", "nvidia", "google", "ollama", "lmstudio"];
    const customs = customProviders.map((c) => c.id);
    return [...customs, ...builtins];
  }, [customProviders]);

  const autoProvider = (): ProviderId =>
    customProviders[0]?.id || "anthropic";

  const providerLabel = (id: ProviderId) => {
    const c = customProviders.find((x) => x.id === id);
    if (c) return `${c.glyph || "◆"} ${c.name}`;
    return `${providerGlyph(id)} ${id}`;
  };

  const spawn = async () => {
    if (!task.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const useProvider = provider || autoProvider();
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          task: task.trim(),
          provider: useProvider,
          engine,
          research,
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "spawn failed");
      }
      setTask("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-bg-surface-100 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="eyebrow flex items-center gap-1.5">
          <BrandTile name={providerIconKey(provider || autoProvider(), customProviders.find((c) => c.id === (provider || autoProvider()))?.baseUrl)} size={18} />
          Spawn an agent
        </span>
        <div className="flex gap-1">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as ProviderId)}
            className="h-7 rounded-md border border-border-strong bg-bg-control px-2 text-[12px] text-fg transition-[border-color,box-shadow] duration-200 hover:border-border-stronger focus:outline-none focus:border-brand/60 focus:shadow-[0_0_0_3px_var(--accent-soft)]"
            title="Which provider runs the agent (Auto picks your first configured provider)"
          >
            <option value="">Auto · {autoProvider()}</option>
            {agentProviders.map((p) => (
              <option key={p} value={p}>
                {providerLabel(p)}
              </option>
            ))}
          </select>
          <select
            value={engine}
            onChange={(e) => setEngine(e.target.value as any)}
            className="h-7 rounded-md border border-border-strong bg-bg-control px-2 text-[12px] text-fg transition-[border-color,box-shadow] duration-200 hover:border-border-stronger focus:outline-none focus:border-brand/60 focus:shadow-[0_0_0_3px_var(--accent-soft)]"
          >
            <option value="tool-loop">tool loop</option>
            <option value="agent-sdk">agent SDK</option>
          </select>
          <button
            type="button"
            onClick={() => setResearch(!research)}
            title={
              research
                ? "Research mode ON — agent opens pages in a live Chromium browser"
                : "Research mode OFF — plain agent"
            }
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium transition-all duration-200 active:scale-95",
              research
                ? "border-brand/40 bg-accent-soft text-accent shadow-[0_0_12px_-4px_var(--accent-glow)]"
                : "border-border text-fg-muted hover:border-border-strong hover:text-fg-secondary",
            )}
          >
            <BrandIcon name="chrome" size={13} className={research ? "" : "opacity-70 grayscale"} fallback={<Globe size={13} />} />
            Research
          </button>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <input
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && spawn()}
          placeholder={
            research
              ? "What should the agent research? (e.g. compare current GPU prices and save a briefing to /workspace/out/briefing.md)"
              : "What should the agent do? (e.g. build a PDF report in /workspace/out)"
          }
          className="flex-1 rounded-md border border-border-strong bg-bg-control transition-[border-color,box-shadow] duration-200 hover:border-border-stronger px-2.5 py-1.5 text-[13px] text-fg placeholder:text-fg-faint focus:outline-none focus:border-brand/60 focus:shadow-[0_0_0_3px_var(--accent-soft)]"
        />
        <Button variant="primary" onClick={spawn} disabled={busy || !task.trim()}>
          {busy ? <Spinner size={14} /> : <Play size={14} />}
          Run
        </Button>
      </div>
      {research && (
        <p className="mt-2 rounded-md border border-brand/25 bg-accent-soft px-2.5 py-1.5 text-[11.5px] leading-snug text-accent animate-fade-in-up">
          Research mode — the agent will search the web and actually open the
          pages in a live Chromium browser (screenshots stream in), then save a
          cited briefing.
        </p>
      )}
      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
    </div>
  );
}


function AgentCard({ agent }: { agent: AgentMeta }) {
  const [open, setOpen] = React.useState(
    agent.status === "running" || agent.status === "starting",
  );
  const setActiveSandbox = useAppStore((s) => s.setActiveSandbox);
  const setPanel = useAppStore((s) => s.setPanel);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [agent.log.length, open]);

  const running = ["queued", "starting", "running"].includes(agent.status);
  const logs = agent.log.slice(-60);

  return (
    <div className={cn("overflow-hidden rounded-lg border border-border bg-bg-surface-100 transition-colors hover:border-border-strong animate-fade-in-up", running && "beam-border")}>
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span className="relative">
          <BrandTile
            name={modelIconKey(agent.model, agent.provider)}
            size={32}
            fallback={running ? <Spinner size={14} className="text-accent" /> : <Terminal size={14} className="text-fg-muted" />}
          />
          {running && (
            <span className="absolute -bottom-0.5 -right-0.5 flex rounded-full ring-2 ring-bg-surface-100">
              <span className="live-dot !h-2 !w-2" />
            </span>
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-fg">
            {agent.label}
          </p>
          <p className="flex items-center gap-1 truncate text-[11px] text-fg-muted">
            <BrandIcon
              name={providerIconKey(agent.provider)}
              size={11}
              fallback={<span>{providerGlyph(agent.provider)}</span>}
            />
            {modelLabel(agent.provider, agent.model)} ·{" "}
            <span className="font-mono">{agent.engine}</span>
          </p>
        </div>
        <Badge tone={STATUS_TONE[agent.status] || "neutral"}>{agent.status}</Badge>
        {running && agent.sandboxId && (
          <IconButton
            title="Open sandbox screen"
            onClick={() => {
              setActiveSandbox(agent.sandboxId!);
              setPanel("sandbox");
            }}
          >
            <Monitor size={14} />
          </IconButton>
        )}
        {running && (
          <IconButton
            title="Stop agent"
            onClick={() => void fetch(`/api/agents/${agent.id}`, { method: "DELETE" })}
          >
            <Square size={13} />
          </IconButton>
        )}
        <IconButton title={open ? "Collapse" : "Expand"} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </IconButton>
      </div>

      {running && (
        <div className="px-3 pb-1">
          <div className="h-1 overflow-hidden rounded-full bg-bg-surface-300">
            <div
              className="h-full rounded-full bg-gradient-to-r from-brand-600 via-brand to-[#8fe5bc] bg-[length:200%_100%] transition-all duration-700 [animation:border-flow_2s_linear_infinite]"
              style={{ width: `${Math.max(3, agent.progress)}%` }}
            />
          </div>
        </div>
      )}

      {open && (
        <div className="border-t border-border animate-fade-in">
          <div className="px-3 pt-2.5">
            <p className="text-[12.5px] leading-relaxed text-fg-secondary line-clamp-3">
              {agent.task}
            </p>
          </div>
          <div
            ref={logRef}
            className="mx-3 mt-2 max-h-44 overflow-y-auto rounded-md border border-white/[0.06] bg-[#0f0f0f] p-2.5 font-mono text-[11px] leading-relaxed"
          >
            {logs.length === 0 && <p className="text-white/40">Waiting for events…</p>}
            {logs.map((l, i) => (
              <pre
                key={i}
                className={cn(
                  "whitespace-pre-wrap",
                  l.level === "error"
                    ? "text-[#f56e4e]"
                    : l.level === "tool"
                      ? "text-[#52a9ff]"
                      : l.level === "thinking"
                        ? "text-[#8fe5bc]"
                        : l.level === "file"
                          ? "text-[#3ecf8e]"
                          : "text-white/80",
                )}
              >
                <span className="text-white/35">
                  {new Date(l.t).toLocaleTimeString([], { hour12: false })}
                </span>{" "}
                {l.message}
              </pre>
            ))}
          </div>
          {agent.resultFiles.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 py-2.5">
              {agent.resultFiles.map((f, i) => (
                <a
                  key={i}
                  href={`/api/files/${f.id}/${f.filename}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="lift inline-flex items-center gap-2 rounded-md border border-border bg-bg-surface-200 py-1 pl-1.5 pr-2.5 text-[12px] text-fg-secondary hover:border-border-strong hover:text-fg"
                >
                  <FileIcon type={f.filename} size={20} />
                  {f.title}
                </a>
              ))}
            </div>
          )}
          {agent.error && (
            <p className="px-3 pb-2.5 text-[12px] text-danger">{agent.error}</p>
          )}
        </div>
      )}
    </div>
  );
}
