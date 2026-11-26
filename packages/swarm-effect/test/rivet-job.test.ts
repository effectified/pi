// A job in its fork actor, without an engine: a harness that stands for the copied storage, and the actor's identity
// with the fork input the driver gave. The actor is no fork of anything here, so its database is never read.

import { Conversation, Doc, Harness } from "@effectified/pi-durable";
import { TestHarness } from "@effectified/pi-durable/testing";
import { ActorInfo, ActorSql, type Identity } from "@effectified/pi-durable-rivet";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { describe, expect, it } from "vitest";
import type * as ForkSetup from "../src/fork-setup.ts";
import type { Assignment } from "../src/rivet/assignment.ts";
import * as Job from "../src/rivet/job.ts";
import { type Asked, asked, Granted, measured, model, primed, recordingSetup } from "./support.ts";

/** An actor forked with `forkInput`; an actor that is no fork has no fork chain, so its hygiene is not asked for. */
function actor(forkInput: Option.Option<Schema.Json>): Identity {
	return {
		actorId: "fork-1",
		name: "agent",
		key: ["primed", "swarm", "s", "k"],
		namespace: "default",
		forkChain: [],
		forkInput,
	};
}

/** An `ActorSql` that dies when it is used: the actor is no fork, so the job never reads its record. */
const noDatabase = Layer.effect(
	ActorSql,
	SqlClient.make({
		driver: "unread",
		acquirer: Effect.die(new Error("the database is not read in this test")),
		compiler: Statement.makeCompilerSqlite(),
		spanAttributes: [],
	}),
).pipe(Layer.provide(Reactivity.layer));

/**
 * Runs `program` on a harness whose model answers a measure after `afterMillis`, with `setup` as the product's fork
 * setup of the fork actor.
 */
const run = <A, E>(
	counts: Asked,
	afterMillis: number,
	program: Effect.Effect<A, E, TestHarness.Provided | ActorSql | ForkSetup.ForkSetup>,
	setup: ReturnType<typeof recordingSetup> = recordingSetup(),
): Promise<A> => {
	const respond = model(counts, (word) => ({ text: JSON.stringify(measured(word)), afterMillis }));
	const live = Layer.mergeAll(
		TestHarness.layer({ responses: Array.from({ length: 50 }, () => respond) }),
		noDatabase,
		setup.layer,
	);
	return Effect.runPromise(Effect.provide(program, live));
};

const request = { swarmId: "s", jobKey: "k", requestId: "s/k/0", prompt: "Measure the word alpha." };

