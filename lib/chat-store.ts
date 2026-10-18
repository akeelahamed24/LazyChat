/**
 * Conversations in Firestore, written as the signed-in user (see lib/auth/token.ts).
 *
 *   conversations/{id}                 metadata: ownerId, orgId, title, timestamps, model, usage, lastRun
 *   conversations/{id}/messages/{i_c}  one UI message per doc (chunked past 250k chars, so no 1 MB limit)
 *
 * Saves are incremental: only messages whose hash changed are rewritten. If Firestore rejects a write because
 * the user's token expired (a background run outlived it), the whole conversation is parked in data/outbox/
 * and pushed on the owner's next request, so nothing is lost.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { currentUser } from "@/lib/auth/context";
import { latestToken } from "@/lib/auth/token";
import { FirestoreError, commit, getDoc, listDocs, queryEquals, type Doc, type Plain, type Write } from "@/lib/firestore-rest";

export interface StoredConversation {
  /** Firebase uid of the owner and the org they belonged to when it was created. */
  ownerId?: string;
  orgId?: string | null;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  provider: string;
  model: string;
  messages: unknown[];
  /** Cumulative token usage across runs (dsh-style accounting). */
  usage?: { inputTokens: number; outputTokens: number };
  /** Last finished run: freshness for speed + context pressure. */
  lastRun?: { inputTokens: number; outputTokens: number; decodeMs: number; at: number };
}

export type ConversationMeta = Omit<StoredConversation, "messages">;

export const CHUNK_CHARS = 250_000;
const pad = (n: number, w = 6) => String(n).padStart(w, "0");
const sha = (s: string) => crypto.createHash("sha1").update(s).digest("hex");

// ---- pure helpers (unit-tested) -----------------------------------------------------------------

export interface MsgDoc {
  id: string;
  data: { idx: number; chunk: number; total: number; h: string; json: string };
}

/** Split messages into Firestore docs; ids sort in message order. */
export function toMessageDocs(messages: unknown[]): MsgDoc[] {
  const out: MsgDoc[] = [];
  messages.forEach((m, idx) => {
    const json = JSON.stringify(m) ?? "null";
    const h = sha(json);
    const total = Math.max(1, Math.ceil(json.length / CHUNK_CHARS));
    for (let c = 0; c < total; c++) {
      out.push({ id: `${pad(idx)}_${pad(c, 3)}`, data: { idx, chunk: c, total, h, json: json.slice(c * CHUNK_CHARS, (c + 1) * CHUNK_CHARS) } });
    }
  });
  return out;
}

/** Reassemble messages from stored docs (any order). */
export function fromMessageDocs(docs: Array<{ data: Record<string, Plain> }>): unknown[] {
  const byIdx = new Map<number, string[]>();
  for (const d of [...docs].sort((a, b) => Number(a.data.idx) * 1000 + Number(a.data.chunk) - (Number(b.data.idx) * 1000 + Number(b.data.chunk)))) {
    const i = Number(d.data.idx);
    byIdx.set(i, [...(byIdx.get(i) ?? []), String(d.data.json ?? "")]);
  }
  return [...byIdx.keys()].sort((a, b) => a - b).map((i) => JSON.parse(byIdx.get(i)!.join("")));
}

/** Writes needed to turn `existing` (id -> hash) into `next`: changed/new docs, plus ids to delete. */
export function diffMessageDocs(existing: Map<string, string>, next: MsgDoc[]): { upserts: MsgDoc[]; deletes: string[] } {
  const keep = new Set(next.map((d) => d.id));
  return {
    upserts: next.filter((d) => existing.get(d.id) !== d.data.h),
    deletes: [...existing.keys()].filter((id) => !keep.has(id)),
  };
}

// ---- token + outbox -------------------------------------------------------------------------------

function tokenFor(uid: string): string {
  const t = latestToken(uid);
  if (!t) throw new FirestoreError(401, "No valid sign-in token for this user");
  return t;
}

