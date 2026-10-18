import "server-only";

import { tool } from "ai";
import { z } from "zod";

/**
 * Plan mode: the model drafts a plan and waits for explicit approval
 * before executing. Ported from dsh-plan-mode.
 *
 * State is kept in-memory per conversation; it is intentionally ephemeral —
 * plan mode is a chat-phase toggle, not durable state.
 */
interface PlanState {
  active: boolean;
  plan: string;
}

const plans = new Map<string, PlanState>();

export function isPlanMode(conversationId: string): boolean {
  return plans.get(conversationId)?.active ?? false;
}

export function getPlan(conversationId: string): string | null {
  return plans.get(conversationId)?.plan ?? null;
}

export function enterPlanMode(conversationId: string): void {
  plans.set(conversationId, { active: true, plan: "" });
}

export function exitPlanMode(conversationId: string): string | null {
  const s = plans.get(conversationId);
  if (!s) return null;
  plans.delete(conversationId);
  return s.plan;
}

export function buildPlanModeTool(opts: {
  conversationId?: string;
  runId?: string;
}) {
  return {
    exit_plan_mode: tool({
      description: `Submit the plan and exit plan mode. The model has produced a plan as text; this tool call commits it so execution can begin. Only available in plan mode (when the system has toggled planning on).`,
      inputSchema: z.object({
        plan: z.string().describe("The plan content the model drafted for execution."),
      }),
      execute: async ({ plan }) => {
        if (!opts.conversationId) {
          return { error: "Plan mode requires a conversation context." };
        }
        const state = plans.get(opts.conversationId);
        if (!state || !state.active) {
          return { error: "Not in plan mode. Use /plan to enter plan mode." };
        }
        state.plan = plan;
        state.active = false;
        return { plan_submitted: true, plan, message: "Plan submitted. Awaiting approval to execute." };
      },
    }),
  };
}
