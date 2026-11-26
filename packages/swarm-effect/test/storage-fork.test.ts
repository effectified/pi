// `onStorageFork` on one storage, which stands in for a copy of itself here: the suite on a copied SQLite file is in
// kill-resume.ts.

import { Harness } from "@effectified/pi-durable";
import { TestHarness } from "@effectified/pi-durable/testing";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import * as Swarm from "../src/index.ts";
import { Copy } from "../src/ledger.ts";
import { fake } from "./fake-driver.ts";
import { jobsOf, Measure, measured } from "./support.ts";

describe("onStorageFork", () => {
	it("ends every coordinator the storage holds as copied, asks the driver nothing, and leaves later swarms alone", async () => {
		const driver = fake({
			notice: "signal",
			job: (key, requestId) => ({
				answer: Option.some(JSON.stringify(measured(key.slice(4)))),
				settlesAfterMillis: requestId.startsWith("inherited/") ? Infinity : 0,
			}),
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.root;
				yield* root.commit((tx) => tx.appendEntry(root.id, { kind: "test.primed" }));
				const plan = { source: root.id, cap: 2, onFailure: "collect" as const };
				const inherited = yield* Swarm.start(Measure, { ...plan, id: "inherited", jobs: jobsOf(["a", "b", "c"]) });
				yield* driver.when(() => driver.accepted.size === 2);
				const calls = { forks: driver.forkCalls.size, runs: driver.runCalls.size, jobs: driver.jobCalls.size };
				yield* Swarm.onStorageFork;
				const result = yield* Effect.flip(Swarm.result(Measure, "inherited"));
				const status = yield* Swarm.status("inherited");
				const after = { forks: driver.forkCalls.size, runs: driver.runCalls.size, jobs: driver.jobCalls.size };
				// A swarm started after the mark is this storage's own.
				yield* Swarm.start(Measure, { ...plan, id: "own", jobs: jobsOf(["d"]) });
				yield* driver.when(() => driver.accepted.size === 3);
				const own = yield* Swarm.status("own");
				return { inherited, mark: yield* Harness.snapshot(Copy), result, status, calls, after, own };
			}).pipe(
				Effect.provide(
					TestHarness.layer({ extensions: [Swarm.extension([Measure])] }).pipe(Layer.provideMerge(driver.layer)),
				),
			),
		);
		expect(seen.mark).toEqual(Option.some({ through: seen.inherited.taskId }));
		expect(seen.result).toEqual(new Swarm.SwarmFaulted({ swarmId: "inherited", reason: "copied" }));
		expect(seen.status).toMatchObject({ running: false, phase: "ended" });
		expect(seen.after).toEqual(seen.calls);
		expect(driver.cancelled).toEqual([]);
		expect(driver.destroyed).toEqual([]);
		expect([...driver.forks.keys()].slice(0, 2)).toEqual(["job-a", "job-b"]);
		expect(seen.own.taskId).toBeGreaterThan(seen.inherited.taskId);
		expect(seen.own.running).toBe(true);
	});

	it("marks a storage that holds no swarm, so nothing older than the mark can run one", async () => {
		const mark = await Effect.runPromise(
			Effect.andThen(Swarm.onStorageFork, Harness.snapshot(Copy)).pipe(
				Effect.provide(
					TestHarness.layer({ extensions: [Swarm.extension([Measure])] }).pipe(Layer.provideMerge(fake().layer)),
				),
			),
		);
		expect(mark).toEqual(Option.some({ through: 0 }));
	});
});
