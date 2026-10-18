/**
 * Company Brain configuration.
 *
 * All values come from the environment so the same build runs locally and
 * deployed. Next.js loads `.env.local` automatically; the names mirror the
 * former Python backend so existing `.env` files keep working.
 */

export type LlmProvider = "sarvam" | "anthropic" | "mock";

function env(name: string, fallback = ""): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

export function brainConfig() {
  const sarvamKey = env("SARVAM_API_KEY");
  const anthropicKey = env("ANTHROPIC_API_KEY");
  const forced = env("LLM_PROVIDER").toLowerCase();
  const forceMock = env("LLM_FORCE_MOCK") === "1";

  let provider: LlmProvider;
  if (forceMock) provider = "mock";
  else if (forced === "sarvam" || forced === "anthropic" || forced === "mock") {
    provider = forced;
  } else if (sarvamKey) provider = "sarvam";
  else if (anthropicKey) provider = "anthropic";
  else provider = "mock";

  return {
    falkordb: {
      host: env("FALKORDB_HOST", "localhost"),
      port: Number(env("FALKORDB_PORT", "6379")),
      graphName: env("FALKORDB_GRAPH_NAME", "company_brain"),
      username: env("FALKORDB_USERNAME"),
      password: env("FALKORDB_PASSWORD"),
      tls: env("FALKORDB_TLS") === "true" || env("FALKORDB_TLS") === "1",
    },
    provider,
    sarvam: {
      apiKey: sarvamKey,
      model: env("SARVAM_MODEL", "sarvam-105b"),
      baseUrl: env("SARVAM_BASE_URL", "https://api.sarvam.ai/v1"),
    },
    anthropic: {
      apiKey: anthropicKey,
      model: env("ANTHROPIC_MODEL", "claude-sonnet-4-5"),
    },
  } as const;
}

export type BrainConfig = ReturnType<typeof brainConfig>;
