// The host operations on the in-storage driver, with a scripted model: start, status, cancel, result, destroyFork.

import { Harness } from "@effectified/pi-durable";
import { TestHarness } from "@effectified/pi-durable/testing";
import { Effect, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as Swarm from "../src/index.ts";
import { fake } from "./fake-driver.ts";
import {
	type Asked,
	asked,
	harness,
	jobsOf,
	Measure,
	measured,
	model,
	primed,
	type Reply,
	tally,
	until,
	writtenBy,
} from "./support.ts";

const success = (word: string) => ({ _tag: "Success", key: `job-${word}`, value: measured(word) });

const play = <A, E>(
	program: Effect.Effect<A, E, TestHarness.Provided | Swarm.ForkDriver>,
	counts: Asked = asked(),
	reply?: (word: string, attempt: number) => Reply,
) => Effect.runPromise(program.pipe(Effect.provide(harness(model(counts, reply)))));

/** Where the job at `index` runs by this status: a fork conversation of the storage, known once its fork is asked. */
const ranOf = (status: Swarm.Status, index: number) => {
	const ran = status.jobs[index].ran;
	expect(Option.map(ran, (place) => [typeof place.conversationId, place.actorId])).toEqual(
		Option.some(["number", null]),
	);
	return ran;
};

const conversations = Effect.map(
	Harness.commit((tx) => tx.scanConversations({}, 1000)),
	(page) => page.items,
);

const coordinators = Effect.map(
	Harness.commit((tx) => Effect.promise(() => tx.pi.scanTasks({ kind: "swarm.coordinator.measure" }, 100))),
	(page) => page.items.map((task) => task.id),
);

describe("start", () => {
	it("is one swarm for one id: a second start creates nothing, and no job runs twice", async () => {
		const counts = asked();
		const seen = await play(
			Effect.gen(function* () {
				const root = yield* primed(2);
				const plan = {
					id: "once",
					source: root.id,
					jobs: jobsOf(["a", "bb", "ccc"]),
					cap: 2,
					onFailure: "collect" as const,
				};
				const first = yield* Swarm.start(Measure, plan);
				// The same id again, also with another plan: the first one stands.
				const second = yield* Swarm.start(Measure, { ...plan, jobs: jobsOf(["zzz"]), cap: 9 });
				const result = yield* Swarm.result(Measure, "once");
				const third = yield* Swarm.start(Measure, plan);
				return { first, second, third, result, tasks: yield* coordinators, stored: (yield* conversations).length };
			}),
			counts,
		);
		expect(seen.first.created).toBe(true);
		expect(seen.second).toEqual({ ...seen.first, created: false });
		expect(seen.third).toEqual({ ...seen.first, created: false });
		expect(seen.tasks).toEqual([seen.first.taskId]);
		expect(seen.result.jobs).toEqual(["a", "bb", "ccc"].map(success));
		// The root and one fork per job of the first plan.
		expect(seen.stored).toBe(4);
		expect([...counts.requests]).toEqual([
			["a", 1],
			["bb", 1],
			["ccc", 1],
		]);
	});

	it("refuses an id that a swarm of another definition holds", async () => {
		const Other = Swarm.make({
			name: "other",
			input: Schema.Struct({ word: Schema.String }),
			result: Schema.String,
			prompt: ({ word }) => word,
		});
		const error = await play(
			Effect.gen(function* () {
				const root = yield* primed(1);
				const plan = { id: "held", source: root.id, jobs: jobsOf(["a"]), cap: 1, onFailure: "collect" as const };
				yield* Swarm.start(Measure, plan);
				return yield* Effect.flip(Swarm.start(Other, plan));
			}),
		);
		expect(error).toEqual(new Swarm.SwarmIdTaken({ swarmId: "held", heldBy: "measure" }));
	});

	it("refuses a plan it cannot run, and stores nothing of it", async () => {
		const seen = await play(
			Effect.gen(function* () {
				const root = yield* primed(1);
				const plan = {
					id: "bad",
					source: root.id,
					jobs: jobsOf(["a", "b"]),
					cap: 2,
					onFailure: "collect" as const,
				};
				const refusal = (change: Partial<typeof plan> & Pick<Swarm.Plan<unknown>, "pins" | "agent">) =>
					Effect.map(Effect.flip(Swarm.start(Measure, { ...plan, ...change })), (error) =>
						error._tag === "InvalidPlan" ? error.reason : error._tag,
					);
				return {
					noId: yield* refusal({ id: "" }),
					noCap: yield* refusal({ cap: 0 }),
					halfCap: yield* refusal({ cap: 1.5 }),
					twice: yield* refusal({ jobs: jobsOf(["a", "a"]) }),
					noKey: yield* refusal({ jobs: [{ key: "", input: { word: "a" } }] }),
					strayPin: yield* refusal({ pins: ["job-z"] }),
					noSource: yield* refusal({ source: 999 as never }),
					// Pi's `configure` would refuse it in every fork's creating commit.
					noTurns: yield* refusal({ agent: { maxTurns: 0 } }),
					status: yield* Effect.flip(Swarm.status("bad")),
					tasks: yield* coordinators,
				};
			}),
		);
		expect(seen).toEqual({
			noId: "The swarm id is empty",
			noCap: "The cap 0 is not an integer of 1 or more",
			halfCap: "The cap 1.5 is not an integer of 1 or more",
			twice: "Two jobs have the same key",
			noKey: "A job key is empty",
			strayPin: "The pin job-z names no job",
			noSource: "No conversation 999",
			noTurns: expect.stringMatching(/^The agent change of the forks: /),
			status: new Swarm.SwarmNotFound({ swarmId: "bad" }),
			tasks: [],
		});
	});
});

describe("an id nothing was started under", () => {
	it("fails every operation with SwarmNotFound", async () => {
		const errors = await play(
			Effect.all([
				Effect.flip(Swarm.status("none")),
				Effect.flip(Swarm.cancel("none")),
				Effect.flip(Swarm.result(Measure, "none")),
				Effect.flip(Swarm.destroyFork("none", "job-a")),
			]),
		);
		expect(errors).toEqual(errors.map(() => new Swarm.SwarmNotFound({ swarmId: "none" })));
	});
});

describe("result", () => {
	it("is typed and in job order, and is the coordinator task's own result", async () => {
		const seen = await play(
			Effect.gen(function* () {
				const root = yield* primed(1);
				const started = yield* Swarm.start(Measure, {
					id: "typed",
					source: root.id,
					jobs: jobsOf(["ccc", "a", "bb"]),
					cap: 3,
					onFailure: "collect",
				});
				const result = yield* Swarm.result(Measure, "typed");
				const settled = yield* Harness.waitForTaskOf(Measure.task, started.taskId);
				const stored = settled.state.outcome.status === "completed" ? settled.state.outcome.result : undefined;
				return {
					result,
					stored,
					fromTask: yield* Swarm.typed(Measure.work, Option.getOrThrow(Option.fromUndefinedOr(stored))),
				};
			}),
		);
		expect(seen.result.jobs).toEqual(["ccc", "a", "bb"].map(success));
		// The values are typed: a number can be added up without a cast.
		const total = seen.result.jobs.reduce((sum, job) => sum + (job._tag === "Success" ? job.value.length : 0), 0);
		expect(total).toBe(6);
		expect(seen.fromTask).toEqual(seen.result);
		expect(seen.stored?.jobs[0]).toEqual({ _tag: "Success", key: "job-ccc", value: { word: "ccc", length: 3 } });
	});

	it("takes the corrected answer of a fork whose first answer was not the JSON asked for", async () => {
		const counts = asked();
		const result = await play(
			Effect.gen(function* () {
				const root = yield* primed(1);
				yield* Swarm.start(Measure, {
					id: "fix",
					source: root.id,
					jobs: jobsOf(["a", "bb"]),
					cap: 2,
					onFailure: "collect",
				});
				return yield* Swarm.result(Measure, "fix");
			}),
			counts,
			(word, attempt) => ({
				text: word === "bb" && attempt === 1 ? "Two letters, I think." : JSON.stringify(measured(word)),
				afterMillis: 1,
			}),
		);
		expect(result.jobs).toEqual(["a", "bb"].map(success));
		expect([...counts.requests]).toEqual([
			["a", 1],
			["bb", 2],
		]);
		expect(counts.all.at(-1)).toContain("Your last answer was not accepted");
	});
});

describe("status", () => {
	it("says whether the coordinator runs, where it stands, and the jobs it planned with their statuses", async () => {
		const seen = await play(
			Effect.gen(function* () {
				const root = yield* primed(1);
				const started = yield* Swarm.start(Measure, {
					id: "probe",
					source: root.id,
					jobs: jobsOf(["a", "hold1", "hold2", "d"]),
					cap: 2,
					onFailure: "collect",
				});
				yield* until(Effect.map(tally("probe"), (now) => now.succeeded === 1 && now.running === 2));
				const during = yield* Swarm.status("probe");
				yield* Swarm.cancel("probe");
				yield* Swarm.result(Measure, "probe");
				return { started, during, after: yield* Swarm.status("probe") };
			}),
			asked(),
			(word) => ({ text: JSON.stringify(measured(word)), afterMillis: word.startsWith("hold") ? Infinity : 1 }),
		);
		expect(seen.during).toEqual({
			swarmId: "probe",
			name: "measure",
			taskId: seen.started.taskId,
			running: true,
			phase: "run",
			jobs: [
				{ key: "job-a", status: "succeeded", reason: Option.none(), ran: ranOf(seen.during, 0) },
				{ key: "job-hold1", status: "running", reason: Option.none(), ran: ranOf(seen.during, 1) },
				{ key: "job-hold2", status: "running", reason: Option.none(), ran: ranOf(seen.during, 2) },
				{ key: "job-d", status: "planned", reason: Option.none(), ran: Option.none() },
			],
		});
		expect(seen.after).toMatchObject({ running: false, phase: "ended" });
		expect(seen.after.jobs.map((job) => [job.status, Option.getOrNull(job.reason)])).toEqual([
			["succeeded", null],
			["failed", "cancelled"],
			["failed", "cancelled"],
			["failed", "cancelled"],
		]);
	});
});

describe("cancel", () => {
	it("in the middle: live forks are cancelled, nothing new starts, cleanup runs, collected results are kept", async () => {
		const counts = asked();
		const seen = await play(
			Effect.gen(function* () {
				const root = yield* primed(1);
				yield* Swarm.start(Measure, {
					id: "stop",
					source: root.id,
					jobs: jobsOf(["a", "hold1", "hold2", "d", "e"]),
					cap: 2,
					onFailure: "collect",
				});
				yield* until(Effect.map(tally("stop"), (now) => now.succeeded === 1 && now.running === 2));
				const first = yield* Swarm.cancel("stop");
				const result = yield* Swarm.result(Measure, "stop");
				const again = yield* Swarm.cancel("stop");
				const driver = yield* Swarm.ForkDriver;
				yield* Harness.waitForIdle;
				return { first, again, result, listed: yield* driver.list("stop"), stored: (yield* conversations).length };
			}),
			counts,
			(word) => ({ text: JSON.stringify(measured(word)), afterMillis: word.startsWith("hold") ? Infinity : 1 }),
		);
		expect(seen.first).toBe("cancelling");
		expect(seen.again).toBe("ended");
		expect(seen.result.ending).toBe("cancelled");
		const cancelled = (word: string) => ({
			_tag: "Failure",
			key: `job-${word}`,
			reason: "cancelled",
			message: "The swarm was cancelled",
		});
		expect(seen.result.jobs).toEqual([
			success("a"),
			cancelled("hold1"),
			cancelled("hold2"),
			cancelled("d"),
			cancelled("e"),
		]);
		// Three forks were made, and all three were destroyed: the two planned jobs never got one.
		expect(seen.result.forks.map((fork) => [fork.jobKey, fork.fate])).toEqual([
			["job-a", "destroyed"],
			["job-hold1", "destroyed"],
			["job-hold2", "destroyed"],
		]);
		expect(seen.listed).toEqual([]);
		expect(seen.stored).toBe(4);
		// Nothing was asked after the cancel: `d` and `e` never reached the model.
		expect([...counts.requests.keys()]).toEqual(["a", "hold1", "hold2"]);
	});
});

describe("destroyFork", () => {
	it("releases a pinned fork later, once, and answers the same again", async () => {
		const seen = await play(
			Effect.gen(function* () {
				const root = yield* primed(1);
				yield* Swarm.start(Measure, {
					id: "keep",
					source: root.id,
					jobs: jobsOf(["a", "bb"]),
					cap: 2,
					onFailure: "collect",
					pins: ["job-bb"],
				});
				const result = yield* Swarm.result(Measure, "keep");
				const driver = yield* Swarm.ForkDriver;
				const kept = yield* driver.list("keep");
				// A pinned fork is a conversation the product goes on with.
				const pinned = Option.getOrThrow(yield* Harness.conversation(Number(kept[0].forkId) as never));
				const more = yield* pinned.prompt("Prime again");
				const released = yield* Swarm.destroyFork("keep", "job-bb");
				const again = yield* Swarm.destroyFork("keep", "job-bb");
				const unpinned = yield* Swarm.destroyFork("keep", "job-a");
				const own = yield* writtenBy(pinned);
				return {
					result,
					kept,
					more: more.status,
					released,
					again,
					unpinned,
					own,
					after: yield* driver.list("keep"),
				};
			}),
		);
		expect(seen.result.forks.map((fork) => [fork.jobKey, fork.fate])).toEqual([
			["job-a", "destroyed"],
			["job-bb", "pinned"],
		]);
		expect(seen.kept.map((fork) => fork.jobKey)).toEqual(["job-bb"]);
		expect(seen.more).toBe("done");
		// Pi cannot delete a conversation: the in-storage driver says what the fork's own entries weigh as JSON, the
		// job's and those of the work that went on in the pinned fork. The coordinator destroyed the other fork and
		// kept its number with the result, so a later call for it has nothing left to destroy.
		expect(seen.own).toBeGreaterThan(0);
		expect(seen.released).toEqual({ bytesWritten: Option.some(seen.own) });
		expect(seen.again).toEqual(seen.released);
		expect(Option.getOrThrow(seen.result.forks[0].bytesWritten)).toBeGreaterThan(0);
		expect(seen.unpinned).toEqual({ bytesWritten: Option.none() });
		expect(seen.after).toEqual([]);
	});

	it("answers the bytes a driver knows, and the same bytes again when the fork is long gone", async () => {
		const driver = fake({ bytes: () => Option.some(4096) });
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.root;
				yield* root.commit((tx) => tx.appendEntry(root.id, { kind: "test.primed" }));
				yield* Swarm.start(Measure, {
					id: "keep",
					source: root.id,
					jobs: jobsOf(["a"]),
					cap: 1,
					onFailure: "collect",
					pins: ["job-a"],
				});
				yield* Swarm.result(Measure, "keep");
				const released = yield* Swarm.destroyFork("keep", "job-a");
				return { released, again: yield* Swarm.destroyFork("keep", "job-a") };
			}).pipe(
				Effect.provide(
					TestHarness.layer({ extensions: [Swarm.extension([Measure])] }).pipe(Layer.provideMerge(driver.layer)),
				),
			),
		);
		expect(seen.released).toEqual({ bytesWritten: Option.some(4096) });
		expect(seen.again).toEqual(seen.released);
		expect(driver.destroyCalls.get("job-a")).toBe(1);
	});
});
