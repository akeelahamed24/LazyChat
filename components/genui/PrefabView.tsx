"use client";

import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { PrefabHost } from "@/lib/genui/host";
import type { Envelope } from "@/lib/genui/envelope";
import { useAppStore } from "@/lib/app-store";

/**
 * Renders a Prefab envelope with the official renderer inside a sandboxed iframe (opaque origin: it cannot touch
 * the app's cookies, storage or DOM) and bridges its actions back to the chat.
 */
export function PrefabView({
  envelope,
  onUserMessage,
  streaming = false,
  className,
}: {
  envelope: Envelope | null;
  onUserMessage?: (text: string) => void;
  streaming?: boolean;
  className?: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const hostRef = useRef<PrefabHost | null>(null);
  const [height, setHeight] = useState(0);
  const [rendered, setRendered] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const theme = useAppStore((s) => s.theme);
  const dark = useMemo(() => {
    if (theme === "dark") return true;
    if (theme === "light") return false;
    return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }, [theme]);

  const messageRef = useRef(onUserMessage);
  useEffect(() => {
    messageRef.current = onUserMessage;
  });

  // One host per iframe lifetime.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const host = new PrefabHost(
      (msg) => frame.contentWindow?.postMessage(msg, "*"),
      {
        onUserMessage: (t) => messageRef.current?.(t),
        onOpenLink: (url) => window.open(url, "_blank", "noopener,noreferrer"),
        onSize: (h) => setHeight(Math.min(h, 2400)),
        onReady: () => {
          setReady(true);
          setFailed(false);
        },
      },
      dark ? "dark" : "light",
    );
    hostRef.current = host;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow) return; // only our own iframe
      host.handle(e.data);
    };
    window.addEventListener("message", onMessage);
    // Load the renderer only now: it sends `ui/initialize` once on startup, so the listener must already exist.
    frame.src = "/prefab/index.html";
    return () => {
      window.removeEventListener("message", onMessage);
      hostRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The renderer must complete its handshake quickly; if it never does (blocked script, network), say so instead of
  // leaving the card on "Waiting for content...", and let the user retry.
  useEffect(() => {
    if (ready) return;
    const t = setTimeout(() => setFailed(true), 12_000);
    return () => clearTimeout(t);
  }, [ready, attempt]);

  const retry = () => {
    const frame = frameRef.current;
    if (!frame) return;
    setFailed(false);
    setAttempt((n) => n + 1);
    frame.src = `/prefab/index.html?retry=${Date.now()}`;
  };

  useEffect(() => {
    hostRef.current?.setTheme(dark ? "dark" : "light");
  }, [dark]);

  // Push each distinct envelope; the renderer re-renders in place.
  const serialized = useMemo(() => (envelope ? JSON.stringify(envelope) : ""), [envelope]);
  useEffect(() => {
    if (!envelope || !hostRef.current) return;
    // Breathing room inside the frame: the renderer itself draws edge to edge.
    hostRef.current.sendEnvelope({ ...envelope, view: { type: "Div", cssClass: "p-4", children: [envelope.view] } });
    setRendered(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized]);

  return (
    <div className={className} data-genui-streaming={streaming || undefined}>
      <div className={`relative overflow-hidden rounded-lg border border-border bg-bg-elevated shadow-soft transition-shadow duration-500 ${streaming ? "beam-border" : ""}`}>
        {!rendered && <GenUiSkeleton />}
        {failed && !ready && (
          <div className="flex items-center gap-3 p-4 text-[13px] text-fg-secondary">
            <span className="flex-1">The interface renderer did not start.</span>
            <button className="rounded-md border border-border px-2.5 py-1 hover:bg-bg-hover" onClick={retry}>
              Retry
            </button>
          </div>
        )}
        <iframe
          ref={frameRef}
          title="Generated interface"
          sandbox="allow-scripts allow-popups"
          className="block w-full border-0 bg-transparent animate-fade-in"
          style={{ height: rendered ? Math.max(height, 48) : 0, colorScheme: dark ? "dark" : "light" }}
        />
      </div>
    </div>
  );
}

export function GenUiSkeleton() {
  return (
    <div className="space-y-2.5 p-4" aria-label="Building interface">
      <div className="skeleton h-4 w-1/3" />
      <div className="skeleton h-20 w-full" />
      <div className="skeleton h-3 w-2/3" />
    </div>
  );
}
