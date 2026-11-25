import { Harness } from "@gunta/pi-durable-effect";
import { TestHarness } from "@gunta/pi-durable-effect/testing";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { failed, type Job, planned } from "../src/job.ts";
import { Copy, Jobs, progressOf, report, Swarms } from "../src/ledger.ts";

const running: Job = {
	status: "running",
	fork: "f",
	correction: 0,
	wait: { _tag: "Poll", at: 1, everyMillis: 1 },
	attempts: 0,
	ran: { conversationId: 4, actorId: null },
};

describe("what a swarm stores beside its task", () => {
	it("lives under kinds prefixed swarm., in session scope", () => {
		expect([Swarms.kind, Jobs.kind, Copy.kind]).toEqual(["swarm.swarm", "swarm.jobs", "swarm.copy"]);
		expect([Swarms.scope, Jobs.scope, Copy.scope]).toEqual(["session", "session", "session"]);
	});

	it("says of a job its status, the reason of a failed one, and where it runs once its driver said so", () => {
		expect(progressOf(planned)).toEqual({ status: "planned", reason: null, ran: null });
		expect(progressOf(failed(null, "gone", "x"))).toEqual({ status: "failed", reason: "gone", ran: null });
		expect(progressOf(running)).toEqual({
			status: "running",
			reason: null,
			ran: { conversationId: 4, actorId: null },
		});
	});

	it("writes the jobs whose status changed, and nothing when none did", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const keys = ["a", "b", "c"];
				yield* Harness.commit((tx) =>
					report(tx, "s", keys, [planned, planned, planned], [planned, planned, planned]),
				);
				const untouched = yield* Harness.snapshot(Jobs, "s");
				yield* Harness.commit((tx) =>
					report(tx, "s", keys, [planned, planned, planned], [running, planned, planned]),
				);
				const first = yield* Harness.snapshot(Jobs, "s");
				yield* Harness.commit((tx) =>
					report(tx, "s", keys, [running, planned, planned], [running, failed(null, "cancelled", "x"), planned]),
				);
				return {
					untouched,
					first,
					second: yield* Harness.snapshot(Jobs, "s"),
					other: yield* Harness.snapshot(Jobs, "t"),
				};
			}).pipe(Effect.provide(TestHarness.layer())),
		);
		// No change, no document: a commit that changes no job does not write.
		expect(seen.untouched).toEqual(Option.none());
		const ran = { conversationId: 4, actorId: null };
		expect(seen.first).toEqual(Option.some({ a: { status: "running", reason: null, ran } }));
		expect(seen.second).toEqual(
			Option.some({
				a: { status: "running", reason: null, ran },
				b: { status: "failed", reason: "cancelled", ran: null },
			}),
		);
		expect(seen.other).toEqual(Option.none());
	});
});
