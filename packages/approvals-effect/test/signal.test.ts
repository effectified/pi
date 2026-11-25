import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Decided, settled } from "../src/signal.ts";

describe("Decided", () => {
	it("is a signal Pi accepts, named for the package, whose values are decisions as JSON", async () => {
		const token = await Effect.runPromise(Decided.token);
		expect([token.name, token.version, token.key("7:0:abc")]).toEqual([
			"approvals.decision",
			1,
			{ signal: "approvals.decision", key: "7:0:abc" },
		]);
		const denial = { _tag: "Denied", digest: "d", by: "bob", at: 2, note: "No." } as const;
		const json = await Effect.runPromise(Decided.encode(denial));
		expect(json).toEqual(denial);
		expect(await Effect.runPromise(Decided.decode(json))).toEqual(denial);
	});

	it("refuses a value that is no decision", async () => {
		const error = await Effect.runPromise(Effect.flip(Decided.decode({ _tag: "Approved", by: "ada" })));
		expect(error._tag).toBe("SchemaDecodeError");
	});
});

describe("settled", () => {
	it("is true only when the task's memos hold a state for exactly that key of the signal", () => {
		const memos = {
			"pi.signal.approvals.decision/7:0:abc": { version: 1, value: {} },
			"pi.signal.approvals.decision/7:1:def": { expired: true },
			"pi.signal.other.signal/7:2:ghi": { version: 1, value: {} },
			"approvals.ask/0": {},
		};
		expect(["7:0:abc", "7:1:def", "7:2:ghi", "7:0", "toString"].map((key) => settled(memos, key))).toEqual([
			true,
			true,
			false,
			false,
			false,
		]);
		expect(settled(undefined, "7:0:abc")).toBe(false);
	});
});
