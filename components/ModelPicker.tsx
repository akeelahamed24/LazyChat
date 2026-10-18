"use client";

import * as React from "react";
import {
  ChevronDown,
  Check,
  Plus,
  Pencil,
  Trash2,
  KeyRound,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { BrandIcon, BrandTile, modelIconKey, providerIconKey } from "@/components/brand/BrandIcon";
import { cn, Dropdown, MenuItem, Modal, Button, IconButton, Spinner } from "@/components/ui";
import { PROVIDER_LIST } from "@/lib/models";
import { useAppStore, modelLabel, providerGlyph } from "@/lib/app-store";

/** Logo for any provider, including custom ones (matched on their name and base URL). */
function providerLogo(id: string, custom?: PublicCustomProvider) {
  return providerIconKey(id, custom ? `${custom.name} ${custom.baseUrl}` : undefined);
}
import type { ProviderId, ProviderProtocol, PublicCustomProvider } from "@/lib/types";


interface PickModel {
  id: string;
  name: string;
  supportsThinking: boolean;
}

const PROTOCOL_META: Record<
  ProviderProtocol,
  { short: string; blurb: string; baseUrlPlaceholder: string; error: string }
> = {
  openai: {
    short: "OpenAI-compatible",
    blurb:
      "Standard /chat/completions endpoint with an API key (OpenRouter, Groq, Together, a local vLLM server…).",
    baseUrlPlaceholder: "https://api.groq.com/openai/v1",
    error: "Base URL must be an http(s) URL, e.g. https://api.example.com/v1",
  },
  anthropic: {
    short: "Anthropic-compatible",
    blurb:
      "For Anthropic Messages API gateways (e.g. agentrouter). Key is sent the same way Anthropic SDK clients do.",
    baseUrlPlaceholder:
      "https://agentrouter.org   (we call /v1/messages on this base)",
    error: "Base URL must be an http(s) host root, e.g. https://agentrouter.org",
  },
  gemini: {
    short: "Google Gemini (native)",
    blurb:
      "Google's Interactions API (what tools like Claude Code gateways proxy). Key is sent as x-goog-api-key.",
    baseUrlPlaceholder:
      "https://generativelanguage.googleapis.com/v1beta   (we call /interactions)",
    error:
      "Base URL must be the Google API root, e.g. https://generativelanguage.googleapis.com/v1beta",
  },
};

function normProtocol(p: ProviderProtocol | undefined): ProviderProtocol {
  return p === "anthropic" || p === "gemini" ? p : "openai";
}

export function ModelPicker() {
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const customProviders = useAppStore((s) => s.customProviders);

  const [menuOpen, setMenuOpen] = React.useState(false);
  const [manageOpen, setManageOpen] = React.useState(false);
  const [live, setLive] = React.useState<Record<string, any[]>>({});
  const [liveOk, setLiveOk] = React.useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = React.useState(false);

  const refreshLive = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/models", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const models: Record<string, any[]> = {};
      const ok: Record<string, boolean> = {};
      for (const [pid, v] of Object.entries<any>(data)) {
        models[pid] = Array.isArray(v?.effective) ? v.effective : [];
        ok[pid] = !!v?.liveOk;
      }
      setLive(models);
      setLiveOk(ok);
    } finally {
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    if (menuOpen && Object.keys(live).length === 0) void refreshLive();
  }, [menuOpen, live, refreshLive]);

  const customById = React.useMemo(
    () => new Map(customProviders.map((c) => [c.id, c])),
    [customProviders],
  );

  const selectedCustom = customById.get(settings.provider);
  const glyph = selectedCustom
    ? selectedCustom.glyph || "◆"
    : providerGlyph(settings.provider);
  const label = selectedCustom
    ? (selectedCustom.models.find((m) => m.id === settings.model)?.name ||
        settings.model)
    : modelLabel(settings.provider, settings.model);

  const triggerLogo = modelIconKey(settings.model, settings.provider) ??
    providerLogo(settings.provider, selectedCustom);

  const pick = (provider: string, modelId: string, supportsThinking: boolean) => {
    setSettings({
      provider: provider as ProviderId,
      model: modelId,
      thinking: settings.thinking && supportsThinking,
    });
  };

  const defaultModelId = (provider: string): string => {
    const cfg = PROVIDER_LIST.find((p) => p.id === provider);
    if (cfg?.models?.length) {
      return cfg.models.find((m) => m.default)?.id ?? cfg.models[0].id;
    }
    const cp = customById.get(provider);
    return cp?.models[0]?.id || "";
  };

  const modelRow = (provider: string, m: PickModel & { retired?: boolean; liveOnly?: boolean }) => {
    const selected = settings.provider === provider && settings.model === m.id;
    return (
      <MenuItem
        key={m.id}
        active={selected}
        onClick={() => pick(provider, m.id, m.supportsThinking)}
        className="group/row pr-2"
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center opacity-80 transition-opacity group-hover/row:opacity-100">
          <BrandIcon
            name={modelIconKey(m.id, provider) ?? providerLogo(provider, customById.get(provider))}
            size={14}
            fallback={<span className="h-1.5 w-1.5 rounded-full bg-fg-faint" />}
          />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px]">
          {m.name}
          {m.retired && (
            <span className="ml-1.5 rounded-full border border-warning/30 bg-warning-soft px-1.5 py-px text-[10px] font-medium text-warning">
              retired?
            </span>
          )}
          {m.liveOnly && (
            <span className="ml-1.5 rounded-full border border-brand/30 bg-success-soft px-1.5 py-px text-[10px] font-medium text-success">
              live
            </span>
          )}
        </span>
        {m.supportsThinking && (
          <span title="Supports extended thinking">
            <Sparkles size={11} className="text-fg-faint" />
          </span>
        )}
        <span className="flex w-4 shrink-0 justify-end">
          {selected && <Check size={14} className="text-accent animate-scale-in" />}
        </span>
      </MenuItem>
    );
  };

  const customNorm = (c: PublicCustomProvider): PickModel[] =>
    c.models.map((m) => ({
      id: m.id,
      name: m.name || m.id,
      supportsThinking: m.supportsThinking ?? false,
    }));

  return (
    <>
      <Dropdown
        align="right"
        open={menuOpen}
        onOpenChange={setMenuOpen}
        trigger={
          <button
            data-testid="model-picker-trigger"
            className="group flex h-8 items-center gap-2 rounded-md border border-border bg-bg-surface-200 pl-2 pr-1.5 text-[12.5px] font-medium text-fg-secondary transition-all duration-200 hover:border-border-strong hover:bg-bg-surface-300 hover:text-fg"
          >
            <BrandIcon name={triggerLogo} size={14} fallback={<span className="text-accent">{glyph}</span>} />
            <span className="max-w-[150px] truncate">{label}</span>
            <ChevronDown size={13} className={cn("text-fg-muted transition-transform duration-300", menuOpen && "rotate-180")} />
          </button>
        }
      >
        <div className="min-h-0 w-[320px] max-w-[calc(100vw-24px)] flex-1 overflow-y-auto overscroll-contain pr-0.5">
          <div className="flex items-center justify-between gap-2 border-b border-border px-2.5 pb-2 pt-1.5">
            <span className="text-[11px] leading-snug text-fg-muted">
              {refreshing ? "Refreshing models from providers…" : liveOk && Object.keys(liveOk).length
                ? "Live model lists loaded where the provider supports it"
                : "Model lists refresh live from providers when opened"}
            </span>
            <button
              onClick={() => void refreshLive()}
              disabled={refreshing}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] font-medium text-fg-secondary transition-colors hover:border-brand/40 hover:text-accent disabled:opacity-50"
            >
              <RefreshCw size={10} className={refreshing ? "animate-spin" : ""} />
              {refreshing ? "Refreshing" : "Refresh"}
            </button>
          </div>
          <div className="flex flex-col gap-1 pt-1">
            {PROVIDER_LIST.filter((p) => p.id === "sarvam").map((p) => {
              const effective = live[p.id] && live[p.id].length ? live[p.id] : p.models;
              return (
              <div key={p.id}>
                <div className="flex items-center justify-between gap-2 px-2.5 pb-1 pt-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <BrandTile name={providerLogo(p.id)} size={20} fallback={<span className="text-[11px]">{p.glyph}</span>} />
                    <span className="truncate text-[12px] font-medium text-fg">{p.name}</span>
                  </span>
                  <span className="max-w-[45%] shrink-0 truncate font-mono text-[10px] uppercase tracking-wider text-fg-muted">
                    {p.keyEnv ? "API key" : "local"}
                    {liveOk[p.id] ? " · live" : ""}
                  </span>
                </div>
                <div className="mb-1">
                  {effective.map((m: any) =>
                    modelRow(
                      p.id,
                      {
                        id: m.id,
                        name: m.name || m.id,
                        supportsThinking: m.supportsThinking ?? true,
                        retired: m.retired,
                        liveOnly: m.liveOnly,
                      },
                    ),
                  )}
                </div>
              </div>
              );
            })}
            {customProviders.length === 0 ? (
              <p className="px-3 py-3 text-center text-[12px] leading-relaxed text-fg-muted">
                No custom providers yet. Add one below to point Omnia at any
                other OpenAI-, Anthropic- or Gemini-compatible API.
              </p>
            ) : (
              customProviders.map((c) => (
                <div key={c.id}>
                  <div className="flex items-center justify-between gap-2 px-2.5 pb-1 pt-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <BrandTile name={providerLogo(c.id, c)} size={20} fallback={<span className="text-[11px]">{c.glyph || "◆"}</span>} />
                      <span className="truncate text-[12px] font-medium text-fg">{c.name}</span>
                    </span>
                    <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-fg-muted">
                      {PROTOCOL_META[normProtocol(c.protocol)].short}
                    </span>
                  </div>
                  <div className="mb-1">
                    {customNorm(c).map((m) => modelRow(c.id, m))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="mt-1.5 flex flex-col gap-0.5 border-t border-border pt-1.5">
          <MenuItem
            icon={<KeyRound size={13} />}
            onClick={() => {
              setMenuOpen(false);
              useAppStore.getState().setApiKeysOpen(true);
            }}
            className="text-[13px] text-fg-secondary"
          >
            API keys… (OpenCode Zen, Anthropic…)
          </MenuItem>
          <MenuItem
            icon={<Plus size={13} />}
            onClick={() => {
              setMenuOpen(false);
              setManageOpen(true);
            }}
            className="text-[13px] text-fg-secondary"
          >
            Add or manage custom providers…
          </MenuItem>
          <button
            onClick={() => {
              const m = defaultModelId(settings.provider);
              if (m) setSettings({ model: m });
            }}
            className="rounded-md px-2.5 py-1.5 text-left text-[11.5px] text-fg-muted transition-colors hover:text-accent"
          >
            Reset to default model
          </button>
        </div>
      </Dropdown>

      <CustomProviderDialog open={manageOpen} onClose={() => setManageOpen(false)} />
    </>
  );
}


const inputCls =
  "w-full rounded-md border border-border-strong bg-bg-control px-2.5 py-1.5 text-[13px] text-fg placeholder:text-fg-faint transition-[border-color,box-shadow] duration-200 hover:border-border-stronger focus:outline-none focus:border-brand/60 focus:shadow-[0_0_0_3px_var(--accent-soft)]";

function parseModelsText(text: string): { id: string; name?: string; supportsThinking?: boolean }[] {
  const out: { id: string; name?: string; supportsThinking?: boolean }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const supportsThinking = line.endsWith("*");
    const body = supportsThinking ? line.slice(0, -1).trim() : line;
    const [id, ...nameParts] = body.split("|");
    const idClean = id.trim();
    if (!idClean) continue;
    const name = nameParts.join("|").trim();
    out.push({
      id: idClean,
      name: name && name !== idClean ? name : undefined,
      supportsThinking,
    });
  }
  return out;
}

function modelsToText(models: { id: string; name?: string; supportsThinking?: boolean }[]): string {
  return models
    .map((m) => `${m.id}${m.name && m.name !== m.id ? `|${m.name}` : ""}${m.supportsThinking ? "*" : ""}`)
    .join("\n");
}

function CustomProviderDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const customProviders = useAppStore((s) => s.customProviders);
  const saveCustomProvider = useAppStore((s) => s.saveCustomProvider);
  const removeCustomProvider = useAppStore((s) => s.removeCustomProvider);
  const setSettings = useAppStore((s) => s.setSettings);
  const settings = useAppStore((s) => s.settings);

  const [mode, setMode] = React.useState<"list" | "form">("list");
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [form, setForm] = React.useState({
    name: "",
    glyph: "",
    protocol: "openai" as ProviderProtocol,
    baseUrl: "",
    apiKey: "",
    apiKeyEnv: "",
    modelsText: "",
  });
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setMode("list");
      setEditingId(null);
      setErr(null);
    }
  }, [open]);

  const beginAdd = () => {
    setEditingId(null);
    setForm({ name: "", glyph: "", protocol: "openai", baseUrl: "", apiKey: "", apiKeyEnv: "", modelsText: "" });
    setErr(null);
    setMode("form");
  };

  const beginEdit = (p: PublicCustomProvider) => {
    setEditingId(p.id);
    setForm({
      name: p.name,
      glyph: p.glyph || "",
      protocol: normProtocol(p.protocol),
      baseUrl: p.baseUrl,
      apiKey: "",
      apiKeyEnv: p.apiKeyEnv || "",
      modelsText: modelsToText(p.models),
    });
    setErr(null);
    setMode("form");
  };

  const remove = async (p: PublicCustomProvider) => {
    await removeCustomProvider(p.id);
    if (mode === "list") setMode("list");
  };

  const baseUrlPlaceholder = PROTOCOL_META[form.protocol].baseUrlPlaceholder;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = form.name.trim();
    const baseUrl = form.baseUrl.trim().replace(/\/+$/, "");
    const models = parseModelsText(form.modelsText);
    if (!name) return setErr("Give the provider a name.");
    if (!/^https?:\/\/.+/i.test(baseUrl))
      return setErr(PROTOCOL_META[form.protocol].error);
    if (!models.length) return setErr("List at least one model id.");

    setBusy(true);
    setErr(null);
    try {
      const saved = await saveCustomProvider({
        id: editingId || undefined,
        name,
        glyph: form.glyph.trim(),
        baseUrl,
        protocol: form.protocol,
        apiKey: form.apiKey.trim(),
        apiKeyEnv: form.apiKeyEnv.trim(),
        models,
      });
      if (!editingId) {
        const first = saved.models[0];
        setSettings({
          provider: saved.id as ProviderId,
          model: first?.id || "",
          thinking: settings.thinking && (first?.supportsThinking ?? true),
        });
      }
      setMode("list");
      setEditingId(null);
    } catch (e: any) {
      setErr(e.message || "Failed to save provider.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Custom providers"
      subtitle="Endpoints you configure yourself: OpenAI-, Anthropic- or Gemini-compatible (e.g. Groq, OpenRouter, a Claude Code gateway like agentrouter, Google's Interactions API, a local vLLM server)."
      width="max-w-lg"
    >
      {mode === "list" ? (
        <div>
          {customProviders.length === 0 ? (
            <p className="text-[13px] text-fg-muted">
              No custom providers yet. Add one to point Omnia at any OpenAI-,
              Anthropic- or Gemini-compatible API.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {customProviders.map((p) => (
                <li
                  key={p.id}
                  className="group flex items-center gap-2.5 rounded-lg border border-border bg-bg-surface-100 px-3 py-2 transition-colors hover:border-border-strong"
                >
                  <BrandTile name={providerLogo(p.id, p)} size={30} glow fallback={<span className="text-[13px]">{p.glyph || "◆"}</span>} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-fg">
                      {p.name}
                      {settings.provider === p.id && (
                        <span className="ml-1.5 text-[10px] uppercase text-accent">
                          ● in use
                        </span>
                      )}
                    </p>
                    <p className="truncate text-[11px] text-fg-muted">
                      {PROTOCOL_META[normProtocol(p.protocol)].short}
                      {" · "}
                      {p.models.length} model{p.models.length === 1 ? "" : "s"}
                      {p.hasApiKey ? " · key set" : " · no key"}
                    </p>
                  </div>
                  <IconButton title="Edit" onClick={() => beginEdit(p)}>
                    <Pencil size={14} />
                  </IconButton>
                  <IconButton
                    title="Delete"
                    onClick={() => void remove(p)}
                    className="hover:text-danger"
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}

          <Button variant="outline" className="mt-4 w-full" onClick={beginAdd}>
            <Plus size={14} /> Add custom provider
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="grid grid-cols-[1fr_64px] gap-2">
            <div>
              <label className="mb-1 block text-[11.5px] font-medium text-fg-secondary">
                Name
              </label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Groq"
                className={inputCls}
                autoFocus
              />
            </div>
            <div>
              <label className="mb-1 block text-[11.5px] font-medium text-fg-secondary">
                Glyph
              </label>
              <input
                value={form.glyph}
                onChange={(e) => setForm({ ...form, glyph: e.target.value })}
                placeholder="◆"
                maxLength={2}
                className={cn(inputCls, "text-center")}
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[11.5px] font-medium text-fg-secondary">
              API format
            </label>
            <select
              value={form.protocol}
              onChange={(e) =>
                setForm({ ...form, protocol: e.target.value as ProviderProtocol })
              }
              className={cn(inputCls, "cursor-pointer")}
            >
              <option value="openai">OpenAI-compatible</option>
              <option value="anthropic">
                Anthropic-compatible (Claude Code style)
              </option>
              <option value="gemini">Google Gemini (native Interactions API)</option>
            </select>
            <p className="mt-1 text-[11px] text-fg-muted">
              {PROTOCOL_META[form.protocol].blurb}
            </p>
          </div>

          <div>
            <label className="mb-1 block text-[11.5px] font-medium text-fg-secondary">
              Base URL <span className="text-danger">*</span>
            </label>
            <input
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder={baseUrlPlaceholder}
              spellCheck={false}
              className={inputCls}
            />
          </div>

          <div>
            <label className="mb-1 block text-[11.5px] font-medium text-fg-secondary">
              API key
            </label>
            <input
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              placeholder="sk-… (stored server-side; leave blank for a local endpoint)"
              className={inputCls}
              spellCheck={false}
            />
            <p className="mt-1 text-[11px] text-fg-muted">
              …or reference a server env var instead:
            </p>
            <input
              value={form.apiKeyEnv}
              onChange={(e) => setForm({ ...form, apiKeyEnv: e.target.value })}
              placeholder="MY_API_KEY (env var name)"
              className={cn(inputCls, "mt-1")}
              spellCheck={false}
            />
          </div>

          <div>
            <label className="mb-1 block text-[11.5px] font-medium text-fg-secondary">
              Models <span className="text-danger">*</span>
            </label>
            <textarea
              value={form.modelsText}
              onChange={(e) => setForm({ ...form, modelsText: e.target.value })}
              rows={4}
              placeholder={
                "One model per line:\nllama-3.3-70b-versatile|Llama 3.3 70B\nqwen/qwen-2.5-72b-instruct\nmy-reasoning-model*    (* = supports thinking)"
              }
              className={cn(inputCls, "resize-y font-mono text-[12.5px] leading-relaxed")}
              spellCheck={false}
            />
          </div>

          {err && <p className="text-[12.5px] text-danger">{err}</p>}

          <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
            {editingId && (
              <span className="mr-auto text-[11px] text-fg-muted">
                Editing {editingId} — same id will be updated.
              </span>
            )}
            <Button variant="ghost" type="button" onClick={() => setMode("list")}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={busy}>
              {busy && <Spinner size={13} />}
              {editingId ? "Save changes" : "Add provider"}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
