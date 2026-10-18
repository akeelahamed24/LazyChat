import "server-only";
import fs from "node:fs";
import path from "node:path";
import { currentUser } from "@/lib/auth/context";
import { CodeSandbox } from "@codesandbox/sdk";
import type { SandboxClient } from "@codesandbox/sdk";

// Created on first use: the SDK throws when CSB_API_KEY is missing, which must not break `next build`, the chat,
// or any route that merely imports this module.
let sdkInstance: CodeSandbox | undefined;
function sdkClient(): CodeSandbox {
  const key = process.env.CSB_API_KEY || process.env.CODESANDBOX_API_KEY;
  if (!key) throw new Error("CSB_API_KEY is not set (add it to .env.local to use sandboxes)");
  return (sdkInstance ??= new CodeSandbox(key));
}

// Ownership: sandbox id -> uid of the user who created it.
const OWNERS_FILE = path.join(process.cwd(), "data", "sandbox-owners.json");

function readOwners(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(OWNERS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function recordOwner(id: string, uid: string) {
  const owners = readOwners();
  owners[id] = uid;
  fs.mkdirSync(path.dirname(OWNERS_FILE), { recursive: true });
  fs.writeFileSync(OWNERS_FILE, JSON.stringify(owners));
}

export function assertSandboxOwner(id: string): void {
  const u = currentUser();
  if (!u) return;
  if (readOwners()[id] !== u.uid) throw new Error("Sandbox not found");
}

const clientCache = new Map<string, SandboxClient>();
const metaCache = new Map<string, any>();

async function connect(id: string): Promise<SandboxClient> {
  const cached = clientCache.get(id);
  if (cached) return cached;
  const sandbox = await sdkClient().sandboxes.resume(id);
  const client = await sandbox.connect();
  clientCache.set(id, client);
  return client;
}

async function ensureDir(client: SandboxClient, filePath: string) {
  const parts = filePath.split("/").filter(Boolean);
  let cur = "";
  for (let i = 0; i < parts.length - 1; i++) {
    cur += "/" + parts[i];
    try {
      await client.fs.mkdir(cur, true);
    } catch {
      /* ignore */
    }
  }
}

export function sandboxHeaders(extra?: Record<string, string>): Record<string, string> {
  return { ...(extra ?? {}) };
}

export async function sandboxHealth() {
  try {
    await sdkClient().sandboxes.list({ limit: 1 });
    return { ok: true, docker: true, version: "codesandbox", images: [], activeContainers: clientCache.size };
  } catch (e: any) {
    return { ok: false, docker: false, error: e?.message };
  }
}

export interface CreateSandboxOptions {
  image?: string;
  label?: string;
  env?: Record<string, string>;
  workspace?: string;
  runner?: { task: string; provider: string; model: string; engine: string; config?: any };
}

export async function createSandbox(opts: CreateSandboxOptions = {}) {
  const label = opts.label || "sandbox";
  const sandbox = await sdkClient().sandboxes.create({ title: label });
  const client = await sandbox.connect();
  clientCache.set(sandbox.id, client);
  const meta = {
    id: sandbox.id,
    containerId: sandbox.id,
    image: "codesandbox",
    state: "ready",
    label,
    createdAt: Date.now(),
    error: undefined,
    hasBrowser: false,
  };
  metaCache.set(sandbox.id, meta);
  const u = currentUser();
  if (u) recordOwner(sandbox.id, u.uid);
  return meta;
}

export async function startSandbox(id: string) {
  assertSandboxOwner(id);
  await connect(id);
  return { ok: true };
}

export async function killSandbox(id: string) {
  assertSandboxOwner(id);
  try {
    await sdkClient().sandboxes.hibernate(id);
  } catch {
    /* ignore */
  }
  clientCache.delete(id);
}

export async function deleteSandbox(id: string) {
  assertSandboxOwner(id);
  try {
    await sdkClient().sandboxes.delete(id);
  } catch {
    /* ignore */
  }
  clientCache.delete(id);
  metaCache.delete(id);
}

export async function listSandboxes() {
  let all: any = { sandboxes: [] };
  try {
    all = await sdkClient().sandboxes.list({ limit: 100 });
  } catch {
    /* ignore */
  }
  const owners = readOwners();
  const u = currentUser();
  const mapped = (all.sandboxes || []).map((s: any) => {
    const cached = metaCache.get(s.id);
    if (cached) return cached;
    return {
      id: s.id,
      containerId: s.id,
      image: "codesandbox",
      state: "ready",
      label: s.title || "sandbox",
      createdAt: s.createdAt ? new Date(s.createdAt).getTime() : Date.now(),
      error: undefined,
      hasBrowser: false,
    };
  });
  if (!u) return mapped;
  return mapped.filter((c: any) => owners[c.id] === u.uid);
}

export async function sandboxExec(id: string, command: string, opts?: { stream?: boolean; timeout?: number }) {
  assertSandboxOwner(id);
  const client = await connect(id);
  try {
    const output = await client.commands.run(command, { cwd: "/workspace" });
    return { output, stdout: output, stderr: "", exitCode: 0 };
  } catch (e: any) {
    return { output: e?.message || String(e), stdout: "", stderr: e?.message || String(e), exitCode: e?.exitCode ?? 1 };
  }
}

export async function sandboxWriteFile(id: string, filePath: string, content: string) {
  assertSandboxOwner(id);
  const client = await connect(id);
  await ensureDir(client, filePath);
  await client.fs.writeTextFile(filePath, content, { create: true, overwrite: true });
}

export async function sandboxReadFile(id: string, filePath: string): Promise<string> {
  assertSandboxOwner(id);
  const client = await connect(id);
  return await client.fs.readTextFile(filePath);
}

export async function sandboxListFiles(id: string, dirPath = "/workspace") {
  assertSandboxOwner(id);
  const client = await connect(id);
  try {
    const entries = await client.fs.readdir(dirPath);
    const out = await Promise.all(
      entries.map(async (e: any) => {
        let size: number | undefined;
        try {
          const st = await client.fs.stat(`${dirPath.replace(/\/$/, "")}/${e.name}`);
          size = st.size;
        } catch {
          /* ignore */
        }
        return { name: e.name, type: e.type, path: `${dirPath.replace(/\/$/, "")}/${e.name}`, size };
      }),
    );
    return out;
  } catch {
    return [];
  }
}

export async function sandboxDownload(id: string, filePath: string): Promise<Buffer> {
  assertSandboxOwner(id);
  const client = await connect(id);
  const data = await client.fs.readFile(filePath);
  return Buffer.from(data);
}

export async function sandboxScreenshot(id: string): Promise<string | null> {
  assertSandboxOwner(id);
  return null;
}

export function sandboxBrowserWsUrl(id: string): string {
  return "";
}

export async function sandboxResultFiles(id: string, outDir = "/workspace/out") {
  assertSandboxOwner(id);
  const files = await sandboxListFiles(id, outDir).catch(() => []);
  return files.filter((f: any) => f.type === "file");
}
