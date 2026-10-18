import { NextResponse } from "next/server";
import { readJSON } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ScheduleSummary {
  id: string;
  title: string;
  prompt: string;
  next_delivery: number;
  delivered: number;
  active: boolean;
  created_at: number;
  updated_at: number;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const convId = searchParams.get("conversationId");

  const schedules: any[] = await readJSON("schedules.json", []);
  const pending: any[] = await readJSON("pending-reminders.json", []);

  const list: ScheduleSummary[] = schedules
    .filter((s) => (convId ? s.conversationId === convId : true))
    .map((s) => ({
      id: s.id,
      title: s.title,
      prompt: s.prompt,
      next_delivery: s.nextDelivery,
      delivered: s.deliveryCount,
      active: s.active,
      created_at: s.createdAt,
      updated_at: s.updatedAt,
    }))
    .sort((a, b) => a.next_delivery - b.next_delivery);

  return NextResponse.json({ schedules: list, pending_reminders: pending.length });
}
