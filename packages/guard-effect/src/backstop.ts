// The backstop: a tool that refuses to run in a conversation that does not ask the guard's extension first.

import {
	type Tool,
	ToolCallId,
	type ToolExecutionResult,
	ToolName,
	type ToolRegistration,
} from "@effectified/pi-durable";
import { Array as Arr, Effect, PubSub, Record, Struct } from "effect";
import * as Enforced from "./enforced.ts";
import type { Service } from "./guard.ts";
import { Refusal, unavailable } from "./refusal.ts";
import * as Refused from "./refused.ts";

/** A member of an extension (a tool, a hook, ...) of the shape `A`, whose registration needs `R`. */
export type Needing<A extends { readonly registration: Effect.Effect<unknown, unknown, unknown> }, R> = Omit<
	A,
	"registration"
> & {
	readonly registration: Effect.Effect<Effect.Success<A["registration"]>, Effect.Error<A["registration"]>, R>;
};

/**
 * `tool` with the backstop of `guard`. Pi asks only the hooks of the extensions a conversation selects, in the order
 * it selects them, so a selection without the guard's extension, or with another one before it, would run the tool
 * unguarded or ask approvals and budgets first. The tool then refuses instead, with the result of a blocked call and
 * the record of the refusal in its details, and publishes a `guard-not-first` refusal. The first extension must be
 * the guard's own object, not only its name: one installed later under that name refuses every tool too. The
 * selection is the one Pi resolved for the call, which costs no further read.
 *
 * The backstopped tool has exactly the members `MEMBERS` passes, and `execute` guarded: a member Pi does not declare
 * yet, set on a registration anyway, is left out, so it never runs unguarded.
 */
export function backstopped<R>(tool: Needing<Tool.Any, R>, guard: Service): Needing<Tool.Any, R> {
	return {
		name: tool.name,
		registration: Effect.map(tool.registration, (registration) => guarded(registration, guard)),
	};
}

/**
 * What the backstop does with each member of Pi's tool registration: `execute` runs only behind the check, a `passed`
 * member is kept as it is, a `dropped` one is left out. Typed by Pi's `ToolRegistration`, so a member Pi adds fails to
 * compile here until it is decided. One that runs tool code is dropped, or guarded by code written for it in
 * `guarded` and a disposition of its own here; it is never passed by default.
 */
const MEMBERS = {
	// What Pi reads to offer, validate and schedule the tool: data, no code of the tool runs.
	name: "passed",
	description: "passed",
	parameters: "passed",
	constrainedSampling: "passed",
	replay: "passed",
	executionMode: "passed",
	structuredOutputSchema: "passed",
	callers: "passed",
	deferred: "passed",
	outputLimits: "passed",
	// Pi requires it pure: it repairs the arguments it is given and reaches nothing outside.
	prepareArguments: "passed",
	// Pi calls it only for a call that parked, and only a guarded `execute` parks: it cleans up work the guard let start.
	cancel: "passed",
	execute: "guarded",
} as const satisfies { readonly execute: "guarded" } & Record<
	Exclude<keyof ToolRegistration, "execute">,
	"passed" | "dropped"
>;

/** The members `MEMBERS` passes as they are. */
type Passed = {
	readonly [K in keyof typeof MEMBERS]: (typeof MEMBERS)[K] extends "passed" ? K : never;
}[keyof typeof MEMBERS];

const PASSED = Arr.filter(Record.keys(MEMBERS), (key): key is Passed => MEMBERS[key] === "passed");

function guarded(registration: ToolRegistration, guard: Service): ToolRegistration {
	return {
		// The registration's own members of the passed keys, as its spread would copy them.
		...Struct.pick(registration, PASSED),
		// Pi's own promise interface: a tool's `execute` is what Pi awaits.
		execute: (args, api, context) =>
			api.agent(context).then((agent) => {
				if (Enforced.owns(guard, agent.extensions[0])) return registration.execute(args, api, context);
				const tool = ToolName.make(registration.name);
				PubSub.publishUnsafe(
					guard.refusals,
					Refusal.make({
						conversationId: api.conversationId,
						taskId: api.taskId,
						callId: ToolCallId.make(api.callId),
						tool,
						rule: "guard-not-first",
					}),
				);
				return blocked(tool);
			}),
	};
}

/**
 * The error result Pi writes for a call a `beforeTool` hook blocked (spec 7.3), with the guard's one sentence. The
 * record is written here: where the guard's extension is not selected, its `afterTool` hook is not asked.
 */
function blocked(tool: ToolName): ToolExecutionResult {
	const refused: Refused.Refused = { rule: "guard-not-first" };
	return {
		output: [],
		isError: true,
		details: { [Refused.KEY]: { ...refused } },
		diagnostics: [{ severity: "error", code: "blocked", message: `Tool call blocked: ${unavailable(tool)}` }],
	};
}
