"use client";

import * as React from "react";
import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Square,
  Paperclip,
  X,
  Globe,
  FileText,
  Bot,
  Brain,
  Monitor,
  Sparkles,
} from "lucide-react";
import type { FileUIPart } from "ai";
import { cn, IconButton, Spinner, Tooltip } from "@/components/ui";
import { useAppStore } from "@/lib/app-store";
import { DEFAULT_DISPLAY } from "@/lib/display";
import { modelSupportsThinking } from "@/lib/models";
import type { ChatController } from "@/lib/use-chat";
import { activeRunFor } from "@/lib/app-store";
import { ModelPicker } from "@/components/ModelPicker";
import { ComposerStats } from "@/components/ComposerStats";
import { SandboxMini } from "@/components/SandboxMini";
import { BackgroundRunBar } from "@/components/BackgroundRunBar";
import { BrandIcon } from "@/components/brand/BrandIcon";
import { FileIcon } from "@/components/brand/FileIcon";


const TOOL_BUTTONS: {
  id: string;
  label: string;
  icon: React.ReactNode;
  tooltip: string;
}[] = [
  {
    id: "webSearch",
    label: "Search",
    icon: <BrandIcon name="duckduckgo" size={14} fallback={<Globe size={14} />} />,
    tooltip: "Search the web (add Tavily/Brave/Serper keys via Search providers in the sidebar)",
  },
  {
    id: "createArtifact",
    label: "Artifacts",
    icon: <FileText size={14} />,
    tooltip: "Create viewable artifacts (code, HTML, SVG, …)",
  },
  {
    id: "runAgentTask",
    label: "Agents",
    icon: <BrandIcon name="docker" size={14} fallback={<Bot size={14} />} />,
    tooltip: "Run autonomous agents in Docker sandboxes",
  },
  {
    id: "computerUse",
    label: "Computer",
    icon: <BrandIcon name="chrome" size={14} fallback={<Monitor size={14} />} />,
    tooltip: "Let the model drive the shared Chromium computer anytime (recorded, you can take over)",
  },
  {
    id: "companyBrain",
    label: "Brain",
    icon: <Brain size={14} />,
    tooltip: "Company Brain: FalkorDB knowledge graph (people, services, tickets, decisions) plus memory of earlier Omnia conversations",
  },
];

function ToolToggle({
  id,
  label,
  icon,
  tooltip,
  checked,
  onToggle,
}: {
  id: string;
  label: string;
  icon: React.ReactNode;
  tooltip: string;
  checked: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <Tooltip text={tooltip}>
      <button
        onClick={() => onToggle(id)}
        aria-pressed={checked}
        className={cn(
          "group inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium transition-all duration-200 active:scale-95",
          checked
            ? "border-brand/40 bg-accent-soft text-accent shadow-[0_0_12px_-4px_var(--accent-glow)]"
            : "border-border bg-transparent text-fg-muted hover:border-border-strong hover:bg-bg-hover hover:text-fg-secondary",
        )}
      >
        <span className={cn("transition-[filter,opacity,transform] duration-200 group-hover:scale-110", !checked && "opacity-70 grayscale group-hover:opacity-100 group-hover:grayscale-0")}>
          {icon}
        </span>
        <span className="hidden md:inline">{label}</span>
      </button>
    </Tooltip>
  );
}

