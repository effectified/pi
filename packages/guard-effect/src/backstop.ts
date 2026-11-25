// The backstop: a tool that refuses to run in a conversation that does not ask the guard's extension first.

import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import type { Tool } from "@gunta/pi-durable-effect";
import { Effect, PubSub } from "effect";
import * as Enforced from "./enforced.ts";
import type { Service } from "./guard.ts";
import { unavailable } from "./refusal.ts";
import * as Refused from "./refused.ts";

/**
 * `tool` with the backstop of `guard`. Pi asks only the hooks of the extensions a conversation selects, in the order
 * it selects them, so a selection without the guard's extension, or with another one before it, would run the tool
 * unguarded or ask approvals and budgets first. The tool then refuses instead, with the result of a blocked call and
 * the record of the refusal in its details, and publishes a `guard-not-first` refusal. The first extension must be
 * the guard's own object, not only its name: one installed later under that name refuses every tool too. The
 * selection is the one Pi resolved for the call, which costs no further read.
 */
export function backstopped(tool: Tool.Any, guard: Service): Tool.Any {
	return {
		name: tool.name,
		registration: Effect.map(tool.registration, (registration) => guarded(registration, guard)),
	};
}

function guarded(registration: ToolRegistration, guard: Service): ToolRegistration {
	return {
		...registration,
		// Pi's own promise interface: a tool's `execute` is what Pi awaits.
		execute: (args, api, context) =>
			api.agent(context).then((agent) => {
				if (Enforced.owns(guard, agent.extensions[0])) return registration.execute(args, api, context);
				PubSub.publishUnsafe(guard.refusals, {
					conversationId: api.conversationId,
					taskId: api.taskId,
					callId: api.callId,
					tool: registration.name,
					rule: "guard-not-first",
				});
				return blocked(registration.name);
			}),
	};
}

/**
 * The error result Pi writes for a call a `beforeTool` hook blocked (spec 7.3), with the guard's one sentence. The
 * record is written here: where the guard's extension is not selected, its `afterTool` hook is not asked.
 */
function blocked(tool: string): ToolExecutionResult {
	const refused: Refused.Refused = { rule: "guard-not-first" };
	return {
		output: [],
		isError: true,
		details: { [Refused.KEY]: { ...refused } },
		diagnostics: [{ severity: "error", code: "blocked", message: `Tool call blocked: ${unavailable(tool)}` }],
	};
}
