// The fork setup port on the in-storage driver: the product is asked about every fork inside the commit that creates
// the fork's conversation, and the coordinator says where each job ran. The Rivet driver's side is in
// rivet-job.test.ts (in process) and rivet-suite.ts (on an engine).

import { Harness } from "@effectified/pi-durable";
import { TestHarness } from "@effectified/pi-durable/testing";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import * as Swarm from "../src/index.ts";
import { fake } from "./fake-driver.ts";
import {
	type Asked,
	asked,
	Granted,
	harness,
	jobsOf,
	Measure,
	measured,
	model,
	primed,
	recordingSetup,
} from "./support.ts";

type Setup = ReturnType<typeof recordingSetup>;

const play = <A, E>(
	setup: Setup,
	program: Effect.Effect<A, E, TestHarness.Provided | Swarm.ForkDriver>,
	counts: Asked = asked(),
): Promise<A> => Effect.runPromise(program.pipe(Effect.provide(harness(model(counts), { setup: setup.layer }))));

const conversations = Effect.map(
	Harness.commit((tx) => tx.scanConversations({}, 1000)),
	(page) => page.items.map((conversation) => conversation.id),
);

const plan = (id: string, source: Swarm.Plan<unknown>["source"], words: ReadonlyArray<string>) => ({
	id: Swarm.SwarmId.make(id),
	source,
	jobs: jobsOf(words),
	cap: 2,
	onFailure: "collect" as const,
});

