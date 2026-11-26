import { ChordError, PluginError } from "@earendil-works/chord";
import { PathError as PiPathError, UnsafePathError as PiUnsafePathError } from "@earendil-works/chord/delta";
import { describe, expect, it } from "vitest";
import {
	ChordFailed,
	fromChord,
	fromDelta,
	InvalidOp,
	PathError,
	PluginFailed,
	SqliteError,
	UnsafePathError,
} from "../src/errors.ts";

describe("fromDelta", () => {
	it("maps each error class of Chord's delta to its tag, keeping what it names", () => {
		expect(fromDelta(new PiPathError(["a", 0]))).toEqual(
			new PathError({ path: ["a", 0], message: 'unresolvable path: ["a",0]' }),
		);
		expect(fromDelta(new PiPathError(3))).toMatchObject({ _tag: "PathError", path: 3 });
		expect(fromDelta(new PiUnsafePathError("__proto__"))).toEqual(
			new UnsafePathError({ segment: "__proto__", message: "unsafe path segment: __proto__" }),
		);
	});

	it("maps the TypeError of an op check to InvalidOp, and leaves anything else to be a defect", () => {
		expect(fromDelta(new TypeError("r arity"))).toEqual(new InvalidOp({ message: "r arity" }));
		expect(fromDelta(new RangeError("other"))).toBeUndefined();
		expect(fromDelta("thrown")).toBeUndefined();
	});
});

describe("SqliteError", () => {
	it("takes its message from its cause", () => {
		expect(new SqliteError({ cause: new Error("database is locked") }).message).toBe("database is locked");
		expect(new SqliteError({ cause: "busy" }).message).toBe("busy");
	});
});

describe("fromChord", () => {
	it("maps each error class of Chord's root to its tag, keeping code, reason and details", () => {
		expect(
			fromChord(new ChordError({ code: "invalid", reason: "args", message: "bad", details: { at: 1 } })),
		).toEqual(new ChordFailed({ code: "invalid", reason: "args", message: "bad", details: { at: 1 } }));
		expect(fromChord(new ChordError({ code: "not_ready", message: "later" }))).toEqual(
			new ChordFailed({ code: "not_ready", message: "later" }),
		);
		expect(fromChord(new PluginError("quota", "over", ["a"]))).toEqual(
			new PluginFailed({ code: "quota", message: "over", details: ["a"] }),
		);
	});

	it("leaves anything else to its caller", () => {
		expect(fromChord(new Error("database is locked"))).toBeUndefined();
	});
});
