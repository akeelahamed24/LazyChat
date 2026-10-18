import { NextResponse } from "next/server";

import { authed } from "@/lib/auth/context";
import { ensureReady } from "@/lib/brain/bootstrap";
import { FalkorClient, GraphError } from "@/lib/brain/graph";
import { buildOverview } from "@/lib/brain/overview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The overall view: every node and edge the caller may see (shared company data + their own workspaces/memory). */
export const GET = authed(async (_req, user) => {
  await ensureReady();
  try {
    const client = await FalkorClient.get();
    return NextResponse.json(await buildOverview(client, user.uid));
  } catch (err) {
    if (err instanceof GraphError) return NextResponse.json({ detail: err.message }, { status: 503 });
    throw err;
  }
});
