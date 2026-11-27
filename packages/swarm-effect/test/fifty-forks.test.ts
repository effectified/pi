// The PRD's fork and swarm test (sections 8 and 10): 50 forks of a 30-turn conversation under a cap of 8, with
// scripted models, in under 5 seconds.

import { Harness } from "@effectified/pi-durable";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import * as Swarm from "../src/index.ts";
import { asked, harness, jobsOf, keys, Measure, measured, model, primed, words } from "./support.ts";

const TURNS = 30;
const JOBS = 50;
const CAP = 8;
const LIMIT_MILLIS = 5000;

describe("a swarm of 50 forks of a primed conversation of 30 turns, cap 8", () => {
	it("gives every fork the 30 turns, never exceeds the cap, fans 50 typed results in in job order, and cleans up", async () => {
		const counts = asked();
		const list = words(JOBS);
		const pins = keys("job-w0", `job-${list[49]}`);
		const begun = performance.now();
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* primed(TURNS);
				const primedAt = performance.now();
				yield* Swarm.start(Measure, {
					id: Swarm.SwarmId.make("fifty"),
					source: root.id,
					jobs: jobsOf(list),
					cap: CAP,
					onFailure: "fail",
					pins,
				});
				const result = yield* Swarm.result(Measure, Swarm.SwarmId.make("fifty"));
				const swarmMillis = performance.now() - primedAt;
				const driver = yield* Swarm.ForkDriver;
				const stored = yield* Harness.commit((tx) => tx.scanConversations({}, 1000));
				const turns = yield* Stream.runCollect(root.entries({ order: "ascending" }));
				return {
					result,
					swarmMillis,
					kept: yield* driver.list(Swarm.SwarmId.make("fifty")),
					stored: stored.items,
					root: root.id,
					turns,
				};
			}).pipe(Effect.provide(harness(model(counts)))),
		);
		const totalMillis = performance.now() - begun;
		// The number the report gives: on this runtime, with scripted models.
		console.log(
			`50-fork swarm: ${seen.swarmMillis.toFixed(0)} ms for the swarm, ${totalMillis.toFixed(0)} ms with priming`,
		);

		// The source holds 30 turns, and nothing of the swarm: a user and an assistant entry per turn.
		expect(seen.turns.filter((entry) => entry.kind === "pi.user")).toHaveLength(TURNS);
		// Every fork saw the 30 turns, and each job was asked of the model once.
		expect([...counts.primed.entries()]).toEqual(list.map((word) => [word, TURNS]));
		expect([...counts.requests.values()]).toEqual(list.map(() => 1));
		// The cap was reached and never exceeded.
		expect(counts.maxLive).toBe(CAP);
		// 50 typed results, in job order.
		expect(seen.result.ending).toBe("completed");
		expect(seen.result.jobs).toEqual(
			list.map((word) => ({ _tag: "Success", key: `job-${word}`, value: measured(word) })),
		);
		// One fork per job key, each a fork of the source at the same entry.
		expect(seen.stored).toHaveLength(1 + JOBS);
		const parents = seen.stored.slice(1).map((conversation) => conversation.parent);
		expect(new Set(parents.map((parent) => parent?.conversationId))).toEqual(new Set([seen.root]));
		expect(new Set(parents.map((parent) => parent?.at)).size).toBe(1);
		// Unpinned forks are destroyed, pinned ones are kept.
		expect(seen.result.forks).toHaveLength(JOBS);
		expect(seen.result.forks.filter((fork) => fork.fate === "destroyed")).toHaveLength(JOBS - pins.length);
		expect(seen.result.forks.filter((fork) => fork.fate === "pinned").map((fork) => fork.jobKey)).toEqual(pins);
		expect(seen.kept.map((fork) => fork.jobKey)).toEqual(pins);
		// PRD section 8: a 50-fork swarm with scripted models in under 5 seconds.
		expect(totalMillis).toBeLessThan(LIMIT_MILLIS);
	}, 30_000);
});
