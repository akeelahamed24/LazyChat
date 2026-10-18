import "server-only";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import type { LanguageModel } from "ai";
import type { BuiltinProviderId, ProviderId } from "@/lib/types";
import {
  PROVIDERS,
  getDefaultModel,
  getOpencodeTransport,
  isBuiltinProvider,
} from "@/lib/models";
import { resolveBuiltinKey } from "@/lib/provider-keys";
import { getCustomProvider, resolveApiKey } from "@/lib/custom-providers";


export { PROVIDERS, getDefaultModel, isBuiltinProvider };

export interface BuildModelOptions {
  provider: ProviderId;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export async function hasProviderKey(provider: ProviderId): Promise<boolean> {
  const custom = await getCustomProvider(provider);
  if (custom) return Boolean(resolveApiKey(custom));
  const cfg = PROVIDERS[provider as BuiltinProviderId];
  if (cfg) {
    if (!cfg.requiresKey) return true;
    return Boolean(await resolveBuiltinKey(provider as BuiltinProviderId));
  }
  return false;
}

export async function buildLanguageModel(opts: BuildModelOptions): Promise<LanguageModel> {
  const { provider, model } = opts;

  // A custom provider may intentionally shadow a builtin id (e.g. a user
  // re-added "google" with their own key/base URL). Prefer the custom one.
  const customShadow = await getCustomProvider(provider);
  if (customShadow) {
    if (customShadow.protocol === "gemini") {
      const apiKey = opts.apiKey || resolveApiKey(customShadow);
      if (!apiKey) {
        throw new Error(
          `Gemini is not configured. Set an API key on the provider (or ${customShadow.apiKeyEnv || "GOOGLE_GENERATIVE_AI_API_KEY"} env).`,
        );
      }
      const raw = (opts.baseUrl || customShadow.baseUrl || "")
        .trim()
        .replace(/\/+$/, "");
      const baseURL = raw.replace(/\/interactions$/i, "");
      const client = createGoogleGenerativeAI({
        name: customShadow.id,
        baseURL: baseURL || undefined,
        apiKey,
      });
      return client.interactions(model);
    }
    const apiKey = opts.apiKey || resolveApiKey(customShadow) || "custom";
    if (customShadow.protocol === "anthropic") {
      const raw = (opts.baseUrl || customShadow.baseUrl).replace(/\/+$/, "");
      const baseURL = /\/v1$/i.test(raw) ? raw : `${raw}/v1`;
      const client = createAnthropic({
        name: customShadow.id,
        baseURL,
        apiKey,
      });
      return client(model);
    }
    const client = createOpenAICompatible({
      name: customShadow.id,
      baseURL: opts.baseUrl || customShadow.baseUrl,
      apiKey,
    });
    return client(model);
  }

  if (!isBuiltinProvider(provider)) {
    const custom = await getCustomProvider(provider);
    if (!custom) throw new Error(`Unknown provider: ${provider}`);

    if (custom.protocol === "gemini") {
      const apiKey = opts.apiKey || resolveApiKey(custom);
      if (!apiKey) {
        throw new Error(
          `Gemini is not configured. Set an API key on the provider (or ${custom.apiKeyEnv || "GOOGLE_GENERATIVE_AI_API_KEY"} env).`,
        );
      }
      const raw = (opts.baseUrl || custom.baseUrl || "")
        .trim()
        .replace(/\/+$/, "");
      const baseURL = raw.replace(/\/interactions$/i, "");
      const client = createGoogleGenerativeAI({
        name: custom.id,
        baseURL: baseURL || undefined,
        apiKey,
      });
      return client.interactions(model);
    }

    const apiKey = opts.apiKey || resolveApiKey(custom) || "custom";

    if (custom.protocol === "anthropic") {
      const raw = (opts.baseUrl || custom.baseUrl).replace(/\/+$/, "");
      const baseURL = /\/v1$/i.test(raw) ? raw : `${raw}/v1`;
      const client = createAnthropic({
        name: custom.id,
        baseURL,
        apiKey,
      });
      return client(model);
    }

    const client = createOpenAICompatible({
      name: custom.id,
      baseURL: opts.baseUrl || custom.baseUrl,
      apiKey,
    });
    return client(model);
  }

  const cfg = PROVIDERS[provider];
  const resolvedKey = opts.apiKey || (await resolveBuiltinKey(provider));
  const apiKey = resolvedKey || "not-set";
  const baseUrl =
    opts.baseUrl ||
    (cfg.baseUrlEnv ? process.env[cfg.baseUrlEnv] : undefined) ||
    cfg.defaultBaseUrl ||
    undefined;

  switch (provider) {
    case "anthropic": {
      if (!resolvedKey) {
        throw new Error(
          `Anthropic is not configured. Paste a key via the 🔑 button in the header, or set ${cfg.keyEnv} in .env.local`,
        );
      }
      const client = createAnthropic({ apiKey });
      return client(model);
    }
    case "openai": {
      if (!resolvedKey) {
        throw new Error(
          `OpenAI is not configured. Paste a key via the 🔑 button in the header, or set ${cfg.keyEnv} in .env.local`,
        );
      }
      const client = createOpenAI({ apiKey, baseURL: baseUrl });
      return client(model);
    }
    case "google": {
      if (!resolvedKey) {
        throw new Error(
          `Google is not configured. Paste a key via the 🔑 button in the header, or set ${cfg.keyEnv} in .env.local`,
        );
      }
      const client = createGoogleGenerativeAI({ apiKey, baseURL: baseUrl });
      return client(model);
    }
    case "ollama": {
      const client = createOpenAICompatible({
        name: "ollama",
        baseURL: baseUrl as string,
        apiKey: "ollama",
      });
      return client(model);
    }
    case "sarvam": {
      if (!resolvedKey) {
        throw new Error(
          `Sarvam is not configured. Paste a key via the 🔑 button in the header, or set ${cfg.keyEnv} in .env.local`,
        );
      }
      const client = createOpenAICompatible({
        name: "sarvam",
        baseURL: baseUrl as string,
        apiKey: resolvedKey,
      });
      return client(model);
    }
    case "nvidia": {
      if (!resolvedKey) {
        throw new Error(
          `NVIDIA is not configured. Paste a key via the 🔑 button in the header, or set ${cfg.keyEnv} in .env.local`,
        );
      }
      // NVIDIA NIM exposes an OpenAI-compatible endpoint; reasoning models return `reasoning_content`, which the
      // compatible provider maps to reasoning parts.
      const client = createOpenAICompatible({
        name: "nvidia",
        baseURL: baseUrl as string,
        apiKey: resolvedKey,
      });
      return client(model);
    }
    case "lmstudio": {
      const client = createOpenAICompatible({
        name: "lmstudio",
        baseURL: baseUrl as string,
        apiKey: "lm-studio",
      });
      return client(model);
    }
    case "opencode": {
      if (!resolvedKey) {
        throw new Error(
          `OpenCode Zen is not configured. Sign in at https://opencode.ai/auth, copy your API key, paste it via the 🔑 button in the header, or set ${cfg.keyEnv} in .env.local`,
        );
      }
      const zenBase =
        baseUrl || "https://opencode.ai/zen/v1";
      switch (getOpencodeTransport(model)) {
        case "anthropic": {
          const client = createAnthropic({ apiKey, baseURL: zenBase });
          return client(model);
        }
        case "gemini": {
          const client = createGoogleGenerativeAI({
            apiKey,
            baseURL: zenBase,
          });
          return client(model);
        }
        case "chat": {
          const client = createOpenAICompatible({
            name: "opencode",
            baseURL: zenBase,
            apiKey,
          });
          return client(model);
        }
        case "responses":
        default: {
          const client = createOpenAI({ apiKey, baseURL: zenBase });
          return client(model);
        }
      }
    }
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}


export function thinkingProviderOptions(
  provider: ProviderId,
  model: string,
  enabled: boolean,
): Record<string, unknown> | undefined {
  if (!enabled) return undefined;
  if (provider === "opencode") {
    const transport = getOpencodeTransport(model);
    if (transport === "anthropic") {
      return {
        anthropic: {
          thinking: { type: "enabled", budgetTokens: 4096 },
        },
      };
    }
    if (transport === "gemini") {
      return {
        google: { thinkingConfig: { thinkingBudget: 8192 } },
      };
    }
    if (/o[1-5]|gpt-5|gpt-6|reasoning|grok|muse-spark|deepseek|kimi|glm|qwen/i.test(model)) {
      return { openai: { reasoningEffort: "high" } };
    }
    return undefined;
  }
  switch (provider) {
    case "anthropic":
      return {
        anthropic: {
          thinking: { type: "enabled", budgetTokens: 4096 },
        },
      };
    case "openai": {
      if (/o[1-5]|gpt-5|gpt-5.1|reasoning/i.test(model)) {
        return { openai: { reasoningEffort: "high" } };
      }
      return undefined;
    }
    case "google":
      return {
        google: { thinkingConfig: { thinkingBudget: 8192 } },
      };
    default:
      return undefined;
  }
}