describe("a job in its fork actor", () => {
	it("runs on the context as of the swarm's entry, in a conversation of its own, once per request id", async () => {
		const counts = asked();
		const setup = recordingSetup();
		const seen = await run(
			counts,
			2,
			Effect.gen(function* () {
				const root = yield* primed(2);
				const at = Option.getOrThrow(yield* root.head);
				// The storage was copied after the source went on: the copy is past the swarm's entry.
				yield* root.prompt("Prime 3", { requestId: "prime-3" });
				const assignment: Assignment = {
					_tag: "swarm.rivet.job",
					swarmId: "s",
					jobKey: "k",
					sourceConversationId: root.id,
					at,
					agent: null,
				};
				const forked = Effect.provideService(ActorInfo, actor(Option.some(assignment)));
				const before = yield* Job.status(request.requestId);
				const none = yield* Job.conversation;
				const accepted = yield* forked(Job.accept(request));
				// The driver asks again after a lost answer: nothing new starts.
				const again = yield* forked(Job.accept(request));
				const job = Option.getOrThrow(yield* Job.conversation);
				yield* job.waitForIdle;
				const granted = yield* Harness.snapshot(Granted, String(job.id));
				const answered = yield* Job.status(request.requestId);
				const conversations = yield* Harness.commit((tx) => tx.scanConversations({}, 100));
				const turns = yield* Stream.runCollect(root.entries({ order: "ascending" }));
				// Another job's request, and a request in an actor that was forked for nothing.
				const other = yield* Effect.flip(forked(Job.accept({ ...request, jobKey: "other" })));
				const plain = yield* Effect.flip(
					Effect.provideService(Job.accept(request), ActorInfo, actor(Option.none())),
				);
				return {
					accepted,
					again,
					granted,
					before,
					none: Option.isNone(none),
					answered,
					root: root.id,
					job: job.id,
					conversations: conversations.items.map((conversation) => [conversation.id, conversation.parent]),
					sourceTurns: turns.filter((entry) => entry.kind === "pi.user").length,
					other,
					plain,
					at,
				};
			}),
			setup,
		);
		expect(seen.before).toEqual({ _tag: "Unknown" });
		expect(seen.none).toBe(true);
		// Accepting answers the conversation the job runs in, which is what the driver reports as its place.
		expect([seen.accepted, seen.again]).toEqual([seen.job, seen.job]);
		// The product's fork setup ran inside this actor: once in the commit that created the job conversation, where
		// what it wrote exists with the conversation, and before each request that was handed over.
		const fork = { swarmId: "s", jobKey: "k", sourceConversationId: seen.root, conversationId: seen.job };
		expect(setup.recorded.created).toEqual([fork]);
		expect(seen.granted).toEqual(Option.some({ jobKey: "k" }));
		expect(setup.recorded.beforeStart).toEqual([fork, fork]);
		expect(seen.answered).toEqual({ _tag: "Answered", text: JSON.stringify(measured("alpha")) });
		// The job saw the two turns before the swarm's entry, not the third; it was asked of the model once.
		expect([counts.primed.get("alpha"), counts.requests.get("alpha")]).toEqual([2, 1]);
		// One conversation beside the source: a fork of it at the swarm's entry. The source is as it was.
		expect(seen.conversations).toEqual([
			[seen.root, undefined],
			[seen.job, { conversationId: seen.root, at: seen.at }],
		]);
		expect(seen.sourceTurns).toBe(3);
		expect(seen.other).toMatchObject({
			_tag: "SwarmJobRefused",
			what: "fork",
			reason: "This actor was not forked for job other of swarm s",
		});
		expect(seen.plain).toMatchObject({ _tag: "SwarmJobRefused", what: "fork" });
	});

	it("makes no job conversation when the product's `created` refuses the fork, and none of its work when `beforeStart` does", async () => {
		const counts = asked();
		const refusing = (setup: ReturnType<typeof recordingSetup>) =>
			run(
				counts,
				2,
				Effect.gen(function* () {
					const root = yield* primed(1);
					const assignment: Assignment = {
						_tag: "swarm.rivet.job",
						swarmId: "s",
						jobKey: "k",
						sourceConversationId: root.id,
						at: Option.getOrThrow(yield* root.head),
						agent: null,
					};
					const refused = yield* Effect.flip(
						Effect.provideService(Job.accept(request), ActorInfo, actor(Option.some(assignment))),
					);
					const conversations = yield* Harness.commit((tx) => tx.scanConversations({}, 100));
					return {
						refused,
						conversations: conversations.items.length,
						job: Option.isSome(yield* Job.conversation),
						status: yield* Job.status(request.requestId),
					};
				}),
				setup,
			);
		const reason = "The fork could not be set up: The job k has no allowance.";
		// Refused in the creating commit: the commit failed, so there is the source and nothing else.
		const uncreated = await refusing(recordingSetup({ created: () => true }));
		expect(uncreated.refused).toMatchObject({ _tag: "SwarmJobRefused", what: "fork", reason });
		expect([uncreated.conversations, uncreated.job]).toEqual([1, false]);
		// Refused before the start: the conversation exists, set up as far as `created` went, and holds no request.
		const unstarted = await refusing(recordingSetup({ beforeStart: () => true }));
		expect(unstarted.refused).toMatchObject({ _tag: "SwarmJobRefused", what: "fork", reason });
		expect([unstarted.conversations, unstarted.job]).toEqual([2, true]);
		expect(unstarted.status).toEqual({ _tag: "Unknown" });
		expect(counts.requests.has("alpha")).toBe(false);
	});

	it("refuses when the copied storage does not hold the conversation to start from", async () => {
		const refused = await run(
			asked(),
			2,
			Effect.gen(function* () {
				const root = yield* primed(1);
				const assignment: Assignment = {
					_tag: "swarm.rivet.job",
					swarmId: "s",
					jobKey: "k",
					sourceConversationId: Conversation.Id.make(root.id + 41),
					at: Option.getOrThrow(yield* root.head),
					agent: null,
				};
				return yield* Effect.flip(
					Effect.provideService(Job.accept(request), ActorInfo, actor(Option.some(assignment))),
				);
			}),
		);
		expect(refused).toMatchObject({ _tag: "SwarmJobRefused", what: "source" });
	});

	it("finds its job conversation in the record written when the conversation id was a plain number", async () => {
		// The record as the job wrote it before: the same kind and version, the id stored as a plain number.
		const Before = Doc.make({
			kind: "swarm.rivet.job",
			version: 1,
			scope: "session",
			schema: Schema.Struct({ conversationId: Schema.NullOr(Schema.Number) }),
			initial: () => ({ conversationId: null }),
			checkpointWhen: () => false,
		});
		const seen = await run(
			asked(),
			Infinity,
			Effect.gen(function* () {
				const root = yield* primed(1);
				yield* Harness.commit((tx) =>
					Effect.flatMap(tx.doc(Before), (job) => job.set({ conversationId: root.id })),
				);
				const found = yield* Job.conversation;
				return { root: root.id, found: Option.map(found, (conversation) => conversation.id) };
			}),
		);
		expect(seen.found).toEqual(Option.some(seen.root));
	});

	it("stops the job's work on a cancel, and forgets the job conversation on a copy", async () => {
		const seen = await run(
			asked(),
			Infinity,
			Effect.gen(function* () {
				const root = yield* primed(1);
				const assignment: Assignment = {
					_tag: "swarm.rivet.job",
					swarmId: "s",
					jobKey: "k",
					sourceConversationId: root.id,
					at: Option.getOrThrow(yield* root.head),
					agent: null,
				};
				const forked = Effect.provideService(ActorInfo, actor(Option.some(assignment)));
				// Nothing to stop, and nothing to forget: both do nothing.
				yield* Job.cancel;
				yield* Job.forget;
				yield* forked(Job.accept(request));
				const running = yield* Job.status(request.requestId);
				const first = Option.getOrThrow(yield* Job.conversation).id;
				yield* Job.cancel;
				const cancelled = yield* Job.status(request.requestId);
				// What the fork hygiene does in a copy of this storage: the copy's own job starts a conversation of its own.
				yield* Job.forget;
				const forgotten = yield* Job.status(request.requestId);
				const none = Option.isNone(yield* Job.conversation);
				yield* forked(Job.accept(request));
				const second = Option.getOrThrow(yield* Job.conversation).id;
				yield* Job.cancel;
				return { running, cancelled, forgotten, none, first, second };
			}),
		);
		expect(seen.running).toEqual({ _tag: "Running" });
		expect(seen.cancelled._tag).toBe("Unanswered");
		expect(seen.forgotten).toEqual({ _tag: "Unknown" });
		expect(seen.none).toBe(true);
		expect(seen.second).not.toBe(seen.first);
	});
});
