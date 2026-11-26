import * as PiDelta from "@earendil-works/chord/delta";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { Coverage } from "../../../effect/conformance.ts";
import * as Package from "../src/delta.ts";
import {
	apply,
	applyImmutable,
	applyImmutableBatches,
	decoder,
	encoder,
	InvalidOp,
	type Op,
	PathError,
	UnsafePathError,
	validateOp,
	validateSafePath,
	validateWireOp,
} from "../src/delta.ts";

const offered: Coverage = { kind: "offered" };
const replaced = (by: string): Coverage => ({ kind: "replaced", by });
const TAGGED = replaced("PathError and UnsafePathError, tagged errors of the DeltaError union");

/** What `@effectified/pi-chord/delta` does with every value Chord's `/delta` exports. */
const COVERAGE = {
	appendText: offered,
	diffRevisions: offered,
	encoder: offered,
	isBase: offered,
	isReplace: offered,
	overlap: offered,
	ownedSlice: offered,
	PendingOps: offered,
	RESERVED_SEGMENTS: offered,
	track: offered,
	apply: replaced("apply: an Effect that fails with a DeltaError where Chord throws"),
	applyImmutable: replaced("applyImmutable: an Effect that fails with a DeltaError"),
	applyImmutableBatches: replaced("applyImmutableBatches: an Effect that fails with a DeltaError"),
	assertValidOp: replaced("validateOp: the op as an Op, or InvalidOp"),
	assertValidWireOp: replaced("validateWireOp: the op as a WireOp, or InvalidOp"),
	assertSafePath: replaced("validateSafePath: fails with UnsafePathError"),
	decoder: replaced("decoder: an Effect giving a Decoder whose decode is an Effect"),
	PathError: TAGGED,
	UnsafePathError: TAGGED,
} satisfies Record<keyof typeof PiDelta, Coverage>;

describe("the coverage of Chord's /delta", () => {
	it("offers every value it records as offered, Chord's own", () => {
		const ours: Record<string, unknown> = Package;
		const pi: Record<string, unknown> = PiDelta;
		const wrong = Object.entries(COVERAGE)
			.filter(([name, coverage]) => coverage === offered && ours[name] !== pi[name])
			.map(([name]) => name);
		expect(wrong).toEqual([]);
	});
});

describe("apply", () => {
	it("applies ops in place and gives the value", async () => {
		const target = { title: "Draft", tags: ["a"] };
		const ops: Op[] = [
			["a", ["title"], " 2"],
			["p", ["tags"], 1, 0, ["b"]],
		];
		const result = await Effect.runPromise(apply(target, ops));
		expect(result).toBe(target);
		expect(result).toEqual({ title: "Draft 2", tags: ["a", "b"] });
	});

	it("fails with PathError, UnsafePathError or InvalidOp where Chord throws", async () => {
		const failures = await Effect.runPromise(
			Effect.all([
				Effect.flip(apply({ title: 1 }, [["a", ["title"], "x"]])),
				Effect.flip(apply({}, [["s", ["__proto__", "polluted"], true]])),
				Effect.flip(apply({}, [["s"]] as unknown as Op[])), // An op off the wire, not checked yet.
			]),
		);
		expect(failures[0]).toBeInstanceOf(PathError);
		expect(failures[0]).toMatchObject({ path: ["title"] });
		expect(failures[1]).toBeInstanceOf(UnsafePathError);
		expect(failures[1]).toMatchObject({ segment: "__proto__" });
		expect(failures[2]).toBeInstanceOf(InvalidOp);
		expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
	});
});

describe("applyImmutable and applyImmutableBatches", () => {
	it("leave the target as it was", async () => {
		const target = { count: "1", list: [1] };
		const once = await Effect.runPromise(applyImmutable(target, [["s", ["count"], "2"]]));
		const replayed = await Effect.runPromise(
			applyImmutableBatches(target, [[["s", ["count"], "3"]], [["p", ["list"], 1, 0, [2]]]]),
		);
		expect(target).toEqual({ count: "1", list: [1] });
		expect(once).toEqual({ count: "2", list: [1] });
		expect(replayed).toEqual({ count: "3", list: [1, 2] });
	});

	it("fail with the DeltaError of an op that cannot be applied", async () => {
		const errors = await Effect.runPromise(
			Effect.all([
				Effect.flip(applyImmutable({}, [["s", ["missing", "x"], 1]])),
				Effect.flip(applyImmutableBatches({ list: [] }, [[["s", ["list", 3], 1]]])),
			]),
		);
		expect(errors[0]).toBeInstanceOf(PathError);
		// An index past the end would leave a hole that JSON cannot keep: Chord refuses it as unsafe.
		expect(errors[1]).toBeInstanceOf(UnsafePathError);
	});
});

describe("validateOp, validateWireOp and validateSafePath", () => {
	it("give the op, or fail with InvalidOp or UnsafePathError", async () => {
		const results = await Effect.runPromise(
			Effect.all([
				validateOp(["s", ["a"], 1]),
				Effect.flip(validateOp(["s", 1])),
				validateWireOp(["s", 1]),
				Effect.flip(validateWireOp("s")),
				Effect.flip(validateSafePath(["constructor"])),
			]),
		);
		expect(results[0]).toEqual(["s", ["a"], 1]);
		expect(results[1]).toBeInstanceOf(InvalidOp);
		expect(results[2]).toEqual(["s", 1]);
		expect(results[3]).toBeInstanceOf(InvalidOp);
		expect(results[4]).toBeInstanceOf(UnsafePathError);
	});
});

describe("decoder", () => {
	it("decodes what Chord's encoder wrote, remembering path ids between batches", async () => {
		const encoding = encoder();
		const first: Op[] = [
			["s", ["a"], 1],
			["s", ["a"], 2],
			["s", ["b"], 3],
		];
		const second: Op[] = [["s", ["a"], 4]];
		const decoded = await Effect.runPromise(
			Effect.gen(function* () {
				const decoding = yield* decoder;
				return [yield* decoding.decode(encoding.encode(first)), yield* decoding.decode(encoding.encode(second))];
			}),
		);
		expect(decoded).toEqual([first, second]);
	});

	it("fails with the DeltaError of a wire op it cannot decode", async () => {
		const errors = await Effect.runPromise(
			Effect.gen(function* () {
				const decoding = yield* decoder;
				return [yield* Effect.flip(decoding.decode([["s", 7, 1]])), yield* Effect.flip(decoding.decode([{}]))];
			}),
		);
		expect(errors[0]).toBeInstanceOf(PathError);
		expect(errors[1]).toBeInstanceOf(InvalidOp);
	});
});
