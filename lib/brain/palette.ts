/**
 * One palette and one naming scheme for every graph in the product (Brain overview, answer subgraphs, legends).
 * No server-only imports: the UI and the API both use it.
 *
 * Colours are a categorical set: each node type gets its own clearly different hue, all mid-luminance so they read
 * on both the dark and the light theme.
 */

export const NODE_COLORS: Record<string, string> = {
  // company
  Person: "#3b82f6",
  Team: "#8b5cf6",
  Service: "#10b981",
  Repo: "#f97316",
  Ticket: "#f59e0b",
  Decision: "#ec4899",
  Document: "#06b6d4",
  Message: "#94a3b8",
  // conversations and memory
  Session: "#a855f7",
  Turn: "#6366f1",
  EpisodicMemory: "#22c55e",
  SemanticMemory: "#84cc16",
  ProceduralMemory: "#14b8a6",
  Finding: "#ef4444",
  AgentHandoff: "#f472b6",
  // workspaces
  Workspace: "#0ea5e9",
  AgentSession: "#7c3aed",
  Todo: "#eab308",
  WorkspacePlan: "#2dd4bf",
  WorkspaceDecision: "#fb7185",
  CodeChange: "#a3e635",
  CommandRun: "#64748b",
  ErrorFix: "#dc2626",
  SessionSummary: "#c084fc",
  WsPreference: "#e879f9",
  SharedMemory: "#4ade80",
  Dependency: "#fdba74",
  WsLink: "#67e8f9",
};

export const REL_COLORS: Record<string, string> = {
  MEMBER_OF: "#8b5cf6",
  OWNS: "#10b981",
  AUTHORED: "#3b82f6",
  ASSIGNED_TO: "#f59e0b",
  MENTIONS: "#94a3b8",
  DISCUSSED_IN: "#64748b",
  DECIDED_BY: "#ec4899",
  RELATES_TO: "#06b6d4",
  DEPENDS_ON: "#ef4444",
  KNOWS_ABOUT: "#22c55e",
  IN_REPO: "#f97316",
  BLOCKED_BY: "#dc2626",
  CONTAINS: "#6366f1",
  IN_WORKSPACE: "#0ea5e9",
  RECORDED_IN: "#7c3aed",
  CONSOLIDATED_INTO: "#84cc16",
  REPLACED_BY: "#fb7185",
};

export const FALLBACK_NODE_COLOR = "#64748b";
export const FALLBACK_REL_COLOR = "#94a3b8";

export const nodeColor = (label?: string, fallback?: string) => (label && NODE_COLORS[label]) || fallback || FALLBACK_NODE_COLOR;
export const relColor = (type?: string) => (type && REL_COLORS[type]) || FALLBACK_REL_COLOR;

/** Where a label belongs in the overview legend. */
export const LABEL_GROUPS: Record<string, "Company" | "Workspaces" | "Memory & chats"> = {
  Person: "Company", Team: "Company", Service: "Company", Repo: "Company", Ticket: "Company", Decision: "Company", Document: "Company", Message: "Company",
  Workspace: "Workspaces", AgentSession: "Workspaces", Todo: "Workspaces", WorkspacePlan: "Workspaces", WorkspaceDecision: "Workspaces",
  CodeChange: "Workspaces", CommandRun: "Workspaces", ErrorFix: "Workspaces", SessionSummary: "Workspaces", WsPreference: "Workspaces", Dependency: "Workspaces", WsLink: "Workspaces",
  Session: "Memory & chats", Turn: "Memory & chats", EpisodicMemory: "Memory & chats", SemanticMemory: "Memory & chats", ProceduralMemory: "Memory & chats",
  Finding: "Memory & chats", AgentHandoff: "Memory & chats", SharedMemory: "Memory & chats",
};
export const groupOf = (label: string) => LABEL_GROUPS[label] ?? "Company";

/** Human-readable names for labels in the legend (CamelCase -> words). */
export const prettyLabel = (label: string) => label.replace(/([a-z])([A-Z])/g, "$1 $2");

const clip = (s: unknown, n = 44) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * A short, meaningful name for any node, so graphs never show raw ids or "Node". Falls back through name/title/key.
 */
export function displayName(label: string, props: Record<string, unknown>, id: string): string {
  const p = props ?? {};
  const first = (...keys: string[]) => keys.map((k) => str(p[k])).find((v) => v.trim());
  let name: string | undefined;
  switch (label) {
    case "Ticket": {
      const key = str(p.key) || id.split(":")[1] || "";
      name = [key, str(p.title)].filter(Boolean).join(" · ");
      break;
    }
    case "Message":
      name = [str(p.channel), clip(p.content, 36)].filter(Boolean).join(": ");
      break;
    case "Turn":
      name = `${str(p.role) || "turn"}: ${clip(p.content, 34)}`;
      break;
    case "Session": {
      const when = str(p.started_at).slice(0, 10);
      name = `Chat${when ? " " + when : ""}`;
      break;
    }
    case "AgentHandoff":
      name = `${str(p.from_agent) || "agent"} → ${str(p.to_agent) || "agent"}`;
      break;
    case "Finding":
      name = `${str(p.agent) || "finding"}: ${clip(p.content, 34)}`;
      break;
    case "EpisodicMemory":
      name = first("summary");
      break;
    case "SemanticMemory":
      name = first("fact");
      break;
    case "ProceduralMemory":
      name = first("task_pattern");
      break;
    case "AgentSession":
      name = first("goal") || "Agent session";
      break;
    case "Todo":
    case "SessionSummary":
    case "WsPreference":
    case "SharedMemory":
      name = first("text");
      break;
    case "CodeChange":
      name = first("path", "summary");
      break;
    case "CommandRun":
      name = first("command");
      break;
    case "ErrorFix":
      name = first("error");
      break;
    case "WorkspacePlan":
    case "WorkspaceDecision":
      name = first("title");
      break;
    default:
      name = first("name", "title", "key");
  }
  return clip(name || first("name", "title", "text", "key") || id.split(":").slice(1).join(":") || id);
}