const outboxDir = (uid: string) => path.join(process.cwd(), "data", "outbox", uid.replace(/[^A-Za-z0-9_-]/g, "_"));
const outboxFile = (uid: string, id: string) => path.join(outboxDir(uid), `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

function parkInOutbox(conv: StoredConversation) {
  fs.mkdirSync(outboxDir(conv.ownerId!), { recursive: true });
  fs.writeFileSync(outboxFile(conv.ownerId!, conv.id), JSON.stringify(conv));
}

function readOutbox(uid: string, id: string): StoredConversation | null {
  try {
    return JSON.parse(fs.readFileSync(outboxFile(uid, id), "utf8")) as StoredConversation;
  } catch {
    return null;
  }
}

function clearOutbox(uid: string, id: string) {
  try {
    fs.unlinkSync(outboxFile(uid, id));
  } catch {
    /* none */
  }
}

// ---- caches ---------------------------------------------------------------------------------------

/** id -> (message doc id -> hash) as last seen in Firestore, so saves can be incremental. */
const synced = new Map<string, Map<string, string>>();
const metaCache = new Map<string, { at: number; meta: ConversationMeta | null }>();
const META_TTL = 20_000;

const metaFrom = (d: Doc): ConversationMeta => ({
  id: d.id,
  ownerId: String(d.data.ownerId ?? ""),
  orgId: (d.data.orgId as string | null) ?? null,
  title: String(d.data.title ?? ""),
  createdAt: Number(d.data.createdAt ?? 0),
  updatedAt: Number(d.data.updatedAt ?? 0),
  provider: String(d.data.provider ?? ""),
  model: String(d.data.model ?? ""),
  usage: (d.data.usage as ConversationMeta["usage"]) ?? undefined,
  lastRun: (d.data.lastRun as ConversationMeta["lastRun"]) ?? undefined,
});

function who(uid?: string): string | undefined {
  return uid ?? currentUser()?.uid;
}

// ---- public API -------------------------------------------------------------------------------------

/** Metadata only. null if missing or not owned by `ownerId` (default: the current user). */
export async function getConversationMeta(id: string, ownerId?: string): Promise<ConversationMeta | null> {
  const uid = who(ownerId);
  if (!uid) return null;
  const parked = readOutbox(uid, id);
  if (parked) {
    const { messages: _m, ...meta } = parked;
    void _m;
    return meta;
  }
  const hit = metaCache.get(id);
  if (hit && Date.now() - hit.at < META_TTL) return hit.meta?.ownerId === uid ? hit.meta : null;
  let meta: ConversationMeta | null = null;
  try {
    const d = await getDoc(tokenFor(uid), `conversations/${id}`);
    meta = d ? metaFrom(d) : null;
  } catch (e) {
    // The rules answer 403 for someone else's conversation: indistinguishable from "not found" to the caller.
    if (e instanceof FirestoreError && e.status === 403) return null;
    throw e;
  }
  metaCache.set(id, { at: Date.now(), meta });
  return meta && meta.ownerId === uid ? meta : null;
}

export async function getConversation(id: string, ownerId?: string): Promise<StoredConversation | null> {
  const uid = who(ownerId);
  if (!uid) return null;
  const parked = readOutbox(uid, id);
  if (parked) return parked;
  const meta = await getConversationMeta(id, uid);
  if (!meta) return null;
  let docs: Doc[];
  try {
    docs = await listDocs(tokenFor(uid), `conversations/${id}/messages`);
  } catch (e) {
    if (e instanceof FirestoreError && e.status === 403) return null; // not ours / not there
    throw e;
  }
  synced.set(id, new Map(docs.map((d) => [d.id, String(d.data.h ?? "")])));
  return { ...meta, messages: fromMessageDocs(docs) };
}

/** The user's conversations (metadata only, newest first). */
export async function listConversations(ownerId?: string): Promise<ConversationMeta[]> {
  const uid = who(ownerId);
  if (!uid) return [];
  const byId = new Map<string, ConversationMeta>();
  try {
    for (const d of await queryEquals(tokenFor(uid), "conversations", "ownerId", uid)) byId.set(d.id, metaFrom(d));
  } catch (e) {
    if (!(e instanceof FirestoreError && e.authRelated)) throw e;
  }
  try {
    for (const f of fs.readdirSync(outboxDir(uid))) {
      const c = readOutbox(uid, f.replace(/[.]json$/, ""));
      if (c) {
        const { messages: _m, ...meta } = c;
        void _m;
        byId.set(c.id, meta);
      }
    }
  } catch {
    /* no outbox */
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveConversation(
  conv: StoredConversation,
  owner?: { uid: string; orgId: string | null },
): Promise<void> {
  const cu = currentUser();
  const uid = owner?.uid ?? conv.ownerId ?? cu?.uid;
  if (!uid) throw new Error("saveConversation needs a signed-in owner");
  const orgId = owner?.orgId ?? conv.orgId ?? cu?.orgId ?? null;
  const prev = await getConversationMeta(conv.id, uid).catch(() => null);
  const full: StoredConversation = {
    ...conv,
    ownerId: uid,
    orgId: prev?.orgId ?? orgId,
    createdAt: prev?.createdAt ?? conv.createdAt,
  };

  try {
    const token = tokenFor(uid);
    if (!synced.has(conv.id)) {
      const docs = prev ? await listDocs(token, `conversations/${conv.id}/messages`) : [];
      synced.set(conv.id, new Map(docs.map((d) => [d.id, String(d.data.h ?? "")])));
    }
    const { upserts, deletes } = diffMessageDocs(synced.get(conv.id)!, toMessageDocs(full.messages ?? []));
    const writes: Write[] = [
      {
        set: {
          path: `conversations/${conv.id}`,
          data: {
            ownerId: uid,
            orgId: full.orgId ?? null,
            title: full.title,
            createdAt: full.createdAt,
            updatedAt: full.updatedAt,
            provider: full.provider,
            model: full.model,
            usage: full.usage ?? null,
            lastRun: full.lastRun ?? null,
            messageCount: (full.messages ?? []).length,
          },
        },
      },
      ...upserts.map((d) => ({ set: { path: `conversations/${conv.id}/messages/${d.id}`, data: d.data } }) as Write),
      ...deletes.map((id) => ({ delete: { path: `conversations/${conv.id}/messages/${id}` } }) as Write),
    ];
    await commit(token, writes);
    const map = synced.get(conv.id)!;
    for (const d of upserts) map.set(d.id, d.data.h);
    for (const id of deletes) map.delete(id);
    const { messages: _m, ...meta } = full;
    void _m;
    metaCache.set(conv.id, { at: Date.now(), meta });
    clearOutbox(uid, conv.id);
  } catch (e) {
    // Expired token / network blip: keep the data locally and retry on the owner's next request.
    if (e instanceof FirestoreError ? e.status === 401 : e instanceof TypeError) {
      synced.delete(conv.id);
      parkInOutbox(full);
      return;
    }
    throw e;
  }
}

export async function deleteConversation(id: string, ownerId?: string): Promise<void> {
  const uid = who(ownerId);
  if (!uid) return;
  clearOutbox(uid, id);
  const token = tokenFor(uid);
  const msgs = await listDocs(token, `conversations/${id}/messages`).catch(() => []);
  // Messages first: their rules look at the parent, which must still exist.
  await commit(token, msgs.map((d) => ({ delete: { path: `conversations/${id}/messages/${d.id}` } })));
  // The rules read `resource.data`, so deleting a document that does not exist is answered with 403. A chat that
  // only ever lived in the outbox has no Firestore document: check first, and treat "gone" as success.
  const exists = await getDoc(token, `conversations/${id}`).then((d) => !!d, () => false);
  if (exists) await commit(token, [{ delete: { path: `conversations/${id}` } }]);
  synced.delete(id);
  metaCache.delete(id);
}

export async function clearConversations(ownerId?: string): Promise<void> {
  const uid = who(ownerId);
  if (!uid) return;
  for (const c of await listConversations(uid)) await deleteConversation(c.id, uid);
}

const lastFlush = new Map<string, number>();

/** Push parked conversations for this user (called from authed requests, at most once a minute). */
export async function flushOutbox(uid: string): Promise<void> {
  if (Date.now() - (lastFlush.get(uid) ?? 0) < 60_000) return;
  lastFlush.set(uid, Date.now());
  let files: string[] = [];
  try {
    files = fs.readdirSync(outboxDir(uid));
  } catch {
    return;
  }
  for (const f of files) {
    const conv = readOutbox(uid, f.replace(/[.]json$/, ""));
    if (!conv) continue;
    clearOutbox(uid, conv.id);
    await saveConversation(conv, { uid, orgId: conv.orgId ?? null }).catch(() => {});
  }
}
