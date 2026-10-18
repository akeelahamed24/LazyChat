import type {
  BuiltinProviderId,
  ProviderConfig,
  ProviderId,
} from "@/lib/types";


export const PROVIDERS: Record<BuiltinProviderId, ProviderConfig> = {
  anthropic: {
    id: "anthropic",
    name: "Claude (Anthropic)",
    tagline: "Opus 5, Sonnet 5, Haiku 4.5 — extended thinking, artifacts",
    glyph: "✦",
    keyEnv: "ANTHROPIC_API_KEY",
    requiresKey: true,
    models: [
      {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        supportsThinking: true,
        supportsVision: true,
        context: 200_000,
        maxOutput: 64_000,
        category: "reasoning",
        default: true,
      },
      {
        id: "claude-opus-5",
        name: "Claude Opus 5",
        supportsThinking: true,
        supportsVision: true,
        context: 200_000,
        maxOutput: 64_000,
        category: "reasoning",
      },
      {
        id: "claude-haiku-4-5-20251001",
        name: "Claude Haiku 4.5",
        supportsThinking: true,
        supportsVision: true,
        context: 200_000,
        maxOutput: 64_000,
        category: "fast",
      },
    ],
    providerOptionsKey: "anthropic",
  },

  openai: {
    id: "openai",
    name: "OpenAI",
    tagline: "GPT-5 family — reasoning effort, vision",
    glyph: "◉",
    keyEnv: "OPENAI_API_KEY",
    requiresKey: true,
    baseUrlEnv: "OPENAI_BASE_URL",
    defaultBaseUrl: "https://api.openai.com/v1",
    models: [
      {
        id: "gpt-5",
        name: "GPT-5",
        supportsThinking: true,
        supportsVision: true,
        context: 400_000,
        maxOutput: 128_000,
        category: "reasoning",
        default: true,
      },
      {
        id: "gpt-5-mini",
        name: "GPT-5 mini",
        supportsThinking: true,
        supportsVision: true,
        context: 400_000,
        maxOutput: 128_000,
        category: "fast",
      },
      {
        id: "o4-mini",
        name: "o4-mini",
        supportsThinking: true,
        supportsVision: true,
        context: 200_000,
        maxOutput: 100_000,
        category: "reasoning",
      },
      {
        id: "gpt-4.1",
        name: "GPT-4.1",
        supportsThinking: false,
        supportsVision: true,
        context: 1_000_000,
        maxOutput: 32_768,
        category: "fast",
      },
    ],
    providerOptionsKey: "openai",
  },

  google: {
    id: "google",
    name: "Google Gemini",
    tagline: "Gemini — native thinking budget, huge context (list refreshes from Google)",
    glyph: "◈",
    keyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
    requiresKey: true,
    baseUrlEnv: "GOOGLE_GENERATIVE_AI_BASE_URL",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    models: [
      {
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        supportsThinking: true,
        supportsVision: true,
        context: 1_000_000,
        maxOutput: 65_536,
        category: "reasoning",
        default: true,
      },
      {
        id: "gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        supportsThinking: true,
        supportsVision: true,
        context: 1_000_000,
        maxOutput: 65_536,
        category: "fast",
      },
      {
        id: "gemini-2.0-flash",
        name: "Gemini 2.0 Flash",
        supportsThinking: false,
        supportsVision: true,
        context: 1_000_000,
        maxOutput: 65_536,
        category: "fast",
      },
    ],
    providerOptionsKey: "google",
  },

  sarvam: {
    id: "sarvam",
    name: "Sarvam",
    tagline: "Sarvam-105b — OpenAI-compatible chat/completions endpoint",
    glyph: "◐",
    keyEnv: "SARVAM_API_KEY",
    requiresKey: true,
    baseUrlEnv: "SARVAM_BASE_URL",
    defaultBaseUrl: "https://api.sarvam.ai/v1",
    models: [
      {
        id: "sarvam-105b",
        name: "Sarvam 105b",
        supportsThinking: false,
        supportsVision: false,
        context: 32_768,
        maxOutput: 8192,
        category: "reasoning",
        default: true,
      },
    ],
    providerOptionsKey: "openai",
  },

  nvidia: {
    id: "nvidia",
    name: "NVIDIA",
    tagline: "Nemotron & open models on NVIDIA NIM (OpenAI-compatible)",
    glyph: "◆",
    keyEnv: "NVIDIA_API_KEY",
    requiresKey: true,
    baseUrlEnv: "NVIDIA_BASE_URL",
    defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
    models: [
      {
        id: "nvidia/nemotron-3-super-120b-a12b",
        name: "Nemotron 3 Super 120B",
        supportsThinking: false,
        supportsVision: false,
        context: 131_072,
        maxOutput: 16_384,
        category: "reasoning",
        default: true,
      },
      {
        id: "nvidia/nemotron-3-ultra-550b-a55b",
        name: "Nemotron 3 Ultra 550B",
        supportsThinking: false,
        supportsVision: false,
        context: 131_072,
        maxOutput: 16_384,
        category: "reasoning",
      },
      {
        id: "nvidia/nemotron-3.5-super-vl-120b-a12b",
        name: "Nemotron 3.5 Super VL 120B",
        supportsThinking: false,
        supportsVision: true,
        context: 131_072,
        maxOutput: 16_384,
        category: "reasoning",
      },
      {
        id: "nvidia/llama-3.1-nemotron-ultra-253b-v1",
        name: "Llama 3.1 Nemotron Ultra 253B",
        supportsThinking: false,
        supportsVision: false,
        context: 131_072,
        maxOutput: 8192,
        category: "reasoning",
      },
      {
        id: "moonshotai/kimi-k2.6",
        name: "Kimi K2.6",
        supportsThinking: false,
        supportsVision: false,
        context: 131_072,
        maxOutput: 16_384,
        category: "reasoning",
      },
      {
        id: "deepseek-ai/deepseek-v4.1-flash",
        name: "DeepSeek V4.1 Flash",
        supportsThinking: false,
        supportsVision: false,
        context: 131_072,
        maxOutput: 16_384,
        category: "fast",
      },
      {
        id: "openai/gpt-oss-20b",
        name: "gpt-oss 20B",
        supportsThinking: false,
        supportsVision: false,
        context: 131_072,
        maxOutput: 8192,
        category: "fast",
      },
    ],
    providerOptionsKey: "openai",
  },

  ollama: {
    id: "ollama",
    name: "Ollama (local)",
    tagline: "Run Llama, Qwen, DeepSeek & friends on your machine",
    glyph: "🐙",
    requiresKey: false,
    baseUrlEnv: "OLLAMA_BASE_URL",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    models: [
      {
        id: "llama3.2",
        name: "Llama 3.2",
        supportsThinking: false,
        supportsVision: false,
        context: 128_000,
        maxOutput: 8192,
        category: "fast",
        default: true,
      },
      {
        id: "qwen3:8b",
        name: "Qwen3 8B",
        supportsThinking: false,
        supportsVision: false,
        context: 32_768,
        maxOutput: 8192,
        category: "fast",
      },
      {
        id: "deepseek-r1:14b",
        name: "DeepSeek R1 14B",
        supportsThinking: true,
        supportsVision: false,
        context: 128_000,
        maxOutput: 8192,
        category: "reasoning",
      },
    ],
    providerOptionsKey: "openai-compatible",
  },

  lmstudio: {
    id: "lmstudio",
    name: "LM Studio",
    tagline: "Local models served from LM Studio's OpenAI-compatible API",
    glyph: "⬡",
    requiresKey: false,
    baseUrlEnv: "LMSTUDIO_BASE_URL",
    defaultBaseUrl: "http://127.0.0.1:1234/v1",
    models: [
      {
        id: "local-model",
        name: "Loaded model",
        supportsThinking: false,
        supportsVision: false,
        context: 32_768,
        maxOutput: 4096,
        category: "fast",
        default: true,
      },
    ],
    providerOptionsKey: "openai-compatible",
  },

  opencode: {
    id: "opencode",
    name: "OpenCode Zen",
    tagline: "One API key for GPT, Claude, Gemini + open models (pay-as-you-go)",
    glyph: "⬢",
    keyEnv: "OPENCODE_API_KEY",
    requiresKey: true,
    baseUrlEnv: "OPENCODE_BASE_URL",
    defaultBaseUrl: "https://opencode.ai/zen/v1",
    models: [
      {
        id: "muse-spark-1.3-contributor-free",
        name: "Muse Spark 1.3 (free)",
        supportsThinking: true,
        supportsVision: true,
        context: 128_000,
        maxOutput: 16_384,
        category: "fast",
        default: true,
        transport: "responses",
      },
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        supportsThinking: true,
        supportsVision: true,
        context: 400_000,
        maxOutput: 128_000,
        category: "reasoning",
        transport: "responses",
      },
      {
        id: "gpt-5.4-mini",
        name: "GPT-5.4 Mini",
        supportsThinking: true,
        supportsVision: true,
        context: 400_000,
        maxOutput: 128_000,
        category: "fast",
        transport: "responses",
      },
      {
        id: "muse-spark-1.3",
        name: "Muse Spark 1.3",
        supportsThinking: true,
        supportsVision: true,
        context: 128_000,
        maxOutput: 16_384,
        category: "reasoning",
        transport: "responses",
      },
      {
        id: "grok-4.5",
        name: "Grok 4.5",
        supportsThinking: true,
        supportsVision: true,
        context: 256_000,
        maxOutput: 32_768,
        category: "reasoning",
        transport: "responses",
      },
      {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5 (via Zen)",
        supportsThinking: true,
        supportsVision: true,
        context: 200_000,
        maxOutput: 64_000,
        category: "reasoning",
        transport: "anthropic",
      },
      {
        id: "claude-opus-5",
        name: "Claude Opus 5 (via Zen)",
        supportsThinking: true,
        supportsVision: true,
        context: 200_000,
        maxOutput: 64_000,
        category: "reasoning",
        transport: "anthropic",
      },
      {
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5 (via Zen)",
        supportsThinking: true,
        supportsVision: true,
        context: 200_000,
        maxOutput: 64_000,
        category: "fast",
        transport: "anthropic",
      },
      {
        id: "gemini-3-flash",
        name: "Gemini 3 Flash (via Zen)",
        supportsThinking: true,
        supportsVision: true,
        context: 1_000_000,
        maxOutput: 65_536,
        category: "fast",
        transport: "gemini",
      },
      {
        id: "gemini-3.1-pro",
        name: "Gemini 3.1 Pro (via Zen)",
        supportsThinking: true,
        supportsVision: true,
        context: 1_000_000,
        maxOutput: 65_536,
        category: "reasoning",
        transport: "gemini",
      },
      {
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        supportsThinking: true,
        supportsVision: false,
        context: 256_000,
        maxOutput: 32_768,
        category: "reasoning",
        transport: "chat",
      },
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        supportsThinking: true,
        supportsVision: false,
        context: 128_000,
        maxOutput: 32_768,
        category: "fast",
        transport: "chat",
      },
      {
        id: "glm-5.2",
        name: "GLM 5.2",
        supportsThinking: true,
        supportsVision: false,
        context: 200_000,
        maxOutput: 32_768,
        category: "reasoning",
        transport: "chat",
      },
      {
        id: "big-pickle",
        name: "Big Pickle (free)",
        supportsThinking: true,
        supportsVision: false,
        context: 128_000,
        maxOutput: 16_384,
        category: "creative",
        transport: "chat",
      },
    ],
    providerOptionsKey: "opencode",
  },
};

