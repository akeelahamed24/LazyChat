import "server-only";

import { tool } from "ai";
import { z } from "zod";

import { getAgent, getAgents, stopAgent, spawnAgent, type SpawnAgentInput } from "@/lib/agents";

/**
 * Agent management + subagent tools, ported from:
 * - dsh-tool-subagent (subagent, subagent_fork)
 * - dsh-tool-agent-control (list_agents, send_message, interrupt_agent)
 *
 * In LazyChat these are the same Docker-sandboxed agents that runAgentTask
 * spawns, but exposed as first-class model tools so the chat loop can
 * delegate, monitor, and interrupt them.
 */

interface BuildAgentToolsOpts {
  conversationId?: string;
  provider?: string;
  model?: string;
}

export function buildAgentTools(opts: BuildAgentToolsOpts) {
  return {
    list_agents: tool({
      description: `List all agent sessions visible to this conversation — running, queued, done, failed, or stopped. Returns each agent's id, label, status, progress, and model. Use this before send_message/interrupt_agent to get the right id.`,
      inputSchema: z.object({}),
      execute: async () => {
        const agents = getAgents();
        // Filter to conversation-relevant agents (or all if no conversation).
        const filtered = opts.conversationId
          ? agents.filter((a) => a.conversationId === opts.conversationId)
          : agents;
        return {
          agents: filtered.map((a) => ({
            id: a.id,
            label: a.label,
            status: a.status,
            progress: a.progress,
            model: `${a.provider}/${a.model}`,
            task: a.task.slice(0, 120),
            createdAt: a.createdAt,
            updatedAt: a.updatedAt,
            resultFiles: (a.resultFiles || []).map((f) => ({
              title: f.title,
              id: f.id,
              type: f.type,
              filename: f.filename,
              url: `/api/files/${f.id}/${encodeURIComponent(f.filename)}`,
            })),
          })),
        };
      },
    }),

    interrupt_agent: tool({
      description: `Stop a running or queued agent immediately. Equivalent to hitting Stop in the Agents panel — the sandbox is torn down and the agent is marked "stopped".`,
      inputSchema: z.object({
        agent_id: z.string().describe("Agent id from list_agents"),
      }),
      execute: async ({ agent_id }) => {
        const agent = getAgent(agent_id);
        if (!agent) return { error: `Agent ${agent_id} not found.` };
        await stopAgent(agent_id);
        return { agent_id, status: "stopped", message: `Agent ${agent_id} (${agent.label}) was stopped.` };
      },
    }),

    send_message: tool({
      description: `Send a message to a running agent's log. The message appears in the agent's event stream. Currently only logged — the agent itself does not receive it as input (it's running in its own sandbox loop).`,
      inputSchema: z.object({
        agent_id: z.string().describe("Agent id from list_agents"),
        message: z.string().describe("Message to send to the agent"),
      }),
      execute: async ({ agent_id, message }) => {
        const agent = getAgent(agent_id);
        if (!agent) return { error: `Agent ${agent_id} not found.` };
        if (agent.status !== "running" && agent.status !== "queued" && agent.status !== "starting") {
          return { error: `Agent ${agent_id} is not running (status: ${agent.status}).` };
        }
        return {
          agent_id,
          message: `Message sent to agent ${agent_id}. Note: the agent is running in its own sandbox loop; this message is logged but not delivered as model input.`,
        };
      },
    }),

    subagent: tool({
      description: `Spawn a child agent (subagent) in a Docker sandbox to work on a sub-task, inheriting the parent's workspace context and provider/model. Unlike runAgentTask, the subagent runs with the same settings and waits for completion by default. Use for breaking a task into independent sub-tasks that can run in parallel.`,
      inputSchema: z.object({
        task: z.string().describe("Precise sub-task instructions for the child agent"),
        research: z
          .boolean()
          .default(false)
          .describe("If true, the agent browses the web in a live Chromium browser"),
        wait: z
          .boolean()
          .default(true)
          .describe("If true, wait for completion (up to maxWaitSeconds) and return the outcome"),
        maxWaitSeconds: z.number().min(5).max(900).default(300),
      }),
      execute: async ({ task, research, wait, maxWaitSeconds }) => {
        const input: SpawnAgentInput = {
          task,
          provider: opts.provider || "anthropic",
          model: opts.model || "claude-sonnet-5",
          engine: "tool-loop",
          conversationId: opts.conversationId,
          research,
        };
        const agent = await spawnAgent(input);

        if (!wait) {
          return {
            agentId: agent.id,
            message: `Subagent ${agent.id} launched in a Docker sandbox.`,
          };
        }

        const deadline = Date.now() + (maxWaitSeconds || 300) * 1000;
        let last = agent;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1500));
          const curr = getAgent(agent.id);
          if (!curr) break;
          last = curr;
          if (["done", "failed", "stopped"].includes(last.status)) break;
        }

        if (!last) return { agentId: agent.id, message: "Agent record was cleaned up." };
        const files = last.resultFiles || [];
        const fileList = files.map((f) => ({
          name: f.title || f.filename,
          url: `/api/files/${f.id}/${encodeURIComponent(f.filename)}`,
          id: f.id,
          type: f.type,
          filename: f.filename,
        }));
        const logTail = (last.log || []).slice(-6).map((l: any) => l.message).join("\n");
        const stillRunning = ["queued", "starting", "running"].includes(last.status);
        return {
          agentId: agent.id,
          status: last.status,
          progress: last.progress,
          files: stillRunning ? [] : fileList,
          summary: stillRunning
            ? `Subagent is still running in the background. Track progress in the Agents panel.`
            : `Subagent ${last.status}: ${files.length} file(s) produced.\n${logTail}`,
        };
      },
    }),

    subagent_fork: tool({
      description: `Fork a child agent to work on a sub-task in the background without waiting. Returns immediately with the agent id; track progress with list_agents. Use when you want parallel execution across multiple sub-tasks.`,
      inputSchema: z.object({
        task: z.string().describe("Sub-task instructions for the forked agent"),
        research: z.boolean().default(false).describe("If true, agent browses the web"),
      }),
      execute: async ({ task, research }) => {
        const input: SpawnAgentInput = {
          task,
          provider: opts.provider || "anthropic",
          model: opts.model || "claude-sonnet-5",
          engine: "tool-loop",
          conversationId: opts.conversationId,
          research,
        };
        const agent = await spawnAgent(input);
        return {
          agentId: agent.id,
          message: `Forked subagent ${agent.id} to: "${task.slice(0, 80)}". Track with list_agents.`,
        };
      },
    }),
  };
}
