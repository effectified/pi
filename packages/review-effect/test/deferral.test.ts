import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { key, Retried } from "../src/deferral.ts";

describe("the retry signal", () => {
	it("has a name of this package, carries nothing, and a key per attempt", async () => {
		const token = await Effect.runPromise(Retried.token);
		expect([token.name, token.version, key(1), key(2)]).toEqual(["review.retry", 1, "retry/1", "retry/2"]);
		expect(await Effect.runPromise(Retried.decode(await Effect.runPromise(Retried.encode({}))))).toEqual({});
	});
});
