"use client";

import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Eye, EyeOff, Maximize2, RefreshCw, Search, X } from "lucide-react";
import { api, type Overview, type OverviewNode } from "@/lib/brainApi";
import { groupOf, nodeColor, prettyLabel, relColor } from "@/lib/brain/palette";
import { Button, cn } from "@/components/ui";

type FgNode = OverviewNode & { x?: number; y?: number };
type FgLink = { source: FgNode | string; target: FgNode | string; type: string };

const GROUPS = ["Company", "Workspaces", "Memory & chats"] as const;

function readTheme() {
  if (typeof window === "undefined") return { text: "#ededed", halo: "#171717", muted: "#898989" };
  const body = getComputedStyle(document.body);
  // Use the page's own text and background colours so labels stay readable in light and dark themes.
  return { text: body.color || "#171717", halo: body.backgroundColor || "#ffffff", muted: "#898989" };
}

/** The whole graph at a glance: colour by type, size by connections, labelled hubs, searchable, filterable. */
export function OverviewGraph({ onClose }: { onClose?: () => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [labelMode, setLabelMode] = useState<"auto" | "all" | "none">("auto");
  const [edgeLabels, setEdgeLabels] = useState(true);
  const [legendOpen, setLegendOpen] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [FG, setFG] = useState<React.ComponentType<any> | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<any>(null);
  const themeRef = useRef(readTheme());
  const fitted = useRef(false);

  // react-force-graph touches `window` at import time: load it on the client only (and keep the ref working).
  useEffect(() => {
    void import("react-force-graph-2d").then((m) => setFG(() => m.default as unknown as React.ComponentType<any>));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      fitted.current = false;
      setData(await api.overview());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the graph");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.max(300, e.contentRect.width), h: Math.max(300, e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const refresh = () => {
      themeRef.current = readTheme();
      fgRef.current?.refresh?.();
    };
    const mo = new MutationObserver(refresh);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => mo.disconnect();
  }, []);

  // ---- derived data ----------------------------------------------------------------------------------------------
  const labels = useMemo(() => {
    const counts = data?.counts ?? {};
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  }, [data]);

  const graph = useMemo(() => {
    if (!data) return { nodes: [] as FgNode[], links: [] as FgLink[] };
    const nodes: FgNode[] = data.nodes.filter((n) => !hidden.has(n.label)).map((n) => ({ ...n }));
    const ids = new Set(nodes.map((n) => n.id));
    const links: FgLink[] = data.edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({ ...e }));
    return { nodes, links };
  }, [data, hidden]);

  const neighbours = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of graph.links) {
      const s = typeof e.source === "string" ? e.source : e.source.id;
      const t = typeof e.target === "string" ? e.target : e.target.id;
      (m.get(s) ?? m.set(s, new Set()).get(s)!).add(t);
      (m.get(t) ?? m.set(t, new Set()).get(t)!).add(s);
    }
    return m;
  }, [graph]);

  const hubCutoff = useMemo(() => {
    const d = graph.nodes.map((n) => n.degree).sort((a, b) => b - a);
    return d.length ? Math.max(6, d[Math.floor(d.length * 0.1)] ?? 6) : 6;
  }, [graph.nodes]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return new Set<string>();
    return new Set(graph.nodes.filter((n) => n.name.toLowerCase().includes(q) || n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)).map((n) => n.id));
  }, [graph.nodes, query]);

  const focusId = hoverId ?? selectedId;
  const focusSet = useMemo(() => {
    if (!focusId) return null;
    return new Set([focusId, ...(neighbours.get(focusId) ?? [])]);
  }, [focusId, neighbours]);

  const selected = useMemo(() => data?.nodes.find((n) => n.id === selectedId) ?? null, [data, selectedId]);
  const connections = useMemo(() => {
    if (!selected || !data) return [];
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    return data.edges
      .filter((e) => e.source === selected.id || e.target === selected.id)
      .map((e) => {
        const out = e.source === selected.id;
        const other = byId.get(out ? e.target : e.source);
        return other ? { rel: e.type, out, other } : null;
      })
      .filter((x): x is { rel: string; out: boolean; other: OverviewNode } => !!x);
  }, [selected, data]);

  // ---- graph tuning -----------------------------------------------------------------------------------------------
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !FG) return;
    fg.d3Force?.("charge")?.strength(-170).distanceMax?.(260);
    fg.d3Force?.("link")?.distance(58);
    fg.d3Force?.("center")?.strength?.(0.04);
  }, [FG, graph]);

  // Fit to the connected part of the graph: isolated nodes drift away and would shrink everything else.
  const fit = useCallback(() => fgRef.current?.zoomToFit?.(500, 60, (n: FgNode) => n.degree > 0), []);

  // The canvas size settles after the first paint and the layout keeps moving for a moment: re-fit until the user
  // has taken over with the mouse, so the whole graph always fills the view.
  const touched = useRef(false);
  useEffect(() => {
    if (!graph.nodes.length || touched.current) return;
    const t = [900, 2200, 4200].map((ms) => setTimeout(() => !touched.current && fit(), ms));
    return () => t.forEach(clearTimeout);
  }, [graph.nodes.length, size.w, size.h, fit]);
  const centerOn = useCallback((id: string, zoom = 3) => {
    const n = graph.nodes.find((x) => x.id === id);
    if (n?.x != null && n?.y != null) {
      fgRef.current?.centerAt?.(n.x, n.y, 600);
      fgRef.current?.zoom?.(zoom, 600);
    }
  }, [graph.nodes]);

  useEffect(() => {
    if (matches.size) centerOn([...matches][0], 2.4);
  }, [matches, centerOn]);

  const radius = (n: FgNode) => 3.6 + Math.min(9, Math.sqrt(n.degree) * 1.8);

  const drawNode = useCallback(
    (n: FgNode, ctx: CanvasRenderingContext2D, scale: number) => {
      if (n.x == null || n.y == null) return;
      const theme = themeRef.current;
      const r = radius(n);
      const inFocus = !focusSet || focusSet.has(n.id);
      const isMatch = matches.has(n.id);
      const dimmed = (!inFocus && !isMatch) || (matches.size > 0 && !isMatch && !(focusSet?.has(n.id)));
      const color = nodeColor(n.label, n.color);

      ctx.globalAlpha = dimmed ? 0.13 : 1;
      if (n.id === selectedId || n.id === hoverId || isMatch) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 4, 0, 2 * Math.PI);
        ctx.fillStyle = color + "40";
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = n.id === selectedId ? 2 : 1;
      ctx.strokeStyle = n.id === selectedId ? theme.text : theme.halo;
      ctx.stroke();

      const showLabel =
        labelMode === "all" ||
        (labelMode === "auto" && (n.degree >= hubCutoff || scale >= 1.7 || isMatch || n.id === selectedId || n.id === hoverId || (focusSet?.has(n.id) && !!focusId)));
      if (showLabel) {
        const fs = Math.max(11 / scale, 2.4);
        ctx.font = `${n.degree >= hubCutoff ? 600 : 500} ${fs}px Inter, ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const text = n.name.length > 30 && scale < 2.5 ? n.name.slice(0, 29) + "…" : n.name;
        ctx.lineWidth = 3 / scale;
        ctx.strokeStyle = theme.halo;
        ctx.strokeText(text, n.x, n.y + r + 1.5 / scale);
        ctx.fillStyle = theme.text;
        ctx.fillText(text, n.x, n.y + r + 1.5 / scale);
      }
      ctx.globalAlpha = 1;
    },
    [focusSet, matches, selectedId, hoverId, labelMode, hubCutoff, focusId],
  );

  const drawLink = useCallback(
    (l: FgLink, ctx: CanvasRenderingContext2D, scale: number) => {
      const s = l.source as FgNode;
      const t = l.target as FgNode;
      if (typeof s !== "object" || typeof t !== "object" || s.x == null || t.x == null) return;
      const active = !!focusSet && focusSet.has(s.id) && focusSet.has(t.id) && (s.id === focusId || t.id === focusId);
      const dimmed = (!!focusSet && !active) || (matches.size > 0 && !(matches.has(s.id) || matches.has(t.id)));
      const color = relColor(l.type);
      ctx.globalAlpha = dimmed ? 0.05 : active ? 0.95 : 0.3;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y!);
      ctx.lineTo(t.x, t.y!);
      ctx.strokeStyle = color;
      ctx.lineWidth = (active ? 1.8 : 0.7) / Math.sqrt(scale);
      ctx.stroke();

      if (active || scale > 2.6) {
        // arrow head near the target
        const ang = Math.atan2(t.y! - s.y!, t.x - s.x);
        const tr = radius(t) + 2;
        const ax = t.x - Math.cos(ang) * tr;
        const ay = t.y! - Math.sin(ang) * tr;
        const sz = 4 / Math.sqrt(scale);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - sz * Math.cos(ang - 0.45), ay - sz * Math.sin(ang - 0.45));
        ctx.lineTo(ax - sz * Math.cos(ang + 0.45), ay - sz * Math.sin(ang + 0.45));
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      }
      if (edgeLabels && (active || scale > 3.2)) {
        const mx = (s.x + t.x) / 2;
        const my = (s.y! + t.y!) / 2;
        const fs = Math.max(9 / scale, 2);
        ctx.font = `600 ${fs}px Inter, ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const text = l.type.toLowerCase().replace(/_/g, " ");
        ctx.lineWidth = 3 / scale;
        ctx.strokeStyle = themeRef.current.halo;
        ctx.strokeText(text, mx, my);
        ctx.fillStyle = color;
        ctx.fillText(text, mx, my);
      }
      ctx.globalAlpha = 1;
    },
    [focusSet, focusId, matches, edgeLabels],
  );

  const toggleLabel = (l: string) => setHidden((h) => (h.has(l) ? new Set([...h].filter((x) => x !== l)) : new Set([...h, l])));
  const toggleGroup = (g: string) => {
    const inGroup = labels.filter((l) => groupOf(l) === g);
    const allHidden = inGroup.every((l) => hidden.has(l));
    setHidden((h) => {
      const next = new Set(h);
      for (const l of inGroup) allHidden ? next.delete(l) : next.add(l);
      return next;
    });
  };

  const relEntries = Object.entries(data?.relationCounts ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <div className="flex h-full w-full overflow-hidden bg-bg text-fg">
      {/* ------------- canvas ------------- */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="glass flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
          <span className="text-[13.5px] font-medium">Overview</span>
          {data && (
            <span className="font-mono text-[11px] text-fg-muted">
              {graph.nodes.length}/{data.nodes.length} nodes · {graph.links.length} edges · {labels.length} types
              {data.truncated ? " · truncated" : ""}
            </span>
          )}
          <div className="relative ml-auto w-56 max-w-full">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a node…"
              className="h-8 w-full rounded-md border border-border bg-bg-surface-100 pl-8 pr-7 text-[12.5px] outline-none focus:border-border-strong"
            />
            {query && (
              <button className="absolute right-1.5 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg" onClick={() => setQuery("")} aria-label="Clear search">
                <X size={13} />
              </button>
            )}
          </div>
          <select
            value={labelMode}
            onChange={(e) => setLabelMode(e.target.value as typeof labelMode)}
            className="h-8 rounded-md border border-border bg-bg-surface-100 px-2 text-[12px]"
            aria-label="Node labels"
          >
            <option value="auto">Labels: hubs + zoom</option>
            <option value="all">Labels: all</option>
            <option value="none">Labels: none</option>
          </select>
          <Button size="sm" variant="secondary" onClick={() => setEdgeLabels((v) => !v)} title="Relationship names on hover/zoom">
            {edgeLabels ? <Eye size={13} /> : <EyeOff size={13} />} Relations
          </Button>
          <Button size="sm" variant="secondary" onClick={fit} title="Fit to screen">
            <Maximize2 size={13} /> Fit
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
          </Button>
          {onClose && (
            <Button size="sm" variant="primary" onClick={onClose}>
              Back to Ask
            </Button>
          )}
        </div>

        <div ref={boxRef} className="relative min-h-0 flex-1 dot-grid" onWheel={() => (touched.current = true)} onPointerDown={() => (touched.current = true)}>
          {error && (
            <div className="absolute inset-0 z-10 flex items-center justify-center p-6">
              <div className="max-w-md rounded-lg border border-danger/30 bg-danger-soft p-4 text-[13px] text-danger">
                {error}
                <div className="mt-3">
                  <Button size="sm" variant="secondary" onClick={() => void load()}>
                    Retry
                  </Button>
                </div>
              </div>
            </div>
          )}
          {!error && data && data.nodes.length === 0 && (
            <div className="absolute inset-0 z-10 flex items-center justify-center p-6 text-center text-[13px] text-fg-muted">
              The graph is empty. Load the company data with <code className="mx-1 font-mono">npx tsx scripts/brain-seed.ts</code>.
            </div>
          )}
          {(loading && !data) || !FG ? <div className="skeleton h-full w-full !rounded-none" /> : null}
          {FG && data && graph.nodes.length > 0 && (
            <FG
              ref={fgRef}
              width={size.w}
              height={size.h}
              graphData={graph}
              backgroundColor="rgba(0,0,0,0)"
              nodeRelSize={4}
              nodeCanvasObjectMode={() => "replace"}
              nodeCanvasObject={drawNode}
              nodePointerAreaPaint={(n: FgNode, color: string, ctx: CanvasRenderingContext2D) => {
                if (n.x == null || n.y == null) return;
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(n.x, n.y, radius(n) + 3, 0, 2 * Math.PI);
                ctx.fill();
              }}
              linkCanvasObjectMode={() => "replace"}
              linkCanvasObject={drawLink}
              cooldownTicks={220}
              d3AlphaDecay={0.03}
              d3VelocityDecay={0.32}
              onEngineStop={() => {
                if (!fitted.current) {
                  fitted.current = true;
                  fit();
                }
              }}
              onNodeHover={(n: FgNode | null) => {
                setHoverId(n?.id ?? null);
                if (boxRef.current) boxRef.current.style.cursor = n ? "pointer" : "default";
              }}
              onNodeClick={(n: FgNode) => setSelectedId((cur) => (cur === n.id ? null : n.id))}
              onBackgroundClick={() => setSelectedId(null)}
            />
          )}

          {/* legend */}
          {data && (
            <div className="pointer-events-none absolute left-3 top-3 z-10 max-h-[calc(100%-24px)] w-56 overflow-y-auto">
              <div className="pointer-events-auto rounded-lg border border-border bg-bg-alternative/90 p-2.5 shadow-soft backdrop-blur">
                <div className={cn("flex items-center justify-between", legendOpen && "mb-1.5")}>
                  <button className="font-mono text-[10px] uppercase tracking-wider text-fg-muted hover:text-fg" onClick={() => setLegendOpen((v) => !v)} aria-expanded={legendOpen}>
                    {legendOpen ? "▾" : "▸"} Node types
                  </button>
                  <span className={cn("flex gap-1.5 text-[10.5px]", !legendOpen && "hidden")}>
                    <button className="text-fg-muted hover:text-fg" onClick={() => setHidden(new Set())}>
                      all
                    </button>
                    <button className="text-fg-muted hover:text-fg" onClick={() => setHidden(new Set(labels))}>
                      none
                    </button>
                  </span>
                </div>
                {legendOpen && GROUPS.map((g) => {
                  const inGroup = labels.filter((l) => groupOf(l) === g);
                  if (!inGroup.length) return null;
                  return (
                    <div key={g} className="mb-1.5">
                      <button className="mb-0.5 text-[10.5px] font-medium uppercase tracking-wide text-fg-secondary hover:text-fg" onClick={() => toggleGroup(g)}>
                        {g}
                      </button>
                      {inGroup.map((l) => (
                        <button
                          key={l}
                          onClick={() => toggleLabel(l)}
                          className={cn("flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[12px] transition-opacity hover:bg-bg-hover", hidden.has(l) && "opacity-35")}
                        >
                          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: nodeColor(l), boxShadow: `0 0 6px ${nodeColor(l)}80` }} />
                          <span className="flex-1 truncate">{prettyLabel(l)}</span>
                          <span className="font-mono text-[10.5px] text-fg-muted">{data.counts[l]}</span>
                        </button>
                      ))}
                    </div>
                  );
                })}
                {legendOpen && relEntries.length > 0 && (
                  <details className="mt-1 border-t border-border pt-1.5">
                    <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wider text-fg-muted">Relationships ({relEntries.length})</summary>
                    <div className="mt-1">
                      {relEntries.map(([r, n]) => (
                        <div key={r} className="flex items-center gap-2 py-0.5 text-[11px]">
                          <span className="h-0.5 w-4 shrink-0 rounded" style={{ background: relColor(r) }} />
                          <span className="flex-1 truncate">{r.toLowerCase().replace(/_/g, " ")}</span>
                          <span className="font-mono text-[10px] text-fg-muted">{n}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            </div>
          )}
          {matches.size > 0 && (
            <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-bg-alternative/90 px-3 py-1 text-[11.5px] shadow-soft backdrop-blur">
              {matches.size} match{matches.size === 1 ? "" : "es"}
            </div>
          )}
        </div>
      </div>

      {/* ------------- details ------------- */}
      <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-bg-alternative">
        <div className="flex h-12 shrink-0 items-center border-b border-border px-3 text-[13px] font-medium">{selected ? "Node details" : "Selection"}</div>
        <div className="flex-1 overflow-y-auto p-3">
          {!selected && (
            <p className="rounded-md border border-dashed border-border px-3 py-3 text-[12px] text-fg-muted">
              Click a node to see its properties and connections. Hover to light up its neighbourhood. Use the legend to hide or show node types, and the
              search box to find and centre a node.
            </p>
          )}
          {selected && (
            <div className="space-y-3 animate-fade-in-up">
              <div className="rounded-lg border border-border bg-bg-surface-100 p-3">
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: nodeColor(selected.label), boxShadow: `0 0 8px ${nodeColor(selected.label)}` }} />
                  <span className="min-w-0 flex-1 break-words text-[13.5px] font-medium">{selected.name}</span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="rounded-full border border-border bg-bg-surface-200 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-muted">{prettyLabel(selected.label)}</span>
                  <span className="font-mono text-[10.5px] text-fg-muted">{selected.degree} connections</span>
                  <button className="ml-auto text-fg-muted hover:text-fg" title="Centre on node" onClick={() => centerOn(selected.id)}>
                    <Crosshair size={14} />
                  </button>
                </div>
                <p className="mt-1.5 truncate font-mono text-[10px] text-fg-muted">{selected.id}</p>
              </div>

              <div className="overflow-hidden rounded-lg border border-border bg-bg-surface-100">
                <dl className="divide-y divide-border-muted">
                  {Object.entries(selected.properties ?? {})
                    .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
                    .map(([k, v]) => (
                      <div key={k} className="flex gap-2 px-3 py-1.5 text-[11.5px]">
                        <dt className="w-24 shrink-0 font-mono text-[10.5px] text-fg-muted">{k}</dt>
                        <dd className="min-w-0 flex-1 break-words text-fg-secondary">{String(v)}</dd>
                      </div>
                    ))}
                </dl>
              </div>

              {connections.length > 0 && (
                <div>
                  <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-fg-muted">Connections ({connections.length})</p>
                  <div className="space-y-1">
                    {connections.slice(0, 60).map((c, i) => (
                      <button
                        key={`${c.rel}-${c.other.id}-${i}`}
                        onClick={() => {
                          setSelectedId(c.other.id);
                          centerOn(c.other.id);
                        }}
                        className="flex w-full items-center gap-2 rounded-md border border-border bg-bg-surface-100 px-2 py-1.5 text-left text-[11.5px] hover:border-border-strong"
                      >
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: nodeColor(c.other.label) }} />
                        <span className="min-w-0 flex-1 truncate">{c.other.name}</span>
                        <span className="shrink-0 font-mono text-[9.5px] uppercase" style={{ color: relColor(c.rel) }}>
                          {c.out ? "→" : "←"} {c.rel.toLowerCase().replace(/_/g, " ")}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
