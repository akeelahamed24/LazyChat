import "server-only";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { jsonSchema, tool, type Schema, type ToolSet } from "ai";
import type { MCPServerDef, MCPToolInfo } from "@/lib/types";
import { readJSON, writeJSON } from "@/lib/store";


interface Session {
  client: Client;
  def: MCPServerDef;
  tools: MCPToolInfo[];
}

const sessions = new Map<string, Session>();

export async function listMCPServers(): Promise<MCPServerDef[]> {
  const data = await readJSON<MCPServerDef[]>("mcp-servers.json", []);
  return data.map((d) => {
    const s = sessions.get(d.id);
    return { ...d, status: s ? "connected" : d.status || "disconnected" };
  });
}

export async function saveMCPServers(servers: MCPServerDef[]): Promise<void> {
  await writeJSON("mcp-servers.json", servers);
}

function stdioEnv(def: MCPServerDef): Record<string, string> {
  return { ...(def.env || {}) };
}

export async function connectMCPServer(def: MCPServerDef): Promise<{
  ok: boolean;
  error?: string;
  tools?: MCPToolInfo[];
}> {
  await disconnectMCPServer(def.id);
  try {
    const client = new Client(
      { name: "omnia-app", version: "0.1.0" },
      { capabilities: {} },
    );

    let transport;
    if (def.type === "stdio") {
      if (!def.command) throw new Error("stdio servers need a command");
      transport = new StdioClientTransport({
        command: def.command,
        args: def.args || [],
        env: stdioEnv(def),
      });
    } else {
      if (!def.url) throw new Error("http servers need a URL");
      transport = new StreamableHTTPClientTransport(new URL(def.url));
    }

    await client.connect(transport);
    const list = await client.listTools();

    const tools: MCPToolInfo[] = (list.tools || []).map((t) => ({
      serverId: def.id,
      name: t.name,
      description: t.description,
      inputSchema: (t.inputSchema as Record<string, unknown>) || {},
    }));

    sessions.set(def.id, { client, def: { ...def, status: "connected" }, tools });

    const servers = await listMCPServers();
    const updated = servers.map((s) =>
      s.id === def.id ? { ...s, status: "connected" as const, tools: tools.map((t) => t.name) } : s,
    );
    await writeJSON("mcp-servers.json", updated);

    return { ok: true, tools };
  } catch (e: any) {
    const servers = await readJSON<MCPServerDef[]>("mcp-servers.json", []);
    const updated = servers.map((s) =>
      s.id === def.id ? { ...s, status: "error" as const, error: e.message } : s,
    );
    await writeJSON("mcp-servers.json", updated);
    return { ok: false, error: e.message };
  }
}

export async function disconnectMCPServer(id: string): Promise<void> {
  const s = sessions.get(id);
  if (s) {
    try {
      await s.client.close();
    } catch {
    }
    sessions.delete(id);
  }
}

export async function allMCPTools(): Promise<MCPToolInfo[]> {
  const out: MCPToolInfo[] = [];
  for (const s of sessions.values()) out.push(...s.tools);
  return out;
}

/** List all available MCP resources across connected servers. */
export async function listMCPResources(): Promise<
  Array<{ uri: string; name: string; description?: string; mimeType?: string; serverId: string; serverName: string }>
> {
  const out: Array<{
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
    serverId: string;
    serverName: string;
  }> = [];
  for (const [serverId, s] of sessions) {
    try {
      const res = await s.client.listResources();
      for (const r of res?.resources || []) {
        out.push({
          uri: r.uri,
          name: r.name ?? r.uri,
          description: r.description,
          mimeType: r.mimeType,
          serverId,
          serverName: s.def.name,
        });
      }
    } catch {
      // Server might not support resources — skip
    }
  }
  return out;
}

/** List all MCP resource templates across connected servers. */
export async function listMCPResourceTemplates(): Promise<
  Array<{ uriTemplate: string; name: string; description?: string; mimeType?: string; serverId: string; serverName: string }>
> {
  const out: Array<{
    uriTemplate: string;
    name: string;
    description?: string;
    mimeType?: string;
    serverId: string;
    serverName: string;
  }> = [];
  for (const [serverId, s] of sessions) {
    try {
      const res: any = await s.client.listResourceTemplates();
      for (const t of res?.templates || []) {
        out.push({
          uriTemplate: t.uriTemplate,
          name: t.name ?? t.uriTemplate,
          description: t.description,
          mimeType: t.mimeType,
          serverId,
          serverName: s.def.name,
        });
      }
    } catch {
      // Server might not support resource templates — skip
    }
  }
  return out;
}

/** Read a specific MCP resource by URI. */
export async function readMCPResource(uri: string): Promise<{
  contents: Array<{ text?: string; blob?: string; mimeType?: string }>;
  serverId: string;
  serverName: string;
} | null> {
  for (const [serverId, s] of sessions) {
    try {
      const res = await s.client.readResource({ uri });
      if (res?.contents?.length) {
        return {
          contents: (res.contents || []).map((c: any) => ({
            text: c.text,
            blob: c.blob,
            mimeType: c.mimeType,
          })),
          serverId,
          serverName: s.def.name,
        };
      }
    } catch {
      // Try next server
    }
  }
  return null;
}

export async function buildMCPToolSet(): Promise<ToolSet> {
  const set: ToolSet = {};
  for (const [serverId, s] of sessions) {
    for (const t of s.tools) {
      const inputSchema = (t.inputSchema || {}) as Record<string, unknown>;
      set[t.name] = tool({
        description: `[MCP:${s.def.name}] ${t.description || t.name}`,
        inputSchema: jsonSchema(inputSchema as any) as Schema<Record<string, unknown>>,
        execute: async (args: Record<string, unknown>) => {
          try {
            const res = await s.client.callTool({
              name: t.name,
              arguments: args,
            });
            return formatMCPResult(res);
          } catch (e: any) {
            return `MCP tool error: ${e.message}`;
          }
        },
      });
    }
  }
  return set;
}

function formatMCPResult(res: any): string {
  const parts: string[] = [];
  if (res.content) {
    for (const c of Array.isArray(res.content) ? res.content : [res.content]) {
      if (c.type === "text") parts.push(c.text);
      else if (c.type === "image" && c.data) parts.push(`[image ${c.mimeType}]`);
      else if (c.type === "resource") parts.push(`[resource ${c.uri}]`);
      else parts.push(JSON.stringify(c));
    }
  }
  if (res.isError) {
    return `[MCP error] ${parts.join("\n")}`;
  }
  return parts.join("\n");
}
