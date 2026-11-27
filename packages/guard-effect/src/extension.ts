// The guard's own extension: the hook that decides every tool call before it runs, and the one that records what was
// refused in the call's result.

import type { JsonObject, ToolExecutionResult } from "@effectified/pi-durable";
import { Extension, Gate, Hook, ToolCallId, ToolName } from "@effectified/pi-durable";
import { Array as Arr, Cause, Effect, Match, Option, Predicate, PubSub } from "effect";
import * as Check from "./check.ts";
import * as Grant from "./grant.ts";
import type { Policy } from "./policy.ts";
import { Refusal, unavailable } from "./refusal.ts";
import * as Refused from "./refused.ts";
import type * as Rule from "./rule.ts";

/** The name of the guard's extension. A conversation that selects extensions itself lists it first. */
export const NAME = "guard";

/**
 * The extension a guard installs before every other.
 *
 * - Its `beforeTool` hook decides each call, the model's and a nested one, against `policy`, the conversation's grant
 *   and `rules`, and publishes every refusal to `refusals` before it blocks.
 * - Its `afterTool` hook writes what was refused into the result's details (see `Refused`): the decision of the first
 *   hook for a call it blocked, and `unavailable` for a call Pi refused itself, which it also publishes. It changes
 *   nothing else of a result, and no other result.
 *
 * The hooks need what the rules need.
 */
export function make<R, E>(
	policy: Policy,
	rules: ReadonlyArray<Rule.Rule<R, E>>,
	refusals: PubSub.PubSub<Refusal>,
): Extension.Extension<readonly [], readonly [Hook.Hook<R>, Hook.Hook<never>], readonly [], readonly [], readonly []> {
	// What the first hook refused, for the second to record. Pi blocks, asks `afterTool` and stores the result in one
	// run of the call, and gives both hooks that run's api object: after a crash it asks the first hook again, so
	// the record is always of the decision that blocked. Held weakly, so a run that ends otherwise leaves nothing.
	const refusedBy = new WeakMap<object, Refused.Refused>();
	const decided = Hook.beforeTool(
		// Untraced: `Hook.beforeTool` runs it in a span of its own that names the hook, the call and its task.
		Effect.fnUntraced(function* (call, api) {
			const tool = ToolName.make(call.name);
			const callId = ToolCallId.make(call.id);
			const verdict = yield* api.snapshot(Grant.Document, api.conversationId).pipe(
				Effect.flatMap((stored) =>
					Check.decide(policy, rules, call.arguments, {
						name: tool,
						conversationId: api.conversationId,
						callId,
						nested: call.parent !== undefined,
						grant: Grant.effective(Option.getOrUndefined(stored), policy.ungranted),
					}),
				),
				// Fail closed: a grant that cannot be read, and any defect of the guard itself, refuses the call. Pi's abort
				// of the call stays an interruption.
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(Check.refuse("guard-failed")),
				),
			);
			return yield* Match.valueTags(verdict, {
				Pass: (pass) =>
					Effect.succeed(Option.match(pass.arguments, { onNone: () => Gate.allow, onSome: Gate.rewrite })),
				Refuse: ({ _tag, ...why }) => {
					refusedBy.set(api.pi, { rule: why.rule, ...(why.name === undefined ? {} : { name: why.name }) });
					const refusal = Refusal.make({
						conversationId: api.conversationId,
						taskId: api.taskId,
						callId,
						tool,
						...why,
					});
					return Effect.as(PubSub.publish(refusals, refusal), Gate.block(unavailable(tool)));
				},
			});
		}),
	);
	const recorded = Hook.afterTool(
		// Untraced: `Hook.afterTool` runs it in a span of its own that names the hook, the call and its task.
		Effect.fnUntraced(function* (call, result, api) {
			if (has(result, "tool_unavailable")) {
				const refusal = Refusal.make({
					conversationId: api.conversationId,
					taskId: api.taskId,
					callId: ToolCallId.make(call.id),
					tool: ToolName.make(call.name),
					rule: "unavailable",
				});
				yield* PubSub.publish(refusals, refusal);
				return recording(result, { rule: refusal.rule });
			}
			// Another extension's block has Pi's code too: only a call this guard blocked in this run has a decision.
			const refused = has(result, "blocked") ? Option.fromUndefinedOr(refusedBy.get(api.pi)) : Option.none();
			return Option.flatMap(refused, (decision) => recording(result, decision));
		}),
	);
	return Extension.make({ name: NAME, hooks: [decided, recorded] });
}

/** Whether `result` is an error result with the diagnostic `code` (spec 7.3): one Pi wrote without running the tool. */
function has(result: ToolExecutionResult, code: string): boolean {
	return result.isError === true && Arr.some(result.diagnostics ?? [], (diagnostic) => diagnostic.code === code);
}

/**
 * `result` with the record under `Refused.KEY` in its details, which the model never reads. None, so the result stays
 * as it is, when its details are no object (a tool's own array or text): there is nowhere to add a key.
 */
function recording(result: ToolExecutionResult, refused: Refused.Refused): Option.Option<ToolExecutionResult> {
	const details = result.details;
	if (details !== undefined && !Predicate.isObject(details)) return Option.none();
	const joined: JsonObject = { ...details, [Refused.KEY]: { ...refused } };
	return Option.some({ ...result, details: joined });
}
