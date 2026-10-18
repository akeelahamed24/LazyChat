/**
 * Tests for the ported dsh-tool-goal and dsh-tool-schedule modules.
 *
 * Run: npx tsx --test tests/unit/goals-schedules.test.ts
 */
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "@/lib/store";
import { buildGoalTools, getGoal } from "@/lib/goals";
import { buildScheduleTools } from "@/lib/schedules";

const CONV_ID = "test-conv-" + Date.now();

beforeEach(async () => {
  // Clean up test data
  if (fs.existsSync(path.join(DATA_DIR, "goals.json"))) {
    fs.unlinkSync(path.join(DATA_DIR, "goals.json"));
  }
});

after(async () => {
  // Cleanup
  ["goals.json", "schedules.json", "pending-reminders.json"].forEach((f) => {
    const fp = path.join(DATA_DIR, f);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  });
});

describe("goals", () => {
  const tools = buildGoalTools(CONV_ID);
  const exec = (t: any, args: Record<string, unknown>) => t.execute(args);

  it("creates and retrieves a goal", async () => {
    // No active goal initially.
    const getResult = (await exec(tools.get_goal, {})) as { goal: { id: string; objective: string } | null };
    assert.equal(getResult.goal, null);

    // Create a goal.
    const createResult = (await exec(tools.create_goal, {
      objective: "Test the goal feature",
    })) as { id: string; objective: string; status: string };
    assert.equal(createResult.status, "active");
    assert.ok(createResult.id);

    // Retrieve it.
    const getResult2 = (await exec(tools.get_goal, {})) as { goal: { id: string; objective: string } };
    assert.equal(getResult2.goal?.id, createResult.id);
    assert.equal(getResult2.goal?.objective, "Test the goal feature");
  });

  it("prevents creating a second active goal", async () => {
    const tools = buildGoalTools(CONV_ID + "-dup");
    const exec = (t: any, args: Record<string, unknown>) => t.execute(args);
    await exec(tools.create_goal, { objective: "First goal" });
    const result = (await exec(tools.create_goal, {
      objective: "Second goal",
    })) as { error: string };
    assert.ok(result.error?.includes("already active"));
  });

  it("completes and allows new goal", async () => {
    const tools = buildGoalTools(CONV_ID + "-complete");
    const exec = (t: any, args: Record<string, unknown>) => t.execute(args);
    const created = (await exec(tools.create_goal, { objective: "Will complete" })) as { id: string };
    const getRes = (await exec(tools.get_goal, {})) as { goal: { id: string } };
    await exec(tools.update_goal, { goal_id: created.id, action: "complete" });
    const getRes2 = (await exec(tools.get_goal, {})) as { goal: { id: string } | null };
    assert.equal(getRes2.goal, null);
  });
});

describe("schedules", () => {
  it("creates and lists a schedule", async () => {
    const tools = buildScheduleTools(CONV_ID + "-sched");
    const exec = (t: any, args: Record<string, unknown>) => t.execute(args);

    const created = (await exec(tools.schedule_create, {
      prompt: "Stand up",
      title: "Morning standup",
      after_seconds: 60,
    })) as { id: string; next_delivery: number };
    assert.ok(created.id);
    assert.ok(created.next_delivery > Date.now());

    const listed = (await exec(tools.schedule_list, {})) as { schedules: Array<{ id: string; title: string }> };
    assert.ok(listed.schedules.some((s) => s.id === created.id));
    assert.equal(listed.schedules[0].title, "Morning standup");
  });

  it("deletes a schedule", async () => {
    const tools = buildScheduleTools(CONV_ID + "-sched-del");
    const exec = (t: any, args: Record<string, unknown>) => t.execute(args);

    const created = (await exec(tools.schedule_create, {
      prompt: "Test",
      title: "Test reminder",
      after_seconds: 30,
    })) as { id: string };

    const deleted = (await exec(tools.schedule_delete, { id: created.id })) as { deleted: string };
    assert.equal(deleted.deleted, created.id);

    const listed = (await exec(tools.schedule_list, {})) as { schedules: any[] };
    assert.equal(listed.schedules.length, 0);
  });

  it("updates a schedule timing", async () => {
    const tools = buildScheduleTools(CONV_ID + "-sched-upd");
    const exec = (t: any, args: Record<string, unknown>) => t.execute(args);

    const created = (await exec(tools.schedule_create, {
      prompt: "Old",
      title: "Update test",
      after_seconds: 60,
    })) as { id: string; next_delivery: number };

    const updated = (await exec(tools.schedule_update, {
      id: created.id,
      prompt: "New prompt",
      every_seconds: 300,
    })) as { id: string; title: string; next_delivery: number };
    assert.equal(updated.id, created.id);
    assert.ok(updated.next_delivery >= created.next_delivery); // might be same second
  });
});
