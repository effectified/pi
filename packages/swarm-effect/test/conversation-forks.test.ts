// The in-storage driver, operation by operation, on a harness with a scripted model.

import { runTest } from "@gunta/pi-ai-effect/testing";
import { Extension, Harness, Signal, Task } from "@gunta/pi-durable-effect";
import { answer, type FauxResponseFactory, ScriptedModels, TestHarness } from "@gunta/pi-durable-effect/testing";
import { Effect, Fiber, Latch, Layer, Option, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import * as Swarm from "../src/index.ts";
import { noSetup, until, writtenBy } from "./support.ts";

const Go = Signal.make("test.go", 1, Schema.Struct({}));

/** A task that only sleeps: what stands in for a coordinator, so forks have an owner and jobs a task to notify. */
const Owner = Task.make({
	name: "test.owner",
	version: 1,
	input: Schema.Struct({}),
	state: Schema.Union([
		Schema.Struct({ phase: Schema.Literal("hold") }),
		Schema.Struct({ phase: Schema.Literal("end") }),
	]),
	result: Schema.String,
	initial: () => ({ phase: "hold" as const }),
	phases: {
		hold: () => Effect.succeed(Task.sleep({ state: { phase: "end" as const }, signals: [Go.key("go")] })),
		end: () => Effect.succeed(Task.complete("done")),
	},
	abort: () => Effect.succeed(Task.aborted()),
});

/** Answers every request with `Answer to <the last user text>`, unless it is held. */
function echo(hold: (text: string) => boolean = () => false, held?: Latch.Latch): FauxResponseFactory {
	return (context, options) => {
		const last = context.messages.flatMap((message) => (message.role === "user" ? [message.content] : [])).at(-1);
		const text = typeof last === "string" ? last : "";
		if (!hold(text)) return answer(`Answer to ${text}`);
		held?.openUnsafe();
		return new Promise((resolve) => {
			options?.signal?.addEventListener("abort", () => resolve(answer("cut off")), { once: true });
		});
	};
}

function live(respond: FauxResponseFactory) {
	return Swarm.ConversationForks.attach.pipe(
		Layer.provideMerge(
			TestHarness.layer({
				extensions: [Extension.make({ name: "test", tasks: [Owner] })],
				responses: Array.from({ length: 50 }, () => respond),
			}),
		),
		Layer.provideMerge(Swarm.ConversationForks.layer),
	);
}

/** The root with two entries, an owner task, and what a fork request of the tests is made of. */
const scene = Effect.gen(function* () {
	const root = yield* TestHarness.root;
	const first = (yield* root.commit((tx) => tx.appendEntry(root.id, { kind: "test.first" }))).id;
	const second = (yield* root.commit((tx) => tx.appendEntry(root.id, { kind: "test.second" }))).id;
	const owner = yield* root.commit((tx) =>
		tx.createTask(Owner, {}, { ownership: { kind: "conversation" }, background: true }),
	);
	yield* Harness.resume;
	const request = (jobKey: string, at: number = second): Swarm.ForkRequest => ({
		swarmId: "s",
		jobKey,
		coordinatorTaskId: owner,
		sourceConversationId: root.id,
		at,
		agent: Option.none(),
		setup: noSetup,
	});
	return { root, first, second, owner, request, driver: yield* Swarm.ForkDriver };
});

const conversations = Effect.map(
	Harness.commit((tx) => tx.scanConversations({}, 100)),
	(page) => page.items,
);

const run = <A, E>(program: Effect.Effect<A, E, TestHarness.Provided | Swarm.ForkDriver>, respond = echo()) =>
	Effect.runPromise(program.pipe(Effect.provide(live(respond))));

describe("fork", () => {
	it("finds or creates by key: a second and a concurrent call give the same fork, and one conversation", async () => {
		const seen = await run(
			Effect.gen(function* () {
				const { driver, request, root, second, owner } = yield* scene;
				const first = yield* driver.fork(request("job-a"));
				const again = yield* driver.fork(request("job-a"));
				const racing = yield* Effect.all([driver.fork(request("job-b")), driver.fork(request("job-b"))], {
					concurrency: "unbounded",
				});
				return { first, again, racing, stored: yield* conversations, root: root.id, second, owner };
			}),
		);
		expect(seen.again).toEqual(seen.first);
		expect(seen.racing[1]).toEqual(seen.racing[0]);
		expect(seen.first).toEqual({ swarmId: "s", jobKey: "job-a", forkId: String(seen.stored[1].id) });
		// The root and one fork per key.
		expect(seen.stored).toHaveLength(3);
		expect(seen.stored[1]).toEqual({
			id: seen.stored[1].id,
			parent: { conversationId: seen.root, at: seen.second },
			// The coordinator's task owns its forks.
			owner: { conversationId: seen.root, taskId: seen.owner },
		});
	});

	it("gives a fork that sees the source's entries up to `at`, and none after", async () => {
		const kinds = await run(
			Effect.gen(function* () {
				const { driver, request, first } = yield* scene;
				const fork = yield* driver.fork(request("job-a", first));
				const conversation = Option.getOrThrow(yield* Harness.conversation(Number(fork.forkId) as never));
				return (yield* Stream.runCollect(conversation.entries({ order: "ascending" }))).map((entry) => entry.kind);
			}),
		);
		expect(kinds).toEqual(["test.first"]);
	});

	it("applies the agent change to the fork, over what the source had", async () => {
		const seen = await run(
			Effect.gen(function* () {
				const { driver, request, root } = yield* scene;
				const fork = yield* driver.fork({
					...request("job-a"),
					agent: Option.some({ instructions: "Be brief.", maxTurns: 2 }),
				});
				const conversation = Option.getOrThrow(yield* Harness.conversation(Number(fork.forkId) as never));
				const model = (yield* ScriptedModels).model;
				return { fork: yield* conversation.agent, source: yield* root.agent, model };
			}),
		);
		expect(seen.fork.instructions).toBe("Be brief.");
		expect(seen.fork.maxTurns).toBe(2);
		// What the change leaves alone is the source's.
		expect(seen.fork.model).toEqual({ provider: seen.model.provider, modelId: seen.model.id });
		expect(seen.source.instructions).toBeUndefined();
	});

	it("answers gone for a source that does not exist", async () => {
		const error = await run(
			Effect.gen(function* () {
				const { driver, request } = yield* scene;
				return yield* Effect.flip(driver.fork({ ...request("job-a"), sourceConversationId: 999 }));
			}),
		);
		expect(error).toEqual(
			new Swarm.ForkGone({
				what: "source",
				swarmId: "s",
				jobKey: "job-a",
				reason: "The conversation does not exist",
			}),
		);
	});
});

describe("run and job", () => {
	it("starts a job once per request id, answers Pi's settled signal, and reads the answer's text", async () => {
		const seen = await run(
			Effect.gen(function* () {
				const { driver, request, owner } = yield* scene;
				const fork = yield* driver.fork(request("job-a"));
				const unknown = yield* driver.job(fork, "r1");
				const job = { fork, requestId: "r1", prompt: "Say hello.", notify: { taskId: owner, key: "k1" } };
				const notice = yield* driver.run(job);
				const again = yield* driver.run(job);
				yield* until(Effect.map(driver.job(fork, "r1"), (status) => status._tag === "Answered"));
				const asked = yield* ScriptedModels.use((models) => models.callCount);
				// Pi delivered its signal to the notified task, under the key, in the commit that settled the job.
				const memos = Option.getOrThrow(yield* Harness.getTask(owner)).memos ?? {};
				return {
					forkId: fork.forkId,
					unknown,
					notice,
					again,
					answered: yield* driver.job(fork, "r1"),
					asked,
					memos: Object.keys(memos),
				};
			}),
		);
		expect(seen.unknown).toEqual({ _tag: "Unknown" });
		// Pi's own signal, and where the job runs: the fork's conversation, in the storage of the swarm itself.
		expect(seen.notice).toEqual({
			_tag: "Signal",
			signal: "pi.submission-settled",
			place: { conversationId: Number(seen.forkId), actorId: null },
		});
		expect(seen.again).toEqual(seen.notice);
		expect(seen.answered).toEqual({ _tag: "Answered", text: "Answer to Say hello." });
		expect(seen.asked).toBe(1);
		expect(seen.memos).toEqual(["pi.signal.pi.submission-settled/k1"]);
	});

	it("reads a job as running while its fork works, and as unanswered once the fork is cancelled", async () => {
		const held = Latch.makeUnsafe();
		const seen = await run(
			Effect.gen(function* () {
				const { driver, request, owner } = yield* scene;
				const fork = yield* driver.fork(request("job-a"));
				yield* driver.run({ fork, requestId: "r1", prompt: "Hold on.", notify: { taskId: owner, key: "k1" } });
				yield* held.await;
				const running = yield* driver.job(fork, "r1");
				yield* driver.cancel(fork);
				const cancelled = yield* driver.job(fork, "r1");
				// A fork that is idle is cancelled already.
				yield* driver.cancel(fork);
				return { running, cancelled };
			}),
			echo((text) => text === "Hold on.", held),
		);
		expect(seen.running).toEqual({ _tag: "Running" });
		expect(seen.cancelled).toEqual({ _tag: "Unanswered", reason: "aborted" });
	});
});

describe("destroy and list", () => {
	it("aborts the fork's work, marks it destroyed for good, and says what its own entries weigh: Pi cannot delete a conversation", async () => {
		const held = Latch.makeUnsafe();
		const seen = await run(
			Effect.gen(function* () {
				const { driver, request, owner } = yield* scene;
				const a = yield* driver.fork(request("job-a"));
				const b = yield* driver.fork(request("job-b"));
				yield* driver.run({ fork: a, requestId: "r1", prompt: "Hold on.", notify: { taskId: owner, key: "k1" } });
				yield* held.await;
				const listed = yield* driver.list("s");
				const destroyed = yield* driver.destroy(a);
				const again = yield* driver.destroy(a);
				const conversation = Option.getOrThrow(yield* Harness.conversation(Number(a.forkId) as never));
				// Its work was stopped: the wait returns.
				yield* conversation.waitForIdle;
				return {
					listed,
					destroyed,
					again,
					own: yield* writtenBy(conversation),
					inherited: (yield* Stream.runCollect(conversation.entries())).filter(
						(entry) => entry.conversationId !== conversation.id,
					).length,
					after: yield* driver.list("s"),
					fork: yield* Effect.flip(driver.fork(request("job-a"))),
					run: yield* Effect.flip(
						driver.run({ fork: a, requestId: "r2", prompt: "More.", notify: { taskId: owner, key: "k2" } }),
					),
					job: yield* Effect.flip(driver.job(a, "r1")),
					other: yield* driver.list("other"),
					stored: (yield* conversations).length,
					b,
				};
			}),
			echo((text) => text === "Hold on.", held),
		);
		expect(seen.listed.map((fork) => fork.jobKey)).toEqual(["job-a", "job-b"]);
		// The bytes of the fork's own entries, the job's message among them, and nothing of the two entries it was
		// forked with. The second call answers the number the first one stored.
		expect(seen.inherited).toBe(2);
		expect(seen.own).toBeGreaterThan(0);
		expect(seen.destroyed).toEqual({ bytesWritten: Option.some(seen.own) });
		expect(seen.again).toEqual(seen.destroyed);
		expect(seen.after).toEqual([seen.b]);
		const gone = new Swarm.ForkGone({ what: "fork", swarmId: "s", jobKey: "job-a", reason: "It was destroyed" });
		expect(seen.fork).toEqual(gone);
		expect(seen.run).toEqual(gone);
		expect(seen.job).toEqual(gone);
		expect(seen.other).toEqual([]);
		// The gap: the destroyed fork's conversation is still stored, and no second one was made for its key.
		expect(seen.stored).toBe(3);
	});

	it("destroys a fork it does not know as one that is gone already", async () => {
		const destroyed = await run(
			Effect.gen(function* () {
				const { driver } = yield* scene;
				return yield* driver.destroy({ swarmId: "s", jobKey: "never", forkId: "0" });
			}),
		);
		expect(destroyed).toEqual({ bytesWritten: Option.none() });
	});
});

describe("attach", () => {
	it("is what the driver waits for: without it no operation returns", async () => {
		const unattached = TestHarness.layer({ extensions: [] }).pipe(Layer.provideMerge(Swarm.ConversationForks.layer));
		const waited = await runTest(
			Effect.gen(function* () {
				const driver = yield* Swarm.ForkDriver;
				const listing = yield* Effect.forkChild(Effect.timeoutOption(driver.list("s"), "1 hour"), {
					startImmediately: true,
				});
				yield* TestClock.adjust("1 hour");
				return yield* Fiber.join(listing);
			}).pipe(Effect.provide(unattached)),
		);
		expect(waited).toEqual(Option.none());
		const listed = await run(Swarm.ForkDriver.use((driver) => Effect.timeoutOption(driver.list("s"), 1000)));
		expect(listed).toEqual(Option.some([]));
	});
});