export const PROVIDER_LIST = Object.values(PROVIDERS);

export const ALL_MODELS = PROVIDER_LIST.flatMap((p) =>
  p.models.map((m) => ({ ...m, provider: p.id })),
);

export function isBuiltinProvider(id: string): id is BuiltinProviderId {
  return id in PROVIDERS;
}

export function findProvider(id: string): ProviderConfig | undefined {
  return PROVIDERS[id as BuiltinProviderId];
}

export function getDefaultModel(providerId: ProviderId): string {
  const cfg = PROVIDERS[providerId as BuiltinProviderId];
  if (!cfg?.models?.length) return "";
  return (
    cfg.models.find((m) => m.default)?.id ?? cfg.models[0].id
  );
}

export function findModel(providerId: ProviderId, modelId: string) {
  return PROVIDERS[providerId as BuiltinProviderId]?.models.find(
    (m) => m.id === modelId,
  );
}

export function modelSupportsThinking(provider: ProviderId, model: string) {
  return findModel(provider, model)?.supportsThinking ?? true;
}


export type OpencodeTransport = "responses" | "anthropic" | "chat" | "gemini";

export function getOpencodeTransport(modelId: string): OpencodeTransport {
  const explicit = PROVIDERS.opencode.models.find((m) => m.id === modelId)
    ?.transport as OpencodeTransport | undefined;
  if (explicit) return explicit;
  const id = modelId.toLowerCase();
  if (
    id.startsWith("claude-") ||
    id.startsWith("qwen3") ||
    id.startsWith("qwen-")
  )
    return "anthropic";
  if (id.startsWith("gemini-")) return "gemini";
  if (
    id.startsWith("gpt-") ||
    id.startsWith("grok") ||
    id.startsWith("muse-spark") ||
    id.startsWith("muse-")
  )
    return "responses";
  return "chat";
}
