// Hook tasks: the tasks a generation hook asks for, and what such a task completes with.

import { type HookTask, hookTask } from "@earendil-works/pi-durable";
import type { SchemaDecodeError } from "@effectified/pi-schema";
import { Effect, Schema } from "effect";
import type * as Task from "./task.ts";

/** A task a hook asks for: Pi's `HookTask`, made by `task`. */
export interface TaskRequest extends HookTask {}

/**
 * A task of `kind` with `input`, encoded, for an `onYield`, `afterTools` or `afterRun` handler to ask for (Pi's
 * `hookTask`): `{ kind: "tasks", tasks }` from `onYield`, `{ tasks }` from the others. The generation creates the
 * tasks as its children, in one commit, and waits for them, so a stop aborts them and a crash resumes them; once they
 * exist, the hook is not asked again. The task runs under the definition the registry holds for its name: a request
 * for one that is not installed is reported (`extension_error`) and skipped.
 */
export function task<I, A>(kind: Task.Kind<I, A>, input: NoInfer<I>): Effect.Effect<TaskRequest, SchemaDecodeError> {
	return Effect.map(kind.encodeInput(input), (json) => hookTask(kind.token, json));
}

/**
 * What a hook task may send a run back to work with: text, or text and images. The JSON of Pi's `UserInput`, with one
 * narrowing: a list of items is never empty, because Pi ignores an empty continuation and the answer would stand
 * without a word. A result that holds one anyway fails to encode, which ends its task `faulted`.
 */
export const UserInput = Schema.Union([
	Schema.String,
	// Mutable, as Pi types a message's content: a decision made here is one Pi's own types take.
	Schema.mutable(
		Schema.NonEmptyArray(
			Schema.Union([
				Schema.Struct({
					type: Schema.Literal("text"),
					text: Schema.String,
					textSignature: Schema.optionalKey(Schema.String),
				}),
				Schema.Struct({ type: Schema.Literal("image"), data: Schema.String, mimeType: Schema.String }),
			]),
		),
	),
]);

/** A user message's content: Pi's `UserInput`. */
export type UserInput = typeof UserInput.Type;

/**
 * The result schema of a task asked for from `onYield`: Pi's `YieldDecision`. The first task, in the order they were
 * asked for, that completes with a `continue` sends the agent back to work in the same run, unless a user message or
 * a reset was queued meanwhile; without one the answer stands.
 */
export const YieldDecision = Schema.Struct({ continue: Schema.optionalKey(UserInput) });

/** What an `onYield` task completes with. */
export type YieldDecision = typeof YieldDecision.Type;

/** The answer stands. */
export const stand: YieldDecision = {};

/** The run continues with `input` as a user message. */
export function continueWith(input: UserInput): YieldDecision {
	return { continue: input };
}

/**
 * The result schema of a task asked for from `afterTools`: Pi's `AfterToolsDecision`. One task that completes with
 * `terminate` ends the run after this round, as a round whose calls all asked to terminate.
 */
export const AfterToolsDecision = Schema.Struct({ terminate: Schema.optionalKey(Schema.Literal(true)) });

/** What an `afterTools` task completes with. */
export type AfterToolsDecision = typeof AfterToolsDecision.Type;

/** The run goes on after this round. */
export const proceed: AfterToolsDecision = {};

/** The run ends after this round. */
export const terminate: AfterToolsDecision = { terminate: true };
