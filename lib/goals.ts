import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { nanoid } from "nanoid";

import { readJSON, writeJSON } from "@/lib/store";

export type GoalAction = "edit" | "pause" | "resume" | "complete" | "blocked";
export type GoalStatus = "active" | "paused" | "completed" | "blocked";

export interface Goal {
  id: string;
  conversationId: string;
  objective: string;
  status: GoalStatus;
  /** Current round (auto-continuation count). */
  round: number;
  /** Max auto-continuation rounds (0 = unlimited within session). */
  maxGoalRounds?: number;
  /** Reason why blocked (only for 'blocked' status). */
  blockedReason?: string;
  createdAt: number;
  updatedAt: number;
}

const GOALS_FILE = "goals.json";

async function loadGoals(): Promise<Goal[]> {
  return readJSON<Goal[]>(GOALS_FILE, []);
}

async function saveGoals(goals: Goal[]): Promise<void> {
  await writeJSON(GOALS_FILE, goals);
}

export async function getGoal(conversationId: string): Promise<Goal | null> {
  const goals = await loadGoals();
  // Return the most recent active goal for this conversation.
  return goals
    .filter((g) => g.conversationId === conversationId && g.status !== "completed" && g.status !== "blocked")
    .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

export function buildGoalTools(conversationId?: string) {
  return {
    create_goal: tool({
      description: `Create a persisted goal that keeps this session working across automatic continuation rounds. Use it when the direct human request is a long-running objective, even if the user did not say "goal"; not for single-turn work. The goal survives model context resets and drives automatic continuation until completed.`,
      inputSchema: z.object({
        objective: z.string().describe("The concrete completion objective inferred from the direct human request."),
        max_goal_rounds: z.number().optional().describe("Optional safe-integer limit on automatic continuation rounds."),
      }),
      execute: async ({ objective, max_goal_rounds }) => {
        if (!conversationId) {
          return { error: "Goals require a conversation context." };
        }
        const goals = await loadGoals();
        const existing = await getGoal(conversationId);
        if (existing) {
          return {
            error: `A goal is already active: "${existing.objective}". Resolve it first with update_goal (complete or blocked) before creating a new one.`,
            existing_id: existing.id,
          };
        }
        const goal: Goal = {
          id: nanoid(10),
          conversationId,
          objective,
          status: "active",
          round: 0,
          maxGoalRounds: max_goal_rounds,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        goals.push(goal);
        await saveGoals(goals);
        return { id: goal.id, objective: goal.objective, status: goal.status, round: 0 };
      },
    }),

    get_goal: tool({
      description: `Read the current session goal, including the id and revision that update_goal requires. Returns the active goal or null if none is set.`,
      inputSchema: z.object({}),
      execute: async () => {
        if (!conversationId) return { error: "Goals require a conversation context." };
        const goal = await getGoal(conversationId);
        if (!goal) return { goal: null };
        return {
          goal: {
            id: goal.id,
            objective: goal.objective,
            status: goal.status,
            round: goal.round,
            max_goal_rounds: goal.maxGoalRounds,
            blocked_reason: goal.blockedReason,
          },
        };
      },
    }),

    update_goal: tool({
      description: `Update the current goal. edit replaces the objective/max rounds; pause/resume suspend and wake the goal; complete and blocked close it out (blocked requires a reason).`,
      inputSchema: z.object({
        goal_id: z.string().describe("Exact id returned by get_goal."),
        action: z.enum(["edit", "pause", "resume", "complete", "blocked"]).describe("edit | pause | resume | complete | blocked"),
        objective: z.string().optional().describe("Replacement objective (edit only)."),
        max_goal_rounds: z.number().optional().describe("Replacement round cap (edit only)."),
        blocked_reason: z.string().optional().describe("Why progress is blocked (blocked only)."),
      }),
      execute: async ({ goal_id, action, objective, max_goal_rounds, blocked_reason }) => {
        if (!conversationId) return { error: "Goals require a conversation context." };
        const goals = await loadGoals();
        const idx = goals.findIndex((g) => g.id === goal_id && g.conversationId === conversationId);
        if (idx === -1) return { error: `No active goal with id ${goal_id} for this session.` };
        const goal = goals[idx];

        const isDirectHumanAction = ["edit", "pause", "resume"].includes(action);

        switch (action) {
          case "edit":
            if (objective) goal.objective = objective;
            if (max_goal_rounds !== undefined) goal.maxGoalRounds = max_goal_rounds;
            goal.updatedAt = Date.now();
            break;
          case "pause":
            goal.status = "paused";
            goal.updatedAt = Date.now();
            break;
          case "resume":
            goal.status = "active";
            goal.updatedAt = Date.now();
            break;
          case "complete":
            goal.status = "completed";
            goal.updatedAt = Date.now();
            break;
          case "blocked":
            if (!blocked_reason) return { error: "blocked_reason is required for the blocked action." };
            goal.status = "blocked";
            goal.blockedReason = blocked_reason;
            goal.updatedAt = Date.now();
            break;
        }

        await saveGoals(goals);
        return {
          goal: {
            id: goal.id,
            objective: goal.objective,
            status: goal.status,
            round: goal.round,
            max_goal_rounds: goal.maxGoalRounds,
            blocked_reason: goal.blockedReason,
          },
        };
      },
    }),
  };
}
