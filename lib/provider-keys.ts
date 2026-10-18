import "server-only";

import { readScoped, writeScoped } from "@/lib/store";
import { PROVIDERS } from "@/lib/models";
import type { BuiltinProviderId } from "@/lib/types";


const FILE = "provider-keys.json";

type KeyMap = Record<string, string>;

async function readMap(): Promise<KeyMap> {
  const raw = await readScoped<unknown>(FILE, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: KeyMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v) out[k] = v;
  }
  return out;
}

export async function getStoredProviderKey(
  provider: string,
): Promise<string | undefined> {
  return (await readMap())[provider];
}

export async function resolveBuiltinKey(
  provider: BuiltinProviderId,
): Promise<string | undefined> {
  const stored = await getStoredProviderKey(provider);
  if (stored) return stored;
  const keyEnv = PROVIDERS[provider]?.keyEnv;
  if (keyEnv && process.env[keyEnv]) return process.env[keyEnv];
  // Common aliases for Google/Gemini keys.
  if (provider === "google") {
    return process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  }
  return undefined;
}

export async function builtinKeySource(
  provider: BuiltinProviderId,
): Promise<"stored" | "env" | "none"> {
  if (await getStoredProviderKey(provider)) return "stored";
  const keyEnv = PROVIDERS[provider]?.keyEnv;
  if (keyEnv && process.env[keyEnv]) return "env";
  return PROVIDERS[provider]?.requiresKey ? "none" : "env";
}

export async function setStoredProviderKey(
  provider: string,
  apiKey: string,
): Promise<void> {
  const map = await readMap();
  const key = apiKey.trim();
  if (key) map[provider] = key;
  else delete map[provider];
  await writeScoped(FILE, map);
}

export async function deleteStoredProviderKey(provider: string): Promise<void> {
  const map = await readMap();
  delete map[provider];
  await writeScoped(FILE, map);
}
