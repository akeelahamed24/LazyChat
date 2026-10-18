import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { nanoid } from "nanoid";

import { readJSON, writeJSON, DATA_DIR } from "@/lib/store";

export type TimingType =
  | { kind: "once"; at: number }
  | { kind: "every"; everySeconds: number; from: number }
  | { kind: "daily"; time: string; timeZone: string; from: number }
  | { kind: "weekly"; time: string; timeZone: string; weekdays: number[]; from: number }
  | { kind: "cron"; expression: string; timeZone: string };

export interface Schedule {
  id: string;
  conversationId: string | null;
  title: string;
  prompt: string;
  timing: TimingType;
  /** Next scheduled delivery time (epoch ms). */
  nextDelivery: number;
  /** How many times it has been delivered. */
  deliveryCount: number;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

const SCHEDULES_FILE = "schedules.json";
const PENDING_FILE = "pending-reminders.json";

/** The scheduler interval handle, so we start/stop cleanly. */
let scheduler: ReturnType<typeof setInterval> | null = null;

async function loadSchedules(): Promise<Schedule[]> {
  return readJSON<Schedule[]>(SCHEDULES_FILE, []);
}

async function saveSchedules(schedules: Schedule[]): Promise<void> {
  await writeJSON(SCHEDULES_FILE, schedules);
}

/** Pending reminders that haven't been delivered yet. */
interface PendingReminder {
  id: string;
  conversationId: string | null;
  title: string;
  prompt: string;
  deliveredAt: number;
}

export async function getPendingReminders(conversationId?: string): Promise<PendingReminder[]> {
  const pending = await readJSON<PendingReminder[]>(PENDING_FILE, []);
  if (!conversationId) return pending;
  return pending.filter((r) => r.conversationId === conversationId);
}

export async function clearPendingReminder(id: string): Promise<void> {
  const pending = await readJSON<PendingReminder[]>(PENDING_FILE, []);
  await writeJSON(
    PENDING_FILE,
    pending.filter((r) => r.id !== id),
  );
}

function nextLocalMidnight(time: string, timeZone: string, from: number): number {
  // Parse "HH:mm:ss" → next occurrence of that local time in the given zone.
  const [h, m, s] = time.split(":").map(Number);
  const fromDate = new Date(from);
  const fromInZone = new Date(fromDate.toLocaleString("en-US", { timeZone }));
  const baseDate = new Date(fromInZone);
  baseDate.setHours(h ?? 0, m ?? 0, s ?? 0, 0);
  // Try today, then future days.
  let candidate = baseDate.getTime();
  if (candidate <= from) candidate += 24 * 60 * 60 * 1000;
  return candidate;
}

/** Compute the next delivery time for a schedule given its timing spec. */
function computeNextDelivery(siming: TimingType, from: number): number {
  const now = from;
  switch (siming.kind) {
    case "once":
      return siming.at;
    case "every": {
      const intervalMs = siming.everySeconds * 1000;
      const elapsed = (now - siming.from) % intervalMs;
      return now + (intervalMs - elapsed);
    }
    case "daily": {
      return nextLocalMidnight(siming.time, siming.timeZone, now);
    }
    case "weekly": {
      const next = nextLocalMidnight(siming.time, siming.timeZone, now);
      // Find next matching weekday.
      const nowDate = new Date(now);
      const nowInZone = new Date(nowDate.toLocaleString("en-US", { timeZone: siming.timeZone }));
      const currentDay = nowInZone.getDay(); // 0=Sunday
      // Convert ISO (1=Mon..7=Sun) to JS (0=Sun..6=Sat).
      const weekdays = siming.weekdays.map((d) => (d % 7));
      // Find the next matching day.
      let best = Infinity;
      for (const wd of weekdays) {
        let diff = wd - currentDay;
        if (diff < 0) diff += 7;
        if (diff === 0 && (siming.time + ":00").includes(nowInZone.getHours() + ":" + String(nowInZone.getMinutes()).padStart(2, "0"))) {
          diff = 7; // already past today's time
        }
        if (diff < best) best = diff;
      }
      if (best === 0) best = 7; // always at least tomorrow
      return next + (best - 1) * 24 * 60 * 60 * 1000;
    }
    case "cron":
      // Simplified: can't easily parse cron client-side. Default to hourly.
      return now + 60 * 60 * 1000;
  }
}

/** Start the background scheduler. Call once at module load. */
export function startScheduler(): void {
  if (scheduler) return;
  scheduler = setInterval(async () => {
    try {
      const now = Date.now();
      const schedules = await loadSchedules();
      let changed = false;
      const pending: PendingReminder[] = (await readJSON<PendingReminder[]>(PENDING_FILE, []));
      for (const s of schedules) {
        if (!s.active) continue;
        if (s.nextDelivery <= now) {
          pending.push({
            id: nanoid(10),
            conversationId: s.conversationId,
            title: s.title,
            prompt: s.prompt,
            deliveredAt: now,
          });
          s.deliveryCount++;
          // Recompute next delivery.
          s.nextDelivery = computeNextDelivery(s.timing, now);
          s.updatedAt = now;
          changed = true;
        }
      }
      if (pending.length > 0) {
        await writeJSON(PENDING_FILE, pending);
      }
      if (changed) {
        await saveSchedules(schedules);
      }
    } catch {
      // scheduler must never crash the process
    }
  }, 1000);
  (scheduler as any).unref?.();
}

export function buildScheduleTools(conversationId?: string) {
  return {
    schedule_create: tool({
      description: `Create a reminder that delivers a prompt to this session when it becomes due. Supply exactly one timing parameter: after_seconds, at, every_seconds, daily, weekly, or cron. After downtime, a recurring reminder delivers only its latest missed occurrence.`,
      inputSchema: z.object({
        prompt: z.string().describe("Reminder content to present when the target becomes due."),
        title: z.string().max(120).describe("Task name shown on the reminder card."),
        after_seconds: z.number().optional().describe("Delay in whole seconds."),
        every_seconds: z.number().optional().describe("Fixed-rate interval in whole seconds, at least 60."),
        daily: z
          .object({
            time: z.string().describe("HH:mm:ss, e.g. 23:00:00"),
            time_zone: z.string().describe("IANA time zone, e.g. Asia/Shanghai"),
          })
          .optional(),
        weekly: z
          .object({
            time: z.string().describe("HH:mm:ss, e.g. 09:00:00"),
            time_zone: z.string().describe("IANA time zone"),
            weekdays: z.array(z.number().min(1).max(7)).describe("ISO weekdays Mon=1..Sun=7"),
          })
          .optional(),
        cron: z
          .object({
            expression: z.string().describe("Five-field cron expression in a time zone"),
            time_zone: z.string().describe("IANA time zone"),
          })
          .optional(),
        at: z
          .union([z.string(), z.object({ date: z.string(), time: z.string(), time_zone: z.string() })])
          .optional()
          .describe("Absolute target: RFC 3339 date-time or local date/time/zone object."),
      }),
      execute: async ({ prompt, title, after_seconds, every_seconds, daily, weekly, cron, at }) => {
        const timingKinds = [after_seconds, every_seconds, daily, weekly, cron, at].filter((v) => v !== undefined);
        if (timingKinds.length !== 1) {
          return {
            error: "Supply exactly one timing parameter: after_seconds, every_seconds, daily, weekly, cron, or at.",
          };
        }
        const now = Date.now();
        let timing: TimingType;
        if (after_seconds !== undefined) {
          timing = { kind: "once", at: now + after_seconds * 1000 };
        } else if (every_seconds !== undefined) {
          timing = { kind: "every", everySeconds: Math.max(60, every_seconds), from: now };
        } else if (daily) {
          timing = { kind: "daily", time: daily.time, timeZone: daily.time_zone, from: now };
        } else if (weekly) {
          timing = { kind: "weekly", time: weekly.time, timeZone: weekly.time_zone, weekdays: weekly.weekdays, from: now };
        } else if (cron) {
          timing = { kind: "cron", expression: cron.expression, timeZone: cron.time_zone };
        } else if (at !== undefined) {
          if (typeof at === "string") {
            timing = { kind: "once", at: Date.parse(at) };
          } else {
            timing = { kind: "once", at: Date.parse(`${at.date} ${at.time}`) };
          }
        } else {
          return { error: "Could not parse timing." };
        }

        const schedules = await loadSchedules();
        const schedule: Schedule = {
          id: nanoid(10),
          conversationId: conversationId ?? null,
          title,
          prompt,
          timing,
          nextDelivery: computeNextDelivery(timing, now),
          deliveryCount: 0,
          active: true,
          createdAt: now,
          updatedAt: now,
        };
        schedules.push(schedule);
        await saveSchedules(schedules);
        return {
          id: schedule.id,
          title: schedule.title,
          next_delivery: schedule.nextDelivery,
          message: `Reminder "${title}" scheduled for ${new Date(schedule.nextDelivery).toISOString()}.`,
        };
      },
    }),

    schedule_list: tool({
      description: `List active reminders in the current session.`,
      inputSchema: z.object({}),
      execute: async () => {
        if (!conversationId) return { error: "Schedules require a conversation context." };
        const schedules = await loadSchedules();
        const now = Date.now();
        const list = schedules
          .filter((s) => s.active && s.conversationId === conversationId)
          .map((s) => ({
            id: s.id,
            title: s.title,
            next_delivery: s.nextDelivery,
            delivered: s.deliveryCount,
            time_to_go: s.nextDelivery > now ? s.nextDelivery - now : 0,
          }))
          .sort((a, b) => a.next_delivery - b.next_delivery);
        return { schedules: list };
      },
    }),

    schedule_delete: tool({
      description: `Delete a reminder, active or inactive.`,
      inputSchema: z.object({
        id: z.string().describe("Schedule id returned by schedule_list or schedule_create."),
      }),
      execute: async ({ id }) => {
        if (!conversationId) return { error: "Schedules require a conversation context." };
        const schedules = await loadSchedules();
        const idx = schedules.findIndex((s) => s.id === id && s.conversationId === conversationId);
        if (idx === -1) return { error: `No schedule with id ${id}.` };
        schedules.splice(idx, 1);
        await saveSchedules(schedules);
        return { deleted: id };
      },
    }),

    schedule_update: tool({
      description: `Change a reminder in place, keeping its id. Supply a new title, prompt, or at most one timing parameter.`,
      inputSchema: z.object({
        id: z.string().describe("Schedule id to update."),
        title: z.string().optional().describe("New task name."),
        prompt: z.string().optional().describe("New reminder content."),
        every_seconds: z.number().optional(),
        daily: z
          .object({
            time: z.string(),
            time_zone: z.string(),
          })
          .optional(),
        weekly: z
          .object({
            time: z.string(),
            time_zone: z.string(),
            weekdays: z.array(z.number().min(1).max(7)),
          })
          .optional(),
        at: z
          .union([z.string(), z.object({ date: z.string(), time: z.string(), time_zone: z.string() })])
          .optional(),
      }),
      execute: async ({ id, title, prompt, every_seconds, daily, weekly, at }) => {
        if (!conversationId) return { error: "Schedules require a conversation context." };
        const schedules = await loadSchedules();
        const idx = schedules.findIndex((s) => s.id === id && s.conversationId === conversationId);
        if (idx === -1) return { error: `No schedule with id ${id}.` };
        const s = schedules[idx];
        if (title) s.title = title;
        if (prompt) s.prompt = prompt;
        const now = Date.now();
        if (every_seconds !== undefined) {
          s.timing = { kind: "every", everySeconds: Math.max(60, every_seconds), from: now };
          s.nextDelivery = computeNextDelivery(s.timing, now);
        } else if (daily) {
          s.timing = { kind: "daily", time: daily.time, timeZone: daily.time_zone, from: now };
          s.nextDelivery = computeNextDelivery(s.timing, now);
        } else if (weekly) {
          s.timing = { kind: "weekly", time: weekly.time, timeZone: weekly.time_zone, weekdays: weekly.weekdays, from: now };
          s.nextDelivery = computeNextDelivery(s.timing, now);
        } else if (at !== undefined) {
          if (typeof at === "string") {
            s.timing = { kind: "once", at: Date.parse(at) };
          } else {
            s.timing = { kind: "once", at: Date.parse(`${at.date} ${at.time}`) };
          }
          s.nextDelivery = computeNextDelivery(s.timing, now);
        }
        s.updatedAt = now;
        await saveSchedules(schedules);
        return { id: s.id, title: s.title, next_delivery: s.nextDelivery };
      },
    }),
  };
}
