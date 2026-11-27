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
import { untilSettled } from "./settled.ts";
import type * as Tool from "./tool.ts";

/** What `runToolCall` takes: Pi's options with tools of this package, and the hooks and progress as Effects. */
export interface RunToolCallOptions<R>
	extends
		Pick<PiRunToolCallOptions, "assistantMessage" | "context">,
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
 * and a failed handler are outcomes with `isError`. Interrupting it aborts the call and waits until Pi settled it. The
 * tool's and the hooks' spans are children of this call's.
 */
export const runToolCall: <R>(
	toolCall: AgentToolCall,
	options: RunToolCallOptions<R>,
) => Effect.Effect<AgentToolCallOutcome, SchemaConversionError, R> = Effect.fn("runToolCall")(function* <R>(
	toolCall: AgentToolCall,
	options: RunToolCallOptions<R>,
): Effect.fn.Return<AgentToolCallOutcome, SchemaConversionError, R> {
	const services = yield* Effect.context<R>();
	const run = runner(services);
	const tools = yield* Effect.forEach(options.tools, (tool) => tool.agentTool, { concurrency: 1 });
	const { onUpdate, ...rest } = options;
	// Pi settles every tool's failure into the outcome; a rejection is a defect of Pi or of a hook.
	return yield* untilSettled(
		(signal) =>
			piRunToolCall(toolCall, {
				...toPi(rest, run, () => signal),
				tools,
				signal,
				...(onUpdate && { onUpdate: (partial: AgentToolResult) => run(onUpdate(partial), signal) }),
			}),
		Effect.die,
	);
});
