/**
 * One palette and readable names for every graph node.
 *
 * Run: npx tsx --test tests/brain/palette.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { NODE_COLORS, displayName, groupOf, nodeColor, prettyLabel, relColor } from "@/lib/brain/palette";

describe("palette", () => {
  it("gives every node type its own colour", () => {
    const colours = Object.values(NODE_COLORS);
    assert.equal(new Set(colours).size, colours.length, "no two node types share a colour");
    assert.match(nodeColor("Service"), /^#[0-9a-f]{6}$/i);
    assert.equal(nodeColor("Unknown", "#123456"), "#123456");
    assert.match(relColor("DEPENDS_ON"), /^#/);
  });

  it("assigns every known label to a legend group and prettifies names", () => {
    for (const label of Object.keys(NODE_COLORS)) assert.ok(["Company", "Workspaces", "Memory & chats"].includes(groupOf(label)), label);
    assert.equal(prettyLabel("EpisodicMemory"), "Episodic Memory");
    assert.equal(groupOf("Todo"), "Workspaces");
    assert.equal(groupOf("Ticket"), "Company");
  });
});

describe("displayName", () => {
  it("never falls back to a raw id when there is something readable", () => {
    assert.equal(displayName("Person", { name: "Priya Raghavan" }, "person:priya"), "Priya Raghavan");
    assert.equal(displayName("Ticket", { title: "Auth v3: migrate sessions" }, "ticket:MER-1001"), "MER-1001 · Auth v3: migrate sessions");
    assert.equal(displayName("Message", { channel: "#platform", content: "Partner IdPs are the hard part." }, "m1"), "#platform: Partner IdPs are the hard part.");
    assert.equal(displayName("Turn", { role: "user", content: "Who owns auth?" }, "t1"), "user: Who owns auth?");
    assert.equal(displayName("AgentHandoff", { from_agent: "researcher", to_agent: "synthesizer" }, "h1"), "researcher → synthesizer");
    assert.equal(displayName("Todo", { text: "Write rollback plan" }, "todo:1"), "Write rollback plan");
    assert.equal(displayName("CommandRun", { command: "npm test" }, "wr:1"), "npm test");
    assert.equal(displayName("Session", { started_at: "2026-10-18T10:00:00Z" }, "s1"), "Chat 2026-10-18");
  });

  it("clips very long text and survives empty properties", () => {
    const long = displayName("EpisodicMemory", { summary: "x".repeat(200) }, "e1");
    assert.ok(long.length <= 44 && long.endsWith("…"));
    assert.equal(displayName("Service", {}, "service:auth"), "auth");
    assert.equal(displayName("Whatever", {}, "abc"), "abc");
  });
});
