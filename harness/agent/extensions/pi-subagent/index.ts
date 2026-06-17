/**
 * OMP Subagent Extension (adapted from pi-subagent)
 *
 * Delegates tasks to sub-agents running in isolated `omp` processes.
 * Sub-agents inherit the exact same system prompt and session context as the
 * main agent. KV cache stable — system prompt never modified at runtime.
 *
 * Adapted for omp v16: pi.zod is the raw Zod module (no .z wrapper).
 * TUI render functions removed to avoid @oh-my-pi/pi-tui import chain.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getFinalAssistantText, getResultSummaryText } from "./runner-events.js";
import { runAgent } from "./runner.js";
import {
	type SingleResult,
	isResultError,
} from "./types.js";

const SUBAGENT_INSTRUCTIONS = `
## Sub-Agent Tools/Extension

Since we are running all our LLMs locally, we have to use a modified version of sub-agents. This means that you may switch between main agent and sub agent mode at any point during the session.

You will know sub-agent mode is active when you see a user message that follows this format:

\`\`\`
**[BEGIN SUB AGENT MODE]**: <prompt and task will go here>
\`\`\`

Once you see that then you will be operating in sub-agent mode, where you have an assigned task and should work to complete it. You will not be able to spawn any sub agents while operating in sub agent mode.
Your primary goal is to accomplish the task and report back to the main agent.

Another way to tell if you are in sub-agent mode is to look at the most recent tool call. You will see the sub-agent tool call followed by an empty tool result "No result provided". You ARE the tool result actively running in sub-agent mode.
This means your final response will be the tool_result.

### When to Use a Sub-Agent

Use sub-agents when you need to:
- Do heavy research across many files without polluting your context
- Run long-running tasks that would consume your context window
- Offload specialized work while you continue other tasks
- Preserve context efficiency by keeping only summaries in your context

A sub-agent will have FULL context for all tool calls/results and message history up until the point you spawn it, meaning it will know exactly what you know. Keep this in mind while defining a full task statement.

### Calling the Subagent Tool

\`\`\`
subagent({
  name: "researcher",     // Freeform name
  task: "Research the latest about quantum computing",
  timeout: 180,           // Optional: max seconds (default: 600)
  maxTurns: 80,           // Optional: max LLM turns (default: 50)
  cwd: "/path/to/dir"     // Optional: working directory
})
\`\`\`

### Best Practices

1. Give sub-agents clear, specific task descriptions
2. Set appropriate timeouts for long-running tasks
3. Let sub-agents write results to files — you can read them back
4. Use sub-agents to consolidate knowledge into summaries before bringing it back into your context
`;

interface SessionSnapshotSource {
	getHeader: () => unknown;
	getBranch: () => unknown[];
}

function buildForkSessionSnapshotJsonl(
	sessionManager: SessionSnapshotSource,
): string | null {
	const header = sessionManager.getHeader();
	if (!header || typeof header !== "object") return null;
	const branchEntries = sessionManager.getBranch();
	const lines = [JSON.stringify(header)];
	for (const entry of branchEntries) lines.push(JSON.stringify(entry));
	return `${lines.join("\n")}\n`;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: event.systemPrompt + SUBAGENT_INSTRUCTIONS,
		};
	});

	// pi.zod IS the raw Zod module — use pi.zod.object(), NOT pi.zod.z.object()
	const SubagentParams = pi.zod.object({
		name: pi.zod.string().describe(
			"A human-like name for the sub-agent. Freeform, no config lookup.",
		),
		task: pi.zod.string().describe(
			"Task description. The sub-agent receives the full session context.",
		),
		timeout: pi.zod.number().optional().default(600).describe(
			"Maximum execution time in seconds. Default: 600.",
		),
		maxTurns: pi.zod.number().optional().default(50).describe(
			"Maximum number of assistant turns (LLM calls). Default: 50.",
		),
		cwd: pi.zod.string().optional().describe(
			"Working directory for the sub-agent. Defaults to your CWD.",
		),
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate work to a sub-agent running in an isolated omp process.",
			"",
			"The sub-agent inherits your full session context.",
			"",
			"Parameters: name, task, timeout (default 600s), maxTurns (default 50), cwd (optional)",
		].join("\n"),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			let forkSessionSnapshotJsonl: string | undefined;
			forkSessionSnapshotJsonl = buildForkSessionSnapshotJsonl(
				ctx.sessionManager,
			);
			if (!forkSessionSnapshotJsonl) {
				return {
					content: [{
						type: "text",
						text: "Cannot spawn sub-agent: failed to snapshot session context.",
					}],
					details: { results: [] },
					isError: true,
				};
			}

			const timeoutMs = (params.timeout ?? 600) * 1000;
			const maxTurns = params.maxTurns ?? 50;

			const result = await runAgent({
				cwd: ctx.cwd,
				agentName: params.name,
				task: params.task,
				taskCwd: params.cwd,
				forkSessionSnapshotJsonl,
				signal,
				onUpdate,
				makeDetails: (results) => ({ results }),
				timeout: timeoutMs,
				maxTurns,
			});

			if (isResultError(result)) {
				return {
					content: [{
						type: "text",
						text: `Sub-agent failed: ${getResultSummaryText(result)}`,
					}],
					details: { results: [result] },
					isError: true,
				};
			}
			return {
				content: [{
					type: "text",
					text: getResultSummaryText(result),
				}],
				details: { results: [result] },
			};
		},
	});
}
