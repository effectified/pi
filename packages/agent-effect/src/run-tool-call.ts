// One tool call outside a turn, through the steps of a model-issued call: Pi's `runToolCall` in Effect.

import {
	type AgentToolCall,
	type AgentToolCallOutcome,
	type AgentToolResult,
	type RunToolCallOptions as PiRunToolCallOptions,
	runToolCall as piRunToolCall,
} from "@earendil-works/pi-agent-core";
import type { SchemaConversionError } from "@effectified/pi-schema";
import { Effect } from "effect";
import { type Hooks, toPi } from "./hooks.ts";
import { runner } from "./runner.ts";
import type * as Tool from "./tool.ts";

/** What `runToolCall` takes: Pi's options with tools of this package, and the hooks and progress as Effects. */
export interface RunToolCallOptions<R>
	extends Pick<PiRunToolCallOptions, "assistantMessage" | "context">,
		Pick<Hooks<R>, "beforeToolCall" | "afterToolCall"> {
	/** The tools the call resolves against. */
	readonly tools: ReadonlyArray<Tool.Any<R>>;
	/** Gets each progress report of the tool. */
	readonly onUpdate?: (partial: AgentToolResult) => Effect.Effect<void, never, R>;
}

/**
 * Runs one tool call as the loop runs a model's: argument preparation, schema validation, `beforeToolCall`,
 * execution, `afterToolCall`. Emits no events and adds no messages; tools that call other tools use it so the hooks
 * apply to those calls too. Pi never fails it for a tool's failure: an unknown tool, invalid arguments, a blocked call
 * and a failed handler are outcomes with `isError`. Interrupting it aborts the call.
 */
export function runToolCall<R>(
	toolCall: AgentToolCall,
	options: RunToolCallOptions<R>,
): Effect.Effect<AgentToolCallOutcome, SchemaConversionError, R> {
	return Effect.gen(function* () {
		const run = runner(yield* Effect.context<R>());
		const tools = yield* Effect.forEach(options.tools, (tool) => tool.agentTool);
		const { onUpdate, ...rest } = options;
		return yield* Effect.promise((signal) =>
			piRunToolCall(toolCall, {
				...toPi(rest, run, () => signal),
				tools,
				signal,
				...(onUpdate && { onUpdate: (partial: AgentToolResult) => run(onUpdate(partial), signal) }),
			}),
		);
	});
}
