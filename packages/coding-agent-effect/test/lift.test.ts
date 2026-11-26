import { runTest } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { awaits, fields, reads, writes } from "../src/lift.ts";

/** A small class with Pi's kinds of members: a field, a getter, reads, writes and an asynchronous method. */
class Counter {
	count = 0;
	get doubled(): number {
		return this.count * 2;
	}
	read(): number {
		return this.count;
	}
	add(by: number): number {
		if (by < 0) throw new Error("only up");
		this.count += by;
		return this.count;
	}
	async later(by: number): Promise<number> {
		if (by < 0) throw new Error("not later");
		return this.add(by);
	}
}

describe("lifting Pi's members", () => {
	it("gives each listed member as an Effect that calls it on the object when it runs", async () => {
		const counter = new Counter();
		const lifted = {
			...fields(counter, ["count", "doubled"]),
			...reads(counter, ["read"]),
			...writes(counter, ["add"]),
			...awaits(counter, ["later"]),
		};
		const seen = await runTest(
			Effect.gen(function* () {
				yield* lifted.add(2);
				yield* lifted.later(3);
				return { count: yield* lifted.count, doubled: yield* lifted.doubled, read: yield* lifted.read() };
			}),
		);
		expect(seen).toEqual({ count: 5, doubled: 10, read: 5 });
	});

	it("fails a write or an asynchronous method with what Pi threw, as a CodingAgentError", async () => {
		const counter = new Counter();
		const failures = await runTest(
			Effect.gen(function* () {
				const add = yield* Effect.flip(writes(counter, ["add"]).add(-1));
				const later = yield* Effect.flip(awaits(counter, ["later"]).later(-1));
				return [add.message, later.message];
			}),
		);
		expect(failures).toEqual(["only up", "not later"]);
	});
});
