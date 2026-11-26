// The backstop: a tool that refuses to run in a conversation that does not ask the guard's extension first.

import type { Tool, ToolExecutionResult, ToolRegistration } from "@effectified/pi-durable";
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
 *
 * The backstopped tool has exactly the members `MEMBERS` passes, and `execute` guarded: a member Pi does not declare
 * yet, set on a registration anyway, is left out, so it never runs unguarded.
 */
export function backstopped(tool: Tool.Any, guard: Service): Tool.Any {
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

const PASSED: ReadonlySet<string> = new Set(
	Object.entries(MEMBERS).flatMap(([key, disposition]) => (disposition === "passed" ? [key] : [])),
);

function guarded(registration: ToolRegistration, guard: Service): ToolRegistration {
	// The registration's own members of the passed keys, as its spread would copy them: `Object.entries` loses their
	// types, which are those of `ToolRegistration`'s passed members.
	const kept = Object.fromEntries(Object.entries(registration).filter(([key]) => PASSED.has(key))) as Pick<
		ToolRegistration,
		Passed
	>;
	return {
		...kept,
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
