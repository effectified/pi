// A signal a task holds, read from outside the task: what a host needs to tell a wait that has its answer from one
// that has not.

import type { Signal } from "@gunta/pi-durable-effect";
import { Effect, type Option, Schema } from "effect";

/** What is read of a task's record, as `Harness.getTask` gives it: its memos, which a task that ended has none of. */
export interface Memos {
	readonly memos?: Readonly<Record<string, unknown>>;
}

/**
 * The value `record`'s task holds under `key` of `signal`, decoded: none while nothing was delivered, when the key
 * expired, and once the task ended (Pi drops a task's memos with its outcome). Pi gives a task's own handlers
 * `readSignal` and a host nothing, so this reads what Pi's specification says a delivery stores: the task's memo
 * `pi.signal.<signal name>/<key>`, as `{ version, value }`.
 */
export function held<S extends Schema.Constraint>(
	record: Memos,
	signal: Signal.Signal<S>,
	key: string,
): Effect.Effect<Option.Option<S["Type"]>, never, S["DecodingServices"]> {
	const name = `pi.signal.${signal.name}/${key}`;
	const memos = record.memos;
	if (memos === undefined || !Object.hasOwn(memos, name)) return Effect.succeedNone;
	// Stored data is a trust boundary: a memo of another shape, or a value another version wrote, counts as none.
	return Effect.option(Effect.flatMap(decode(memos[name]), (stored) => signal.decode(stored.value)));
}

const decode = Schema.decodeUnknownEffect(Schema.Struct({ value: Schema.Unknown }));