export function Composer({
  chat,
  disabled,
}: {
  chat: ChatController;
  disabled?: boolean;
}) {
  const settings = useAppStore((s) => s.settings);
  const toggleTool = useAppStore((s) => s.toggleTool);
  const setSettings = useAppStore((s) => s.setSettings);
  const runs = useAppStore((s) => s.runs);
  const activeConversationId = useAppStore((s) => s.activeConversationId);
  const contentWidth = useAppStore((s) => s.display?.contentWidth) ?? DEFAULT_DISPLAY.contentWidth;

  const [text, setText] = useState("");
  const [pending, setPending] = useState<FileUIPart[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const dragDepth = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isBusy = chat.status === "submitted" || chat.status === "streaming";
  const liveRun = activeRunFor(runs, activeConversationId);
  const backgroundRun = isBusy ? null : liveRun;
  const thinkingSupported = modelSupportsThinking(
    settings.provider,
    settings.model,
  );

  const autoGrow = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  };

  const handleUpload = async (files: FileList | File[] | null) => {
    if (!files || !files.length) return;
    setUploading(true);
    try {
      const form = new FormData();
      Array.from(files).forEach((f) => form.append("files", f));
      form.append("conversationId", activeConversationId || "");
      const res = await fetch("/api/upload", { method: "POST", body: form });
      if (!res.ok) throw new Error("upload failed");
      const { artifacts } = await res.json();
      const parts: FileUIPart[] = artifacts.map((a: any) => ({
        type: "file",
        mediaType: a.mime || "application/octet-stream",
        filename: a.filename,
        url: `/api/files/${a.id}/${encodeURIComponent(a.filename)}`,
      }));
      setPending((p) => [...p, ...parts]);
    } catch (e) {
      console.error(e);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const hasFiles = (e: React.DragEvent) => {
    try {
      return Array.from(e.dataTransfer.types || []).includes("Files");
    } catch {
      return true;
    }
  };

  const handleSend = () => {
    const value = text.trim();
    if (!value && !pending.length) return;
    if (isBusy) return;
    if (backgroundRun) return;
    chat.send(value, pending.length ? pending : undefined);
    setText("");
    setPending([]);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) el.style.height = "auto";
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="sticky bottom-0 z-20 bg-gradient-to-t from-bg via-bg/95 to-transparent px-3 pb-3 pt-3 sm:px-6">
      <div className="mx-auto w-full" style={{ maxWidth: contentWidth }}>
        <SandboxMini />

        {backgroundRun && <BackgroundRunBar run={backgroundRun} chat={chat} />}

        <div
          className={cn(
            "relative rounded-xl border border-border-strong bg-bg-surface-100 shadow-soft transition-[border-color,box-shadow] duration-300",
            "hover:border-border-stronger focus-within:border-brand/50 focus-within:shadow-[0_0_0_4px_var(--accent-soft),var(--shadow-soft)]",
            isBusy && "beam-border",
            dragging && "border-brand border-dashed",
          )}
          onDragEnter={(e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            dragDepth.current += 1;
            setDragging(true);
          }}
          onDragOver={(e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragging(false);
          }}
          onDrop={(e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            dragDepth.current = 0;
            setDragging(false);
            if (uploading || isBusy) return;
            const files = e.dataTransfer.files;
            if (files?.length) void handleUpload(files);
          }}
        >
          {dragging && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-brand/10 backdrop-blur-[2px] animate-fade-in">
              <p className="rounded-full border border-brand/40 bg-bg-overlay px-4 py-2 text-[13px] font-medium text-accent shadow-pop animate-scale-in">
                Drop files to attach{uploading ? " (uploading…)" : ""}
              </p>
            </div>
          )}
          {pending.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {pending.map((p, i) => (
                <span
                  key={`${p.url}-${i}`}
                  className="group inline-flex items-center gap-2 rounded-md border border-border bg-bg-surface-200 py-1 pl-1.5 pr-2 text-[12px] text-fg-secondary animate-scale-in"
                >
                  <FileIcon type={p.filename || p.mediaType} size={22} />
                  <span className="max-w-[140px] truncate">{p.filename}</span>
                  <button
                    onClick={() =>
                      setPending((arr) => arr.filter((_, j) => j !== i))
                    }
                    className="rounded p-0.5 text-fg-muted transition-colors hover:bg-danger-soft hover:text-danger"
                  >
                    <X size={13} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            rows={1}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              autoGrow();
            }}
            onKeyDown={handleKeyDown}
            onPaste={(e) => {
              const files = e.clipboardData?.files;
              if (files?.length && !uploading && !isBusy) {
                e.preventDefault();
                void handleUpload(files);
              }
            }}
            placeholder="Ask anything… (drop files to attach)"
            disabled={disabled}
            className={cn(
              "w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[14.5px] leading-relaxed text-fg placeholder:text-fg-faint",
              "focus:outline-none disabled:opacity-50",
            )}
          />

          <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
            <div className="flex items-center gap-0.5">
              <Tooltip text="Attach a file">
                <IconButton
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || isBusy}
                  className="h-8 w-8"
                  title="Attach a file"
                >
                  {uploading ? (
                    <Spinner size={14} className="text-accent" />
                  ) : (
                    <Paperclip size={16} />
                  )}
                </IconButton>
              </Tooltip>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => handleUpload(e.target.files)}
              />

              {TOOL_BUTTONS.map((t) => (
                <ToolToggle
                  key={t.id}
                  id={t.id}
                  label={t.label}
                  icon={t.icon}
                  tooltip={t.tooltip}
                  checked={settings.tools.includes(t.id)}
                  onToggle={toggleTool}
                />
              ))}

              {thinkingSupported && (
                <Tooltip
                  text={
                    settings.thinking
                      ? "Thinking is on — the model reasons before answering"
                      : "Turn on extended thinking"
                  }
                >
                  <button
                    onClick={() =>
                      setSettings({ thinking: !settings.thinking })
                    }
                    aria-pressed={settings.thinking}
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium transition-all duration-200 active:scale-95",
                      settings.thinking
                        ? "border-info/40 bg-info-soft text-info"
                        : "border-border text-fg-muted hover:border-border-strong hover:bg-bg-hover hover:text-fg-secondary",
                    )}
                  >
                    <Sparkles size={14} className={settings.thinking ? "animate-pulse" : ""} />
                    <span className="hidden md:inline">Thinking</span>
                  </button>
                </Tooltip>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              <ModelPicker />
              {isBusy ? (
                <button
                  onClick={() => chat.stop()}
                  className="relative flex h-8 w-8 items-center justify-center rounded-md border border-border-strong bg-bg-control text-fg transition-all hover:border-danger/40 hover:bg-danger-soft hover:text-danger active:scale-95"
                  title="Stop generating"
                >
                  <Square size={12} fill="currentColor" />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!mounted || ((!text.trim() && !pending.length) || disabled || !!backgroundRun)}
                  className={cn(
                    "btn-sheen group flex h-8 w-8 items-center justify-center rounded-md border border-[color:var(--brand-button-border)] bg-[color:var(--brand-button)] text-[color:var(--brand-button-text)]",
                    "transition-all hover:brightness-110 hover:shadow-[0_0_0_3px_var(--accent-soft)] active:scale-95 disabled:opacity-35 disabled:grayscale disabled:pointer-events-none",
                  )}
                  title={
                    backgroundRun
                      ? "A reply is generating in the background — stop it to send"
                      : "Send message"
                  }
                >
                  <ArrowUp size={15} strokeWidth={2.5} className="transition-transform duration-300 group-hover:-translate-y-0.5" />
                </button>
              )}
            </div>
          </div>
        </div>

        <ComposerStats chat={chat} />

        <p className="mt-1.5 text-center text-[11px] text-fg-muted">
          Omnia can make mistakes. Check important info.
        </p>
      </div>
    </div>
  );
}
