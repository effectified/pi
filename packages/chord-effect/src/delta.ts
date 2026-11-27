// `@effectified/pi-chord/delta`: Chord's delta ops (the changes of a JSON value), applied and decoded as Effects.

import {
	assertSafePath,
	assertValidOp,
	assertValidWireOp,
	type Op,
	type Path,
	apply as piApply,
	applyImmutable as piApplyImmutable,
	applyImmutableBatches as piApplyImmutableBatches,
	decoder as piDecoder,
	type WireOp,
} from "@earendil-works/chord/delta";
import { Effect, Predicate } from "effect";
import { type DeltaError, FROM_DELTA, fromDelta, InvalidOp, type UnsafePathError } from "./errors.ts";

// Chord's delta types (`Op`, `WireOp`, `Path`, `Draft`, `Tracker`, `Change`, ...); `Decoder` is this package's own.
export type * from "@earendil-works/chord/delta";
// Chord's delta values that never fail on their data: predicates, text helpers, the encoder, the revision diff and the
// tracker. A tracker throws only when it is misused (a settled overlay written to, a prepared change used twice).
export {
	appendText,
	diffRevisions,
	encoder,
	isBase,
	isReplace,
	overlap,
	ownedSlice,
	PendingOps,
	RESERVED_SEGMENTS,
	track,
} from "@earendil-works/chord/delta";
export { type DeltaError, InvalidOp, PathError, UnsafePathError } from "./errors.ts";

/**
 * Chord's `apply`: `ops` applied to `target` in place, and the result (an `r` op replaces the value, so use what this
 * gives). Fails with the `DeltaError` of the first op that cannot be applied; the ops before it stay applied.
 */
export function apply<T>(target: T | undefined, ops: readonly Op[]): Effect.Effect<T, DeltaError> {
	return attempt(() => piApply(target, ops), fromDelta);
}

/** Chord's `applyImmutable`: `ops` applied to a copy of what they change, `target` left as it was. */
export function applyImmutable<T>(target: T | undefined, ops: readonly Op[]): Effect.Effect<T, DeltaError> {
	return attempt(() => piApplyImmutable(target, ops), fromDelta);
}

/** Chord's `applyImmutableBatches`: several batches replayed onto copies, giving only the final value. */
export function applyImmutableBatches<T>(
	target: T | undefined,
	batches: Iterable<readonly Op[]>,
): Effect.Effect<T, DeltaError> {
	return attempt(() => piApplyImmutableBatches(target, batches), fromDelta);
}

/** Chord's check of a decoded op (`assertValidOp`): `op` as an `Op`, or `InvalidOp`. */
export function validateOp(op: unknown): Effect.Effect<Op, InvalidOp> {
	return Effect.try({
		try: () => {
			assertValidOp(op);
			return op;
		},
		catch: invalidOp,
	});
}

/** Chord's check of an op on the wire (`assertValidWireOp`): `op` as a `WireOp`, or `InvalidOp`. */
export function validateWireOp(op: unknown): Effect.Effect<WireOp, InvalidOp> {
	return Effect.try({
		try: () => {
			assertValidWireOp(op);
			return op;
		},
		catch: invalidOp,
	});
}

/** What Chord's op checks throw, which is only a `TypeError` naming the fault, as `InvalidOp`. */
function invalidOp(thrown: unknown): InvalidOp {
	return InvalidOp.make({ message: Predicate.isError(thrown) ? thrown.message : String(thrown) });
}

/** Chord's path check (`assertSafePath`): `UnsafePathError` for a segment that reaches the prototype chain. */
export function validateSafePath(path: Path): Effect.Effect<void, UnsafePathError> {
	// Chord's path check throws only its `UnsafePathError`.
	return attempt(() => assertSafePath(path), FROM_DELTA.UnsafePathError);
}

/** The decoding side of one state stream: the path ids its encoder defined so far are remembered between batches. */
export interface Decoder {
	/** Ops as received, each checked, as decoded ops; fails with the `DeltaError` of the first that is not valid. */
	readonly decode: (wire: readonly unknown[]) => Effect.Effect<Op[], DeltaError>;
}

/** A new decoder (Chord's `decoder`), for one state stream: it must see every batch its encoder made, in order. */
export const decoder: Effect.Effect<Decoder> = Effect.sync(() => {
	const decoding = piDecoder();
	return { decode: (wire) => attempt(() => decoding.decode(wire), fromDelta) };
});

/**
 * `run` as an Effect: what delta throws on its data is the error `from` maps it to (`fromDelta`: any `DeltaError`);
 * anything `from` does not map is a defect.
 */
function attempt<A, E extends DeltaError>(run: () => A, from: (thrown: unknown) => E | undefined): Effect.Effect<A, E> {
	return Effect.suspend(() => {
		try {
			return Effect.succeed(run());
		} catch (thrown) {
			const error = from(thrown);
			return error === undefined ? Effect.die(thrown) : Effect.fail(error);
		}
	});
}
