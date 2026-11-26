// What chord-effect writes by hand that mirrors a Chord type, checked against Chord's own types. Type-only: nothing
// here runs. Everything else of ours is derived from Chord (imported types, `Parameters`) where it is written.

import type * as PiDelta from "@earendil-works/chord/delta";
import type {
	Decoder as PiDecoder,
	PathError as PiPathError,
	UnsafePathError as PiUnsafePathError,
} from "@earendil-works/chord/delta";
import type { Assert, Conform } from "../../../effect/conformance.ts";
import type { Decoder, PathError, UnsafePathError } from "../src/delta.ts";
import type { DeltaErrorClass } from "../src/errors.ts";

/** `PathError.path` is the Schema of what Chord's `PathError` names: a path, or a path id of the wire. */
export type PathErrorPath = Assert<Conform<PathError["path"], PiPathError["path"]>>;

/** `UnsafePathError.segment` is the Schema of the segment Chord's `UnsafePathError` names. */
export type UnsafePathErrorSegment = Assert<Conform<UnsafePathError["segment"], PiUnsafePathError["segment"]>>;

/** `Decoder` has Chord's members, and `decode` takes what Chord's takes. */
export type DecoderMembers = Assert<Conform<keyof Decoder, keyof PiDecoder>>;
export type DecoderInput = Assert<Conform<Parameters<Decoder["decode"]>, Parameters<PiDecoder["decode"]>>>;

/** The names of the error classes Chord's delta exports. */
type PiDeltaErrorClass = {
	[K in keyof typeof PiDelta]: (typeof PiDelta)[K] extends abstract new (...args: never[]) => Error ? K : never;
}[keyof typeof PiDelta];

/** `fromDelta` has a tag for every error class of Chord's delta: a class Chord adds fails here until it has one. */
export type DeltaErrorClasses = Assert<Conform<DeltaErrorClass, PiDeltaErrorClass>>;
