// A value kept in a memo of the review task: made once, and read back when Pi runs the phase again.

import type { JsonObject } from "@earendil-works/pi-durable";
import type { DurableError, Task } from "@effectified/pi-durable";
import { Effect, Option } from "effect";

/** The memos of the review task: Pi keeps them while the task can run, and the first writer of a name wins. */
export type Memos = Task.Api<unknown, unknown, unknown>["memo"];

/** How a kept value is read back: the decoder of a schema of plain JSON, whose type is its stored form. */
export type Decode<A> = (stored: unknown) => Effect.Effect<A, unknown>;

/** The value the memo `name` holds, decoded: none while nothing was kept, and for a memo of another shape. */
export function read<A extends object>(
	memos: Memos,
	name: string,
	decode: Decode<A>,
): Effect.Effect<Option.Option<A>, DurableError> {
	return Effect.flatMap(memos<JsonObject>(name), (kept) =>
		// Stored data is a trust boundary: a memo another version wrote in another shape counts as none.
		Option.isSome(kept) ? Effect.option(decode(kept.value)) : Effect.succeedNone,
	);
}

/**
 * The value of `make`, made once per memo: a value the memo `name` holds is returned as it is, so a phase that runs
 * again after a close or a crash does not do the work twice. Work a close interrupted left no memo, and runs again.
 */
export function once<A extends object, R>(
	memos: Memos,
	name: string,
	decode: Decode<A>,
	make: Effect.Effect<A, never, R>,
): Effect.Effect<A, DurableError, R> {
	return Effect.gen(function* () {
		const kept = yield* read(memos, name, decode);
		if (Option.isSome(kept)) return kept.value;
		const made = yield* make;
		// A decode boundary: Effect types the JSON it encodes to read-only, Pi types the same values mutable.
		yield* memos(name, made as JsonObject);
		return made;
	});
}
