import type { Hook } from "@effectified/pi-durable";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as Asks from "../src/asks.ts";
import { Request } from "../src/index.ts";

/** The stored JSON of the ask number `index`, for arguments whose digest is 64 times `letter`. */
const request = (index: number, letter: string) => {
	const digest = letter.repeat(64);
	return {
		id: `12:${index}:${digest}`,
		conversation: 1,
		task: 12,
		callId: "call-1",
		tool: "write",
		arguments: { text: letter },
		digest,
		askedAt: 1_000 + index,
		expiresAt: 2_000 + index,
	};
};

const decoded = Schema.decodeUnknownSync(Request);

/** A task's memos as a hook's api gives them: first writer wins. `reads` counts the reads. */
function memos(initial: Record<string, unknown> = {}) {
	const stored = new Map<string, unknown>(Object.entries(initial));
	const reads: string[] = [];
	const memo = ((name: string, candidate?: unknown) =>
		Effect.sync(() => {
			if (candidate === undefined) {
				reads.push(name);
				return Option.fromUndefinedOr(stored.get(name));
			}
			if (!stored.has(name)) stored.set(name, candidate);
			return stored.get(name);
		})) as Hook.Api["memo"];
	return { stored, reads, memo };
}

describe("read", () => {
	it("gives no request for a call that never asked, with one read", async () => {
		const { reads, memo } = memos({ "other.memo": 1 });
		expect(await Effect.runPromise(Asks.read(memo))).toEqual([]);
		expect(reads).toEqual(["approvals.ask/0"]);
	});

	it("gives every request in the order they were made, and stops at the first gap", async () => {
		const { reads, memo } = memos({
			"approvals.ask/0": request(0, "a"),
			"approvals.ask/1": request(1, "b"),
			"approvals.ask/3": request(3, "c"),
		});
		expect(await Effect.runPromise(Asks.read(memo))).toEqual([request(0, "a"), request(1, "b")]);
		expect(reads).toEqual(["approvals.ask/0", "approvals.ask/1", "approvals.ask/2"]);
	});

	it("fails with MalformedState, naming the memo, for a stored value that is no request", async () => {
		const { memo } = memos({
			"approvals.ask/0": request(0, "a"),
			"approvals.ask/1": { id: `12:1:${"b".repeat(64)}` },
		});
		const error = await Effect.runPromise(Effect.flip(Asks.read(memo)));
		expect(error).toMatchObject({ _tag: "MalformedState", where: "approvals.ask/1" });
	});
});

describe("ofRecord", () => {
	it("reads the same requests from a task record's memos, and none from a record without memos", async () => {
		const record = { "approvals.ask/0": request(0, "a"), "approvals.ask/1": request(1, "b"), "pi.other": true };
		expect(await Effect.runPromise(Asks.ofRecord(record))).toEqual([request(0, "a"), request(1, "b")]);
		expect(await Effect.runPromise(Asks.ofRecord(undefined))).toEqual([]);
		expect(await Effect.runPromise(Asks.ofRecord({}))).toEqual([]);
	});

	it("fails with MalformedState for a memo that is no request", async () => {
		const error = await Effect.runPromise(Effect.flip(Asks.ofRecord({ "approvals.ask/0": "request" })));
		expect(error).toMatchObject({ _tag: "MalformedState", where: "approvals.ask/0" });
	});
});

describe("append", () => {
	it("stores the first candidate of an ask and gives it back for every later one", async () => {
		const { stored, memo } = memos();
		const first = await Effect.runPromise(Asks.append(memo, 0, decoded(request(0, "a"))));
		// Pi asks again after a crash: the later candidate has another time, and the stored request stands.
		const again = await Effect.runPromise(
			Asks.append(memo, 0, decoded({ ...request(0, "a"), askedAt: 9_000, expiresAt: 9_999 })),
		);
		expect(first).toEqual(request(0, "a"));
		expect(again).toEqual(first);
		expect([...stored.keys()]).toEqual(["approvals.ask/0"]);
	});
});
