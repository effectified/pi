// The job events of a swarm: what a host that shows progress reads.

import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";
import * as Swarm from "../src/index.ts";
import { asked, harness, jobsOf, Measure, measured, model, primed } from "./support.ts";

describe("events", () => {
	it("gives each job's start before its end, a failure with its reason, and ends when every job has settled", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* primed(1);
				yield* Swarm.start(Measure, {
					id: Swarm.SwarmId.make("watched"),
					source: root.id,
					jobs: jobsOf(["a", "bad", "ccc"]),
					cap: 2,
					onFailure: "collect",
				});
				const watching = yield* Effect.forkChild(Stream.runCollect(Swarm.events(Swarm.SwarmId.make("watched"))));
				yield* Swarm.result(Measure, Swarm.SwarmId.make("watched"));
				const live = yield* Fiber.join(watching);
				// A host that attaches when all is over gets the same story, folded.
				return { live, late: yield* Stream.runCollect(Swarm.events(Swarm.SwarmId.make("watched"))) };
			}).pipe(
				Effect.provide(
					harness(
						model(asked(), (word) => ({
							text: word === "bad" ? "never JSON" : JSON.stringify(measured(word)),
							afterMillis: 1,
						})),
					),
				),
			),
		);
		const of = (key: string, all: ReadonlyArray<Swarm.JobEvent>) =>
			all.filter((event) => event.key === key).map((event) => event._tag);
		expect(of("job-a", seen.live)).toEqual(["Started", "Settled"]);
		expect(of("job-ccc", seen.live)).toEqual(["Started", "Settled"]);
		expect(seen.live.filter((event) => event.key === "job-bad")).toEqual([
			{ _tag: "Started", key: "job-bad" },
			{ _tag: "Failed", key: "job-bad", reason: "invalid-result" },
		]);
		// Under a cap of 2 the third job starts only after one of the first two has ended.
		const order = seen.live.map((event) => `${event._tag} ${event.key}`);
		expect(order.indexOf("Started job-ccc")).toBeGreaterThan(
			Math.min(order.indexOf("Settled job-a"), order.indexOf("Failed job-bad")),
		);
		expect(seen.late).toEqual([
			{ _tag: "Started", key: "job-a" },
			{ _tag: "Settled", key: "job-a" },
			{ _tag: "Failed", key: "job-bad", reason: "invalid-result" },
			{ _tag: "Started", key: "job-ccc" },
			{ _tag: "Settled", key: "job-ccc" },
		]);
	});
});
