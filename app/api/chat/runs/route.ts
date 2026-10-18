import { after } from "next/server";
import {
  ChatRunConflictError,
  cleanupChatRuns,
  createChatRun,
  listChatRuns,
  prepareChatRun,
} from "@/lib/chat-runs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 3600;

export async function GET(req: Request) {
  cleanupChatRuns();
  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversationId") || undefined;
  return Response.json({ runs: listChatRuns(conversationId) });
}

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  try {
    const { settings, model } = await prepareChatRun(body.settings);

    const run = await createChatRun({
      messages: body.messages || [],
      settings,
      model,
      conversationId:
        typeof body.conversationId === "string" ? body.conversationId : undefined,
      trigger: body.trigger,
    });

    after(run.done);

    return Response.json(
      { runId: run.id, messageId: run.messageId },
      { status: 202 },
    );
  } catch (e: any) {
    if (e instanceof ChatRunConflictError) {
      return Response.json(
        { error: e.message, runId: e.activeRunId },
        { status: 409 },
      );
    }
    return Response.json(
      { error: e?.message || "Failed to start the reply." },
      { status: 400 },
    );
  }
}
