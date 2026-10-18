"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { GraphEdge, GraphNode, SubGraph } from "@/lib/brainApi";

// react-force-graph touches `window` at import time, so it must not be part of
// the server bundle.
const ForceGraph2D = dynamic(
  () => import("react-force-graph-2d") as unknown as Promise<React.ComponentType<any>>,
  { ssr: false, loading: () => <div className="skeleton h-full w-full !rounded-none" /> },
);

type FgNode = GraphNode & { x?: number; y?: number; fx?: number; fy?: number };

type Props = {
  data: SubGraph;
  highlight?: Set<string>;
  /** Ids to pulse one after another — the traversal path of the last answer. */
  traverse?: string[];
  onNodeClick?: (node: GraphNode) => void;
  showLabels?: boolean;
};

import { nodeColor as paletteColor, relColor } from "@/lib/brain/palette";

/** Colour for a node label: the shared palette (lib/brain/palette.ts), falling back to the server-provided colour. */
export function nodeColor(label: string | undefined, fallback?: string): string {
  return paletteColor(label, fallback);
}

/** Theme colors read from CSS variables so canvas text follows light/dark. */
function readTheme() {
  if (typeof window === "undefined") return { text: "#ededed", muted: "#898989", line: "rgba(137,137,137,0.25)" };
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, f: string) => cs.getPropertyValue(n).trim() || f;
  return { text: v("--text-secondary", "#b4b4b4"), muted: v("--text-faint", "#4d4d4d"), line: "rgba(137,137,137,0.25)" };
}

export function GraphCanvas({
  data,
  highlight,
  traverse,
  onNodeClick,
  showLabels = true,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 600, h: 400 });
  const [pulseIndex, setPulseIndex] = useState(-1);
  const graphRef = useRef<any>(null);
  const themeRef = useRef(readTheme());

  // Re-read theme colors whenever the palette changes (data-theme flip or system preference).
  useEffect(() => {
    const refresh = () => {
      themeRef.current = readTheme();
      graphRef.current?.refresh?.();
    };
    const mo = new MutationObserver(refresh);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", refresh);
    return () => {
      mo.disconnect();
      mq.removeEventListener("change", refresh);
    };
  }, []);

  // react-force-graph mutates the node objects it is given; clone so the
  // caller's state is not corrupted across renders.
  const graphData = useMemo(() => {
    const nodes: FgNode[] = data.nodes.map((n) => ({ ...n }));
    const ids = new Set(nodes.map((n) => n.id));
    const links: GraphEdge[] = data.edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ ...e }));
    return { nodes, links };
  }, [data]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: Math.max(width, 200), h: Math.max(height, 200) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Walk the traversal path so the user sees the order the agent reasoned in.
  useEffect(() => {
    if (!traverse || traverse.length === 0) {
      setPulseIndex(-1);
      return;
    }
    setPulseIndex(0);
    const timer = setInterval(() => {
      setPulseIndex((i) => {
        if (i >= traverse.length - 1) {
          clearInterval(timer);
          return i;
        }
        return i + 1;
      });
    }, 420);
    return () => clearInterval(timer);
  }, [traverse]);

  const paint = useCallback(() => {
    const fg = graphRef.current;
    if (!fg) return;
    const ctx = fg?.ctx?.();
    if (!ctx) return;
    const theme = themeRef.current;

    // Edges
    const links = graphData.links as any[];
    for (const link of links) {
      const s = link.source as FgNode;
      const t = link.target as FgNode;
      if (s?.x == null || t?.x == null) continue;
      const active = highlight?.has(s.id) && highlight?.has(t.id);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.strokeStyle = active ? relColor(link.type) : theme.line;
      ctx.lineWidth = active ? 1.9 : 0.8;
      ctx.stroke();
    }

    // Nodes
    const nodes = graphData.nodes as FgNode[];
    nodes.forEach((node) => {
      if (node.x == null || node.y == null) return;
      const dim = highlight && highlight.size > 0 && !highlight.has(node.id);
      const pulsing = traverse?.[pulseIndex] === node.id;
      const r = pulsing ? 9 : node.label === "Service" ? 7 : 5.5;

      if (pulsing) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 6, 0, 2 * Math.PI);
        ctx.fillStyle = "rgba(62, 207, 142, 0.25)";
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = dim ? "rgba(137,137,137,0.3)" : nodeColor(node.label, node.color);
      ctx.fill();
      if (highlight?.has(node.id) && !dim) {
        ctx.strokeStyle = "#3ecf8e";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      if (showLabels && (!dim || size.w > 520)) {
        ctx.font = "10px 'JetBrains Mono', ui-monospace, monospace";
        ctx.fillStyle = dim ? theme.muted : theme.text;
        ctx.fillText(String(node.name).slice(0, 22), node.x + r + 3, node.y + 3);
      }
    });
  }, [graphData, highlight, traverse, pulseIndex, showLabels, size.w]);

  if (data.nodes.length === 0) {
    return (
      <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
        <div className="hero-backdrop" aria-hidden>
          <div className="hero-grid" />
        </div>
        <p className="relative z-10 rounded-md border border-dashed border-border-strong bg-bg-surface-100/80 px-4 py-2.5 text-[13px] text-fg-muted backdrop-blur animate-fade-in">
          No contributing subgraph yet — ask a question to populate it.
        </p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="h-full w-full">
      <ForceGraph2D
        ref={graphRef as any}
        width={size.w}
        height={size.h}
        graphData={graphData}
        backgroundColor="rgba(0,0,0,0)"
        nodeRelSize={4}
        linkColor={() => "rgba(137,137,137,0.3)"}
        linkWidth={1}
        cooldownTicks={90}
        d3AlphaDecay={0.04}
        d3VelocityDecay={0.3}
        nodeCanvasObjectMode={() => () => paint()}
        linkCanvasObjectMode={() => () => paint()}
        onNodeClick={(node: FgNode) => onNodeClick?.(node)}
        onNodeHover={(node: FgNode | null) => {
          if (containerRef.current) {
            containerRef.current.style.cursor = node ? "pointer" : "default";
          }
        }}
      />
    </div>
  );
}

export function Legend({
  labels,
  active,
  onToggle,
}: {
  labels: { label: string; color: string }[];
  active?: Set<string>;
  onToggle?: (label: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {labels.map((l) => (
        <button
          key={l.label}
          onClick={() => onToggle?.(l.label)}
          className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10.5px] transition-all duration-200 ${
            active && active.size > 0 && !active.has(l.label)
              ? "border-border text-fg-muted opacity-40 hover:opacity-70"
              : "border-border-strong bg-bg-surface-200 text-fg-secondary hover:border-border-stronger hover:text-fg"
          }`}
        >
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: nodeColor(l.label, l.color), boxShadow: `0 0 6px ${nodeColor(l.label, l.color)}` }}
            aria-hidden
          />
          {l.label}
        </button>
      ))}
    </div>
  );
}
