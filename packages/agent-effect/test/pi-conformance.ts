// What agent-effect lists of pi-agent-core by hand, checked against pi-agent-core's own types. Type-only: nothing here
// runs. A failure names what moved upstream.

import type {
	AgentLoopConfig,
	AgentOptions,
	AgentTool,
	AgentToolResult,
	Agent as PiAgent,
	RunToolCallOptions as PiRunToolCallOptions,
} from "@earendil-works/pi-agent-core";
import type { Schema } from "effect";
import type { Assert, Conform, Covers } from "../../../effect/conformance.ts";
import type { HookKey } from "../src/hooks.ts";
import type { Agent, AgentLoop, RunToolCallOptions, Tool } from "../src/index.ts";

/** The keys of `T` whose values are functions: Pi's callbacks. */
type CallbackKeys<T> = {
	[K in keyof T]-?: NonNullable<T[K]> extends (...args: never[]) => unknown ? K : never;
}[keyof T];

/**
 * Every callback of Pi's loop configuration is a hook of this package, an Effect of the loop's `Config`
 * (`getSteeringMessages`, `getFollowUpMessages`), or `fetch`, which requests through `StreamFn` leave out. A callback
 * Pi adds fails here until it has an Effect form.
 */
export type LoopCallbacksLifted = Assert<
	Conform<CallbackKeys<AgentLoopConfig>, HookKey | "getSteeringMessages" | "getFollowUpMessages" | "fetch">
>;

/** Every field of Pi's loop configuration is one of `AgentLoop.Config`, or the abort signal, which the fiber owns. */
export type LoopConfigCovered = Assert<Covers<AgentLoopConfig, AgentLoop.Config<never>, "signal" | "fetch">>;

/**
 * Every option of Pi's agent is one `Agent.make` takes, the stream function (the `StreamFn` service), or the second
 * form of `prepareNextTurn`, which `Agent.Options["prepareNextTurn"]` is: it gets the turn's context.
 */
export type AgentOptionsCovered = Assert<
	Covers<AgentOptions, Agent.Options<never>, "streamFn" | "prepareNextTurnWithContext">
>;

/**
 * Every public member of Pi's agent is lifted onto `Agent.Agent`, or named here. A member Pi adds fails until it is
 * wrapped or named.
 */
export type AgentMembersCovered = Assert<
	Covers<
		PiAgent,
		Agent.Agent,
		// Read through `state` and set with `setSteeringMode` and `setFollowUpMode`.
		| "steeringMode"
		| "followUpMode"
		// The abort signal of the run: interrupting the fiber that waits for the run aborts it.
		| "signal"
		// Settings and hooks, set once by `make`'s options.
		| "convertToLlm"
		| "transformContext"
		| "streamFunction"
		| "getApiKey"
		| "onPayload"
		| "onResponse"
		| "onProviderStreamEvent"
		| "beforeToolCall"
		| "afterToolCall"
		| "finishTurn"
		| "prepareRequest"
		| "prepareNextTurn"
		| "prepareNextTurnWithContext"
		| "sessionId"
		| "thinkingBudgets"
		| "transport"
		| "maxRetryDelayMs"
		| "toolExecution"
		| "identity"
	>
>;

/**
 * Every field of Pi's tool is set from `Tool.make`'s options: `execute` runs the handler, `outputSchema` is the JSON
 * Schema of `success` when the tool is `structured`.
 */
export type ToolCovered = Assert<
	Covers<
		AgentTool,
		Tool.Options<Schema.Constraint, Schema.Constraint, never, never> & { readonly name: string },
		"execute" | "outputSchema"
	>
>;

/**
 * Every field of Pi's tool result can come from a reply: its extras, `isError` from `Tool.error`, `structuredContent`
 * from a `structured` tool.
 */
export type ResultCovered = Assert<Covers<AgentToolResult, Tool.Extras, "isError" | "structuredContent">>;

/** Every option of Pi's `runToolCall` is one of `RunToolCallOptions`, or the abort signal, which the fiber owns. */
export type RunToolCallCovered = Assert<Covers<PiRunToolCallOptions, RunToolCallOptions<never>, "signal">>;
