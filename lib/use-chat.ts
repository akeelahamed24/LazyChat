"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import type { FileUIPart, UIMessage } from "ai";
import { activeRunFor, useAppStore } from "@/lib/app-store";
import {
  BackgroundChatTransport,
  type AttachTarget,
} from "@/lib/chat-transport";
import {
  noteStoredSubchatIds,
  pendingSubchatContext,
  subchatBridge,
} from "@/lib/subchat-context";
import type { ChatRunSummary } from "@/lib/types";


const RUN_POLL_MS = 3000;

type ChatApi = {
  status: "ready" | "submitted" | "streaming" | "error";
  messages: UIMessage[];
  setMessages: (messages: UIMessage[] | ((m: UIMessage[]) => UIMessage[])) => void;
};

export function useChatController() {
  const settings = useAppStore((s) => s.settings);
  const activeConversationId = useAppStore((s) => s.activeConversationId);
  const conversations = useAppStore((s) => s.conversations);
  const setActiveConversation = useAppStore((s) => s.setActiveConversation);
  const loadConversations = useAppStore((s) => s.loadConversations);
  const loadArtifacts = useAppStore((s) => s.loadArtifacts);

  const cidRef = useRef<string | null>(activeConversationId);
  const settingsRef = useRef(settings);
  const loadConversationsRef = useRef(loadConversations);
  const loadArtifactsRef = useRef(loadArtifacts);
  const setActiveConversationRef = useRef(setActiveConversation);

  const attachRef = useRef<AttachTarget | null>(null);
  const attachingRef = useRef(false);
  const compactingRef = useRef(false);
  const sawRunRef = useRef(false);
  const conversationRequestRef = useRef(0);
  const observedConversationRef = useRef<string | null | undefined>(undefined);
  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null);
  const [conversationLoadError, setConversationLoadError] = useState<string | null>(null);
  const apiRef = useRef<{
    chat: ChatApi;
    attachToRun: (runId: string) => Promise<boolean>;
    syncConversation: (cid: string) => Promise<void>;
    reloadStored: (cid: string) => Promise<UIMessage[] | null>;
    refreshRuns: () => Promise<ChatRunSummary[]>;
  } | null>(null);

  useEffect(() => {
    cidRef.current = activeConversationId;
    settingsRef.current = settings;
    loadConversationsRef.current = loadConversations;
    loadArtifactsRef.current = loadArtifacts;
    setActiveConversationRef.current = setActiveConversation;
  });

  const ensureConversationId = useCallback((): string => {
    if (!cidRef.current) {
      cidRef.current =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `conv-${Date.now()}`;
      setActiveConversationRef.current(cidRef.current);
    }
    return cidRef.current;
  }, []);


  const fetchRuns = useCallback(async (): Promise<ChatRunSummary[]> => {
    try {
      const res = await fetch("/api/chat/runs", { cache: "no-store" });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data?.runs) ? (data.runs as ChatRunSummary[]) : [];
    } catch {
      return [];
    }
  }, []);

  const refreshRuns = useCallback(async (): Promise<ChatRunSummary[]> => {
    const runs = await fetchRuns();
    useAppStore.getState().setRuns(runs);
    return runs;
  }, [fetchRuns]);

  const reloadStored = useCallback(
    async (cid: string): Promise<UIMessage[] | null> => {
      try {
        const res = await fetch(`/api/conversations/${cid}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`Conversation could not be loaded (${res.status}).`);
        const conv = await res.json();
        const messages = Array.isArray(conv.messages) ? (conv.messages as UIMessage[]) : [];
        noteStoredSubchatIds(messages);
        return messages;
      } catch {
        return null;
      }
    },
    [],
  );

  const transport = useMemo(
    () =>
      new BackgroundChatTransport({
        getAttachTarget: () => attachRef.current,
        onRunStarted: (runId) => {
          attachRef.current = { runId };
          void refreshRuns();
        },
        getExtraContext: () => {
          if (!useAppStore.getState().subchatOpen) return [];
          if (!subchatBridge.messages.length) return [];
          return pendingSubchatContext(apiRef.current?.chat.messages ?? []);
        },
      }),
    [refreshRuns],
  );

  const chat = useChat({
    transport,
    onFinish: async () => {
      try {
        const cid = cidRef.current;
        await loadConversationsRef.current();
        if (cid) await loadArtifactsRef.current(cid);
        await refreshRuns();
        // Token bar + auto-compact live here: usage settles with the run.
        if (cid) void syncUsageAndCompactRef.current(cid, true);
      } catch {
      }
    },
    onError: (e) => {
      console.error("[chat]", e?.message || e);
    },
  });

  /**
   * Pull settled token accounting into the store, then auto-compact when the
   * last request crossed 80% of the model window (dsh-compaction-basic
   * trigger). Runs once per finished turn; never throws into the chat loop.
   */
  const syncUsageAndCompact = useCallback(
    async (cid: string, allowCompact: boolean) => {
      try {
        const load = async () => {
          const res = await fetch(`/api/conversations/${cid}/usage`, { cache: "no-store" });
          if (!res.ok) return null;
          return res.json();
        };
        let data = await load();
        if (!data) return;
        // The client often outruns the server persist — one delayed retry
        // before concluding there is nothing new.
        if (!data.lastRun && !data.usage?.inputTokens && !data.usage?.outputTokens) {
          await new Promise((r) => setTimeout(r, 4000));
          data = (await load()) ?? data;
        }
        const prev = useAppStore.getState().usageByConversation[cid];
        let speed = prev?.speed;
        if (data.lastRun?.outputTokens > 0 && data.lastRun?.decodeMs > 0) {
          speed = data.lastRun.outputTokens / (data.lastRun.decodeMs / 1000);
        }
        useAppStore.getState().setUsage(cid, {
          inputTokens: data.usage?.inputTokens ?? 0,
          outputTokens: data.usage?.outputTokens ?? 0,
          speed,
          lastInput: data.lastRun?.inputTokens ?? prev?.lastInput,
          at: Date.now(),
        });

        const st = useAppStore.getState();
        if (
          !allowCompact ||
          st.settings.autoCompact === false ||
          compactingRef.current ||
          st.activeConversationId !== cid
        ) {
          return;
        }
        const window = data.contextWindow ?? 128_000;
        const pressure = (data.lastRun?.inputTokens ?? 0) / window;
        const busy =
          apiRef.current != null &&
          (apiRef.current.chat.status === "submitted" || apiRef.current.chat.status === "streaming");
        if (pressure < 0.8 || busy || (apiRef.current?.chat.messages.length ?? 0) <= 10) return;
        compactingRef.current = true;
        try {
          const cres = await fetch(`/api/conversations/${cid}/compact`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          const cdata = await cres.json();
          if (cdata?.compacted && Array.isArray(cdata.messages)) {
            apiRef.current?.chat.setMessages(cdata.messages);
          }
        } finally {
          compactingRef.current = false;
        }
      } catch {
        compactingRef.current = false;
      }
    },
    [],
  );
  const syncUsageAndCompactRef = useRef(syncUsageAndCompact);
  useEffect(() => {
    syncUsageAndCompactRef.current = syncUsageAndCompact;
  });

  const attachToRun = useCallback(
    async (runId: string, expectedConversationId?: string): Promise<boolean> => {
      if (attachingRef.current) return false;
      attachingRef.current = true;
      try {
        const res = await fetch(`/api/chat/runs/${runId}`, { cache: "no-store" });
        if (!res.ok) {
          if (attachRef.current?.runId === runId) attachRef.current = null;
          return false;
        }
        const snap = await res.json();
        let messages: UIMessage[] = Array.isArray(snap?.messages)
          ? snap.messages
          : [];
        // The events stream replays the whole run from chunk 0 into a fresh assistant message, so the partial
        // assistant message in the snapshot must not also be on screen (it would render twice).
        if (snap?.run?.status === "running" && snap?.assistantId) {
          messages = messages.filter((m) => m.id !== snap.assistantId);
        }
        const run = snap?.run as ChatRunSummary | undefined;
        noteStoredSubchatIds(messages);

        if (expectedConversationId && cidRef.current !== expectedConversationId) return false;

        attachRef.current = { runId };
        if (run?.conversationId) {
          cidRef.current = run.conversationId;
          setActiveConversationRef.current(run.conversationId);
        }
        chat.setMessages(messages);
        chat.clearError();
        sawRunRef.current = run?.status === "running";
        if (run?.status === "running" && run.replayable !== false) {
          await chat.resumeStream();
        }
        return true;
      } catch {
        return false;
      } finally {
        attachingRef.current = false;
      }
    },
    [chat],
  );

  const syncConversation = useCallback(
    async (cid: string) => {
      const requestId = ++conversationRequestRef.current;
      setLoadingConversationId(cid);
      setConversationLoadError(null);
      const busy = chat.status === "submitted" || chat.status === "streaming";
      if (busy && attachRef.current?.runId) {
        if (requestId === conversationRequestRef.current) setLoadingConversationId(null);
        return;
      }

      try {
        const runs = await fetchRuns();
        if (requestId !== conversationRequestRef.current || cidRef.current !== cid) return;
        useAppStore.getState().setRuns(runs);
        const live = runs.find(
          (r) => r.conversationId === cid && r.status === "running",
        );
        if (live) {
          const attached = await attachToRun(live.id, cid);
          if (!attached) throw new Error("The active response could not be resumed.");
          return;
        }
        attachRef.current = null;
        const messages = await reloadStored(cid);
        if (requestId !== conversationRequestRef.current || cidRef.current !== cid) return;
        if (!messages) throw new Error("Conversation could not be loaded.");
        chat.setMessages(messages);
        chat.clearError();
        void syncUsageAndCompactRef.current(cid, false);
      } catch (error) {
        if (requestId === conversationRequestRef.current && cidRef.current === cid) {
          setConversationLoadError(error instanceof Error ? error.message : "Conversation could not be loaded.");
        }
      } finally {
        if (requestId === conversationRequestRef.current) setLoadingConversationId(null);
      }
      void loadArtifactsRef.current(cid);
    },
    [
      attachToRun,
      chat,
      fetchRuns,
      reloadStored,
      setConversationLoadError,
      setLoadingConversationId,
    ],
  );


  const detach = useCallback(async () => {
    attachRef.current = null;
    try {
      await chat.stop();
    } catch {
    }
  }, [chat]);

  const startNew = useCallback(() => {
    conversationRequestRef.current++;
    setLoadingConversationId(null);
    setConversationLoadError(null);
    void detach();
    chat.setMessages([]);
    chat.clearError();
    cidRef.current = null;
    setActiveConversationRef.current(null);
  }, [chat, detach, setConversationLoadError, setLoadingConversationId]);

  const openConversation = useCallback(
    async (id: string) => {
      if (id === cidRef.current) {
        await syncConversation(id);
        return;
      }
      if (chat.status === "submitted" || chat.status === "streaming") {
        await detach();
      }
      cidRef.current = id;
      conversationRequestRef.current++;
      setLoadingConversationId(id);
      setConversationLoadError(null);
      chat.setMessages([]);
      setActiveConversationRef.current(id);
      attachRef.current = null;
    },
    [chat, detach, syncConversation, setConversationLoadError, setLoadingConversationId],
  );

  const send = useCallback(
    (text: string, files?: FileUIPart[]) => {
      const cid = ensureConversationId();
      const live = activeRunFor(useAppStore.getState().runs, cid);
      if (live) {
        void attachToRun(live.id);
        return;
      }
      const payload: { text: string; files?: FileUIPart[] } = { text };
      if (files?.length) payload.files = files;
      const attached = useAppStore.getState().conversationWorkspaces[cid];
      void chat.sendMessage(payload, {
        body: {
          settings: settingsRef.current,
          conversationId: cid,
          ...(attached ? { workspaceId: attached.id } : {}),
        },
      });
    },
    [attachToRun, chat, ensureConversationId],
  );

  const regenerate = useCallback(() => {
    const cid = ensureConversationId();
    const live = activeRunFor(useAppStore.getState().runs, cid);
    if (live) {
      void attachToRun(live.id);
      return;
    }
    const attached = useAppStore.getState().conversationWorkspaces[cid];
    void chat.regenerate({
      body: {
        settings: settingsRef.current,
        conversationId: cid,
        ...(attached ? { workspaceId: attached.id } : {}),
      },
    });
  }, [attachToRun, chat, ensureConversationId]);

  const stop = useCallback(() => {
    const runId = attachRef.current?.runId;
    void detach();
    if (runId) {
      void fetch(`/api/chat/runs/${runId}`, { method: "DELETE" }).catch(() => {});
    }
    setTimeout(() => {
      void refreshRuns();
      void loadConversationsRef.current();
      const cid = cidRef.current;
      if (cid) void loadArtifactsRef.current(cid);
    }, 700);
  }, [detach, refreshRuns]);

  const stopRun = useCallback(
    async (runId: string) => {
      await fetch(`/api/chat/runs/${runId}`, { method: "DELETE" }).catch(() => {});
      await refreshRuns();
      await loadConversationsRef.current();
      const cid = cidRef.current;
      if (!cid) return;
      void loadArtifactsRef.current(cid);
      if (chat.status === "submitted" || chat.status === "streaming") return;
      const messages = await reloadStored(cid);
      if (messages) chat.setMessages(messages);
    },
    [chat, refreshRuns, reloadStored],
  );

  const showRun = useCallback(
    async (runId: string) => {
      await attachToRun(runId);
    },
    [attachToRun],
  );


  useEffect(() => {
    apiRef.current = {
      chat,
      attachToRun,
      syncConversation,
      reloadStored,
      refreshRuns,
    };
  });

  useEffect(() => {
    if (
      activeConversationId &&
      !conversations.some((conversation) => conversation.id === activeConversationId)
    ) return;
    if (observedConversationRef.current === activeConversationId) return;
    observedConversationRef.current = activeConversationId;
    const api = apiRef.current;
    if (!api) return;
    if (activeConversationId) void api.syncConversation(activeConversationId);
    else void api.refreshRuns();
  }, [activeConversationId, conversations]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const api = apiRef.current;
        if (!api) return;
        const runs = await api.refreshRuns();
        if (cancelled) return;

        const cid = cidRef.current;
        const live = cid
          ? runs.find(
              (r) => r.conversationId === cid && r.status === "running",
            ) ?? null
          : null;
        const attachedId = attachRef.current?.runId ?? null;
        const busy =
          api.chat.status === "submitted" || api.chat.status === "streaming";

        if (live && live.id !== attachedId && !busy && !attachingRef.current) {
          await api.attachToRun(live.id);
        } else if (!live && attachedId) {
          attachRef.current = null;
        }

        if (live) {
          sawRunRef.current = true;
        } else if (sawRunRef.current) {
          sawRunRef.current = false;
          void loadConversationsRef.current();
          if (cid) {
            void loadArtifactsRef.current(cid);
            if (!busy) {
              const messages = await api.reloadStored(cid);
              const localLast = api.chat.messages[api.chat.messages.length - 1];
              const serverLast = messages?.[messages.length - 1];
              // Never swap what is on screen for an older/shorter stored copy (a save may still be landing).
              const size = (m?: UIMessage) => (m ? JSON.stringify(m.parts ?? []).length : 0);
              const stale = !!localLast && serverLast?.id === localLast.id && size(serverLast) < size(localLast);
              if (messages && !cancelled && !stale && (!localLast || serverLast?.id === localLast.id)) {
                api.chat.setMessages(messages);
              }
            }
          }
        }
      } catch {
      } finally {
        if (!cancelled) timer = setTimeout(tick, RUN_POLL_MS);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return {
    ...chat,
    settings,
    send,
    startNew,
    openConversation,
    regenerate,
    stop,
    activeConversationId,
    loadingConversation: loadingConversationId !== null && loadingConversationId === activeConversationId,
    conversationLoadError,
    reloadConversation: () => {
      const cid = cidRef.current;
      if (cid) void syncConversation(cid);
    },
    stopRun,
    showRun,
    attachToRun,
    refreshRuns,
  };
}

export type ChatController = ReturnType<typeof useChatController>;