describe("ForkSetup", () => {
	it("has an explicit setup that does nothing", async () => {
		const setup = await Effect.runPromise(
			Swarm.ForkSetup.ForkSetup.use((service) => Effect.succeed(service)).pipe(Effect.provide(Swarm.ForkSetup.none)),
		);
		const fork = { swarmId: "s", jobKey: "k", sourceConversationId: 1, conversationId: 2 } as Swarm.ForkSetup.Forked;
		expect(await Effect.runPromise(setup.beforeStart(fork))).toBeUndefined();
	});

	it("is asked once per fork in the commit that creates the fork's conversation, and the swarm says where each job ran", async () => {
		const setup = recordingSetup();
		const seen = await play(
			setup,
			Effect.gen(function* () {
				const root = yield* primed(1);
				const before = yield* conversations;
				yield* Swarm.start(Measure, plan("set-up", root.id, ["a", "bb", "ccc"]));
				const outcome = yield* Swarm.result(Measure, Swarm.SwarmId.make("set-up"));
				const status = yield* Swarm.status(Swarm.SwarmId.make("set-up"));
				const made = (yield* conversations).filter((id) => !before.includes(id));
				const granted = yield* Effect.forEach(made, (id) => Harness.snapshot(Granted, String(id)));
				return { root: root.id, outcome, status, made, granted };
			}),
		);
		expect(seen.outcome.jobs).toEqual(
			["a", "bb", "ccc"].map((word) => ({ _tag: "Success", key: `job-${word}`, value: measured(word) })),
		);
		// One fork conversation per job, each set up once, with the job it is for and the source it came from.
		const created = [...setup.recorded.created].sort((a, b) => a.jobKey.localeCompare(b.jobKey));
		expect(
			created.map(({ swarmId, jobKey, sourceConversationId }) => [swarmId, jobKey, sourceConversationId]),
		).toEqual([
			["set-up", "job-a", seen.root],
			["set-up", "job-bb", seen.root],
			["set-up", "job-ccc", seen.root],
		]);
		expect(created.map((fork) => fork.conversationId).sort()).toEqual([...seen.made].sort());
		// What the setup wrote through the creating commit exists for exactly these conversations.
		expect(seen.granted.map(Option.map(({ jobKey }) => jobKey)).sort()).toEqual(
			["job-a", "job-bb", "job-ccc"].map((key) => Option.some(key)),
		);
		// Every fork was told it starts, after its commit, before its job was asked of the model.
		expect(new Set(setup.recorded.beforeStart.map((fork) => fork.conversationId))).toEqual(new Set(seen.made));
		// The coordinator's state says where each job ran: the fork's conversation, in this storage, in no actor.
		const ran = created.map((fork) => Option.some({ conversationId: fork.conversationId, actorId: null }));
		expect(seen.status.jobs.map((job) => job.ran)).toEqual(ran);
		expect(seen.outcome.forks.map((fork) => [fork.jobKey, fork.ran])).toEqual(
			created.map((fork, index) => [fork.jobKey, ran[index]]),
		);
	});

	it("makes no fork for a job its `created` refuses: the job fails as gone with the reason, the others run", async () => {
		const setup = recordingSetup({ created: (jobKey) => jobKey === "job-bb" });
		const counts = asked();
		const seen = await play(
			setup,
			Effect.gen(function* () {
				const root = yield* primed(1);
				const before = yield* conversations;
				yield* Swarm.start(Measure, plan("refused", root.id, ["a", "bb", "ccc"]));
				const outcome = yield* Swarm.result(Measure, Swarm.SwarmId.make("refused"));
				return { outcome, made: (yield* conversations).length - before.length };
			}),
			counts,
		);
		expect(seen.outcome.ending).toBe("completed");
		expect(seen.outcome.jobs).toEqual([
			{ _tag: "Success", key: "job-a", value: measured("a") },
			{
				_tag: "Failure",
				key: "job-bb",
				reason: "gone",
				message:
					"The fork of job job-bb of swarm refused is gone: The fork could not be set up: The job job-bb has no allowance.",
			},
			{ _tag: "Success", key: "job-ccc", value: measured("ccc") },
		]);
		// The refused commit created nothing: two conversations, two forks, and no request for the refused job.
		expect(seen.made).toBe(2);
		expect(seen.outcome.forks.map((fork) => fork.jobKey)).toEqual(["job-a", "job-ccc"]);
		expect(counts.requests.has("bb")).toBe(false);
	});

	it("fails a job its `beforeStart` refuses without a request to the model, and destroys its fork with the others", async () => {
		const setup = recordingSetup({ beforeStart: (jobKey) => jobKey === "job-bb" });
		const counts = asked();
		const seen = await play(
			setup,
			Effect.gen(function* () {
				const root = yield* primed(1);
				yield* Swarm.start(Measure, plan("unstarted", root.id, ["a", "bb"]));
				const outcome = yield* Swarm.result(Measure, Swarm.SwarmId.make("unstarted"));
				return {
					outcome,
					left: yield* Swarm.ForkDriver.use((driver) => driver.list(Swarm.SwarmId.make("unstarted"))),
				};
			}),
			counts,
		);
		expect(seen.outcome.jobs[1]).toMatchObject({ _tag: "Failure", key: "job-bb", reason: "gone" });
		expect(counts.requests.has("bb")).toBe(false);
		// Its conversation was created, with what `created` wrote: clean-up finds it by the driver's list.
		expect(setup.recorded.created.map((fork) => fork.jobKey).sort()).toEqual(["job-a", "job-bb"]);
		expect(seen.outcome.forks.map((fork) => [fork.jobKey, fork.fate])).toEqual([
			["job-a", "destroyed"],
			["job-bb", "destroyed"],
		]);
		// Its job never ran anywhere.
		expect(seen.outcome.forks.map((fork) => Option.isSome(fork.ran))).toEqual([true, false]);
		expect(seen.left).toEqual([]);
	});

	it("is required whatever the driver, and left alone by a driver whose forks are in no harness of this process", async () => {
		const setup = recordingSetup();
		const remote = fake();
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.root;
				yield* root.commit((tx) => tx.appendEntry(root.id, { kind: "test.primed" }));
				yield* Swarm.start(Measure, plan("remote", root.id, ["a", "bb"]));
				return yield* Swarm.result(Measure, Swarm.SwarmId.make("remote"));
			}).pipe(
				Effect.provide(
					TestHarness.layer({ extensions: [Swarm.extension([Measure])] }).pipe(
						Layer.provideMerge(Layer.succeed(Swarm.ForkDriver, remote.driver)),
						Layer.provide(setup.layer),
					),
				),
			),
		);
		expect(outcome.jobs.map((job) => job._tag)).toEqual(["Success", "Success"]);
		// The fake stands for a host of its own: it has no commit of this harness to run the setup in.
		expect(setup.recorded).toEqual({ created: [], beforeStart: [] });
		expect(outcome.forks.map((fork) => Option.isSome(fork.ran))).toEqual([false, false]);
	});
});
