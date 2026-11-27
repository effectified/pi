// A value kept in a memo of the review task: made once, and read back when Pi runs the phase again.

import type { DurableError, JsonObject, Task } from "@effectified/pi-durable";
import { Effect, Option, type Schema } from "effect";

/** The memos of the review task: Pi keeps them while the task can run, and the first writer of a name wins. */
export type Memos = Task.Api<unknown, unknown, unknown>["memo"];

/** How a kept value is read back: the decoder of a schema of plain JSON, whose type is its stored form. */
export type Decode<A> = (stored: unknown) => Effect.Effect<A, Schema.SchemaError>;

/** The value the memo `name` holds, decoded: none while nothing was kept, and for a memo of another shape. */
export const read: <A extends object>(
	memos: Memos,
	name: string,
	decode: Decode<A>,
) => Effect.Effect<Option.Option<A>, DurableError> = Effect.fn("Kept.read")(function* <A extends object>(
	memos: Memos,
	name: string,
	decode: Decode<A>,
) {
	const kept = yield* memos<JsonObject>(name);
	if (Option.isNone(kept)) return Option.none<A>();
	// Stored data is a trust boundary: a memo another version wrote in another shape counts as none.
	return yield* Effect.option(decode(kept.value));
});

/**
 * The value of `make`, made once per memo: a value the memo `name` holds is returned as it is, so a phase that runs
 * again after a close or a crash does not do the work twice. Work a close interrupted left no memo, and runs again.
 */
export const once: <A extends object, R>(
	memos: Memos,
	name: string,
	decode: Decode<A>,
	make: Effect.Effect<A, never, R>,
) => Effect.Effect<A, DurableError, R> = Effect.fn("Kept.once")(function* <A extends object, R>(
	memos: Memos,
	name: string,
	decode: Decode<A>,
	make: Effect.Effect<A, never, R>,
) {
	const kept = yield* read(memos, name, decode);
	if (Option.isSome(kept)) return kept.value;
	const made = yield* make;
	// A decode boundary: Effect types the JSON it encodes to read-only, Pi types the same values mutable.
	yield* memos(name, made as JsonObject);
	return made;
});
