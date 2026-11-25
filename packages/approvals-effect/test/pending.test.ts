import { answer, fauxAssistantMessage, fauxToolCall } from "@gunta/pi-durable-effect/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { approve, decide, pending } from "../src/index.ts";
import { parked, scene, submit, tick } from "./scene.ts";

/** One model turn with two `write` calls and a `read`, which needs no approval. */
const THREE_CALLS = fauxAssistantMessage(
	[
		fauxToolCall("write", { text: "one" }, { id: "call-1" }),
		fauxToolCall("read", { path: "a.txt" }, { id: "call-2" }),
		fauxToolCall("write", { text: "two" }, { id: "call-3" }),
	],
	{ stopReason: "toolUse" },
);

describe("pending", () => {
	it("is empty while nothing asked", async () => {
		const { layer } = scene();
		expect(await Effect.runPromise(Effect.provide(pending, layer))).toEqual([]);
	});

	it("lists exactly the requests a decision can still reach, as the inbox was shown them, in task order", async () => {
		const { written, published, layer, hold, release } = scene({ responses: [THREE_CALLS, answer("Done.")] });
		hold();
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* submit("Write both.");
				yield* parked(published, 1);
				yield* parked(published, 2);
				const both = yield* pending;
				const [first, second] = [...published].sort((a, b) => a.task - b.task);
				if (first === undefined || second === undefined) return yield* Effect.die("two requests were expected");
				// Decided and still running: it is no longer pending, the other one is.
				yield* decide(first, yield* approve(first, "ada"));
				while (written.length === 0) yield* tick;
				const one = yield* pending;
				yield* Effect.sync(release);
				yield* decide(second, yield* approve(second, "ada"));
				yield* submission.wait;
				yield* root.waitForIdle;
				return { both, one, none: yield* pending, first, second };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen.both).toEqual([seen.first, seen.second]);
		expect(seen.both.map((request) => request.callId).sort()).toEqual(["call-1", "call-3"]);
		expect(seen.one).toEqual([seen.second]);
		expect(seen.none).toEqual([]);
		expect([...written].sort()).toEqual(["one", "two"]);
	});

	it("drops the request of a call that was aborted", async () => {
		const { published, layer } = scene();
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { root } = yield* submit();
				const request = yield* parked(published);
				const before = yield* pending;
				yield* root.abort();
				return { request, before, after: yield* pending };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen.before).toEqual([seen.request]);
		expect(seen.after).toEqual([]);
	});
});
