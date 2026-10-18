/**
 * Tests for ported dsh-plan-mode.
 *
 * Run: npx tsx --test tests/unit/plan-mode.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { isPlanMode, enterPlanMode, exitPlanMode, getPlan, buildPlanModeTool } from "@/lib/plan-mode";

const CONV_ID = "test-plan-" + Date.now();

afterEach(() => {
  exitPlanMode(CONV_ID);
});

describe("plan mode", () => {
  it("enters and exits plan mode", () => {
    assert.equal(isPlanMode(CONV_ID), false);
    enterPlanMode(CONV_ID);
    assert.equal(isPlanMode(CONV_ID), true);
    exitPlanMode(CONV_ID);
    assert.equal(isPlanMode(CONV_ID), false);
  });

  it("stores and retrieves the plan", async () => {
    enterPlanMode(CONV_ID);
    assert.equal(getPlan(CONV_ID), "");

    // Simulate the model calling exit_plan_mode.
    const tools = buildPlanModeTool({ conversationId: CONV_ID });
    const exec = (t: any, args: Record<string, unknown>) => t.execute(args);

    // In plan mode, exit should work.
    const result = await exec(tools.exit_plan_mode, { plan: "1. Do A\n2. Do B\n3. Done" });
    assert.equal(result.plan, "1. Do A\n2. Do B\n3. Done");

    // After exit, plan mode is off but the plan is still retrievable.
    assert.equal(isPlanMode(CONV_ID), false);
    assert.ok(getPlan(CONV_ID) === "1. Do A\n2. Do B\n3. Done");
    // exitPlanMode fully clears it.
    const cleared = exitPlanMode(CONV_ID);
    assert.equal(cleared, "1. Do A\n2. Do B\n3. Done");
    assert.equal(getPlan(CONV_ID), null);
  });

  it("exit_plan_mode errors when not in plan mode", async () => {
    const tools = buildPlanModeTool({ conversationId: CONV_ID });
    const exec = (t: any, args: Record<string, unknown>) => t.execute(args);
    const result = await exec(tools.exit_plan_mode, { plan: "test" });
    assert.ok(result.error?.includes("Not in plan mode"));
  });

  it("exit_plan_mode errors without conversation context", async () => {
    const tools = buildPlanModeTool({});
    const exec = (t: any, args: Record<string, unknown>) => t.execute(args);
    const result = await exec(tools.exit_plan_mode, { plan: "test" });
    assert.ok(result.error);
  });
});
