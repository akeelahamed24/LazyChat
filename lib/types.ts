export type BuiltinProviderId =
  | "anthropic"
  | "openai"
  | "google"
  | "sarvam"
  | "nvidia"
  | "ollama"
  | "lmstudio"
  | "opencode";

export type ProviderId = BuiltinProviderId | (string & {});

export type ModelCategory = "fast" | "reasoning" | "creative";

export interface ModelConfig {
  id: string;
  name: string;
  supportsThinking: boolean;
  supportsVision: boolean;
  context: number;
  maxOutput: number;
  category: ModelCategory;
  default?: boolean;
  transport?: "responses" | "anthropic" | "chat" | "gemini";
}

export interface ProviderConfig {
  id: ProviderId;
  name: string;
  tagline: string;
  glyph: string;
  keyEnv?: string;
  requiresKey: boolean;
  baseUrlEnv?: string;
  defaultBaseUrl?: string;
  models: ModelConfig[];
  providerOptionsKey?: string;
}


export interface CustomModelDef {
  id: string;
  name?: string;
  supportsThinking?: boolean;
}

export type ProviderProtocol = "openai" | "anthropic" | "gemini";

export interface CustomProviderDef {
  id: string;
  name: string;
  glyph?: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  protocol?: ProviderProtocol;
  models: CustomModelDef[];
  createdAt: number;
  updatedAt: number;
}

export type PublicCustomProvider = Omit<CustomProviderDef, "apiKey"> & {
  hasApiKey: boolean;
};

export interface ChatSettings {
  provider: ProviderId;
  model: string;
  thinking: boolean;
  temperature: number;
  maxSteps: number;
  tools: string[];
  /** Auto-compact at 80% context pressure (dsh-compaction-basic default). */
  autoCompact?: boolean;
}

export const DEFAULT_SETTINGS: ChatSettings = {
  provider: "sarvam",
  model: "sarvam-105b",
  thinking: true,
  temperature: 0.7,
  maxSteps: 14,
  tools: ["webSearch", "createArtifact", "runAgentTask", "computerUse", "companyBrain"],
  autoCompact: true,
};


export type ArtifactType =
  | "text"
  | "code"
  | "markdown"
  | "html"
  | "svg"
  | "image"
  | "pdf"
  | "docx"
  | "xlsx"
  | "csv"
  | "mermaid"
  | "table"
  | "audio";

export interface ArtifactMeta {
  id: string;
  /** Firebase uid of the creator; artifacts are private to them. */
  ownerId?: string;
  conversationId?: string;
  title: string;
  type: ArtifactType;
  filename: string;
  mime: string;
  language?: string;
  content?: string;
  createdAt: number;
  size?: number;
}


export interface SearchResult {
  title: string;
  description: string;
  url: string;
  hostname: string;
  position: number;
}


export type SandboxState =
  | "idle"
  | "starting"
  | "ready"
  | "busy"
  | "error"
  | "stopped";

export interface SandboxMeta {
  id: string;
  containerId?: string;
  image: string;
  state: SandboxState;
  label: string;
  createdAt: number;
  error?: string;
  hasBrowser: boolean;
  lastScreenshot?: string;
}


export type AgentStatus =
  | "queued"
  | "starting"
  | "running"
  | "done"
  | "failed"
  | "stopped";

export interface AgentMeta {
  id: string;
  /** Firebase uid of the user who started the agent. */
  ownerId?: string;
  label: string;
  task: string;
  provider: ProviderId;
  model: string;
  engine: "tool-loop" | "agent-sdk";
  status: AgentStatus;
  sandboxId?: string;
  conversationId?: string;
  createdAt: number;
  updatedAt: number;
  progress: number;
  log: AgentLogEntry[];
  resultFiles: ArtifactMeta[];
  error?: string;
}

export interface AgentLogEntry {
  t: number;
  level: "info" | "thinking" | "tool" | "file" | "text" | "error" | "done";
  message: string;
}


export type ChatRunStatus = "running" | "done" | "failed" | "stopped";

export interface ChatRunSummary {
  id: string;
  conversationId?: string;
  status: ChatRunStatus;
  activity: string;
  step: number;
  messageId: string;
  provider: ProviderId;
  model: string;
  startedAt: number;
  updatedAt: number;
  error?: string;
  replayable: boolean;
}


export interface SkillDef {
  id: string;
  name: string;
  description: string;
  prompt: string;
  source?: string;
  enabled: boolean;
  updatedAt: number;
}


export interface MCPServerDef {
  id: string;
  name: string;
  enabled: boolean;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  tools?: string[];
  status?: "disconnected" | "connecting" | "connected" | "error";
  error?: string;
}

export interface MCPToolInfo {
  serverId: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}


export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  provider: ProviderId;
  model: string;
  pinned?: boolean;
}
