"use client";

import * as React from "react";
import { useState } from "react";
import { AlertTriangle, ChevronDown, LayoutDashboard } from "lucide-react";
import { Badge } from "@/components/ui";
import { PrefabView } from "@/components/genui/PrefabView";
import { useGenuiEnvelope } from "@/components/genui/useGenuiEnvelope";
import { sendFromGenUi } from "@/lib/genui/bus";
import { coerceUi } from "@/lib/genui/partial";

/** Inline card for the render_ui tool: the Prefab UI streams in while the model writes it. */
export function GenUiCard({
  args,
  result,
  streaming,
  errorText,
}: {
  args?: Record<string, any>;
  result?: any;
  streaming: boolean;
  errorText?: string;
}) {
  const [showJson, setShowJson] = useState(false);
  const invalid = result?.ok === false;
  const envelope = useGenuiEnvelope(args?.ui, streaming);
  const title: string | undefined = typeof args?.title === "string" ? args.title : undefined;

  if (errorText) {
    return (
      <div className="my-2 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">
        <AlertTriangle size={14} /> Could not build the interface: {errorText}
      </div>
    );
  }

  // A rejected UI collapses to a short note; the model repairs it in its next call.
  if (invalid) {
    const errors: string[] = Array.isArray(result?.errors) ? result.errors : [];
    return (
      <div className="my-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-[13px]">
        <button className="flex w-full items-center gap-2 text-left" onClick={() => setShowJson((v) => !v)}>
          <AlertTriangle size={14} className="text-warning" />
          <span className="flex-1">The interface had {errors.length} issue{errors.length === 1 ? "" : "s"} - the assistant is correcting it</span>
          <ChevronDown size={14} className={showJson ? "rotate-180" : ""} />
        </button>
        {showJson && <ul className="mt-2 list-disc space-y-0.5 pl-5 text-fg-secondary">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
      </div>
    );
  }

  return (
    <div className="my-2">
      <div className="mb-1.5 flex items-center gap-2 text-[12px] text-fg-muted">
        <span className="flex h-5 w-5 items-center justify-center rounded border border-border bg-bg-surface-200 text-accent">
          <LayoutDashboard size={11} />
        </span>
        <span className="truncate font-medium text-fg-secondary">{title ?? "Interface"}</span>
        {streaming && <Badge tone="accent">building…</Badge>}
        <button className="ml-auto rounded px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wider transition-colors hover:bg-bg-hover hover:text-fg" onClick={() => setShowJson((v) => !v)}>
          {showJson ? "Hide JSON" : "Show JSON"}
        </button>
      </div>
      <PrefabView envelope={envelope} streaming={streaming} onUserMessage={sendFromGenUi} />
      {showJson && (
        <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-border bg-bg-inset p-3 font-mono text-[11px] leading-relaxed animate-fade-in-up">
          {JSON.stringify(coerceUi(args?.ui) ?? {}, null, 2)}
        </pre>
      )}
    </div>
  );
}
