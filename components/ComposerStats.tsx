"use client";

/**
 * Composer status bar, ported from dsh's composer stats pills.
 *
 * Below the input box: decode speed (tok/s), cumulative tokens burned, and
 * context-window usage for the active conversation — plus manual Compact and
 * the auto-compact toggle (dsh-compaction-basic semantics: condense at 80%
 * pressure, keep the newest messages verbatim).
 */
import * as React from "react";
import { Brain, Flame, Minimize2, Zap } from "lucide-react";
import { useAppStore } from "@/lib/app-store";
import { findModel } from "@/lib/models";
import { cn, Tooltip } from "@/components/ui";
import type { ChatController } from "@/lib/use-chat";

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(2).replace(/\.00$/, "")}M`;
}

export function contextWindowOf(provider: string, model: string): number {
  return findModel(provider as never, model)?.context ?? 128_000;
}

export function ComposerStats({ chat }: { chat: ChatController }) {
  const activeConversationId = useAppStore((s) => s.activeConversationId);
  const usage = useAppStore((s) =>
    activeConversationId ? s.usageByConversation[activeConversationId] : undefined,
  );
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const [compacting, setCompacting] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const window = contextWindowOf(settings.provider, settings.model);
  const burned = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  const pressure = usage?.lastInput ? usage.lastInput / window : 0;

  async function compact(force: boolean) {
    if (!activeConversationId || compacting) return;
    setCompacting(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/conversations/${activeConversationId}/compact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const data = await res.json();
      if (data?.compacted) {
        chat.setMessages(data.messages);
        setNotice(`Compacted ${data.removed} messages → kept ${data.kept}.`);
      } else {
        setNotice(data?.reason ?? "Nothing to compact.");
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Compaction failed.");
    } finally {
      setCompacting(false);
    }
  }

  return (
    <div className="mx-auto w-full">
      <div className="flex items-center justify-between gap-2 px-1 pt-1.5 font-mono text-[10.5px] text-fg-muted [font-variant-numeric:tabular-nums]">
        <div className="flex min-w-0 items-center gap-3">
          <Tooltip text={usage ? `Last run decode speed` : "Speed appears after the first reply"}>
            <span className="inline-flex items-center gap-1">
              <Zap size={12} className="text-accent" />
              {usage?.speed !== undefined ? `${usage.speed.toFixed(1)} tok/s` : "— tok/s"}
            </span>
          </Tooltip>
          <Tooltip text="Cumulative input + output tokens this conversation">
            <span className="inline-flex items-center gap-1">
              <Flame size={12} className="text-accent" />
              {formatTokens(burned)} burned
            </span>
          </Tooltip>
          <Tooltip text={`Last request used ${formatTokens(usage?.lastInput ?? 0)} of ${formatTokens(window)} context tokens`}>
            <span className="inline-flex items-center gap-1">
              <Brain size={12} className="text-accent" />
              <span className="relative inline-block h-1 w-10 overflow-hidden rounded-full bg-bg-surface-300">
                <span
                  className={cn(
                    "absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 [transition-timing-function:var(--ease-out)]",
                    pressure > 0.8 ? "bg-danger" : pressure > 0.6 ? "bg-warning" : "bg-brand",
                  )}
                  style={{ width: `${Math.min(100, Math.max(2, pressure * 100))}%` }}
                />
              </span>
              {(pressure * 100).toFixed(0)}% ctx
            </span>
          </Tooltip>
          <span className="hidden h-3 w-px bg-border sm:inline-block" />
          <span className="hidden font-mono sm:inline">
            {formatTokens(usage?.lastInput ?? 0)}/{formatTokens(window)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {notice && <span className="hidden truncate text-fg-secondary sm:inline">{notice}</span>}
          <Tooltip text={settings.autoCompact !== false ? "Auto-compact on (condenses at 80% context)" : "Auto-compact off"}>
            <button
              onClick={() => setSettings({ autoCompact: settings.autoCompact === false })}
              className={cn(
                "rounded-full border px-1.5 py-px font-mono text-[10px] uppercase tracking-wider transition-colors",
                settings.autoCompact !== false
                  ? "border-brand/30 bg-accent-soft text-accent"
                  : "border-border text-fg-muted hover:bg-bg-hover",
              )}
            >
              Auto
            </button>
          </Tooltip>
          <Tooltip text="Condense older history into a summary now">
            <button
              onClick={() => void compact(true)}
              disabled={compacting}
              className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-px font-mono text-[10px] uppercase tracking-wider text-fg-secondary transition-colors hover:border-border-strong hover:bg-bg-hover disabled:opacity-40"
            >
              <Minimize2 size={12} />
              {compacting ? "Compacting…" : "Compact"}
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
