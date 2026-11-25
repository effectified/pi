// A swarm in the composition, on the in-storage driver: typed results, forks that are granted and capped as they are
// created, what each job spent, the probe with its job keys, a cancel, and the destruction of a pinned fork.

import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Shares } from "@gunta/pi-budget-effect";
import { Harness } from "@gunta/pi-durable-effect";
import { answer, held } from "@gunta/pi-durable-effect/testing";
import { Conversations } from "@gunta/pi-guard-effect";
import * as Review from "@gunta/pi-review-effect";
import * as Swarm from "@gunta/pi-swarm-effect";
import { Effect, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { Swarms, ThreadNotFound, Threads } from "../src/index.ts";
import {
	Covers,
	committed,
	FORK,
	outside,
	providers,
	reached,
	reservations,
	run,
	said,
	shape,
	told,
	work,
} from "./world.ts";

/** The author answers each request by what it was asked: a primed thread, or a job about one topic. */
const scripted: FauxResponseFactory = (context) => {
	const asked = context.messages.findLast((message) => message.role === "user")?.content;
	const topic = /cover (\w+)\?/.exec(typeof asked === "string" ? asked : JSON.stringify(asked))?.[1];
	return answer(topic === undefined ? "I have read it." : JSON.stringify({ topic, covered: topic !== "Zig" }));
};

const JOBS = [
	{ key: "rust", input: { topic: "Rust" } },
	{ key: "go", input: { topic: "Go" } },
	{ key: "zig", input: { topic: "Zig" } },
];

describe("a swarm of a primed thread", () => {
	it("fans typed results in, in job order, and keeps only the pinned fork until it is destroyed", async () => {
		const state = outside();
		const labs = providers({
			author: Array.from({ length: 4 }, () => scripted),
			reviewer: [answer('{"findings":[]}')],
		});
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const swarms = yield* Swarms.Swarms;
				const primed = yield* threads.work(work("t1", "Read this record: ...", ["lookup"]));
				const plan = {
					id: "covers-1",
					thread: "t1",
					jobs: JOBS,
					cap: 2,
					onFailure: "collect",
					pins: ["rust"],
					// One tool the thread holds and one it does not: a fork never gets more than its thread has.
					fork: { tools: ["lookup", "write_note"], cap: FORK.cap },
				} as const;
				const started = yield* swarms.run(Covers, plan);
				// A second start is the same swarm: its plan and the allowance of its forks stand.
				const again = yield* swarms.run(Covers, { ...plan, fork: { tools: [], cap: 1n } });
				const during = yield* swarms.probe("covers-1");
				const outcome = yield* swarms.result(Covers, "covers-1");
				const after = yield* swarms.probe("covers-1");
				const kept = yield* Swarm.ForkDriver.use((driver) => driver.list("covers-1"));
				const destroyed = yield* swarms.destroyFork("covers-1", "rust");
				// What the storage says of each fork: its agent, its grant, its share and its review state.
				const forks = yield* Effect.forEach(outcome.forks, (fork) =>
					Effect.gen(function* () {
						// The in-storage driver's fork id is the fork's conversation id, which Pi brands in the type system only.
						const id = Number(fork.forkId) as ConversationId;
						const conversation = Option.getOrThrow(yield* Harness.conversation(id));
						const agent = yield* conversation.agent;
						const entries = yield* Stream.runCollect(conversation.entries({ order: "ascending" }));
						return {
							id,
							// What the fork appended itself, as the UTF-8 JSON of its entries.
							own: entries
								.filter((entry) => entry.conversationId === id)
								.reduce((bytes, entry) => bytes + new TextEncoder().encode(JSON.stringify(entry)).length, 0),
							ran: Option.getOrUndefined(fork.ran),
							tools: agent.tools.map((tool) => tool.name),
							reviewed: agent.extensions.some((extension) => extension.name === Review.NAME),
							grant: yield* Conversations.granted(id),
							share: Option.getOrThrow(yield* Shares.use((shares) => shares.get(id))),
							review: (yield* Review.state(conversation))._tag,
						};
					}),
				);
				return {
					primed,
					source: (yield* threads.conversation("t1")).id,
					started,
					again,
					during,
					outcome,
					after,
					kept: kept.map((fork) => fork.jobKey),
					destroyed,
					twice: yield* swarms.destroyFork("covers-1", "rust"),
					left: yield* Swarm.ForkDriver.use((driver) => driver.list("covers-1")),
					forks,
					spent: yield* swarms.spent("covers-1"),
					thread: yield* threads.outcome("t1"),
					// The swarm was started the moment the thread ended: its outcome was read for its sink a moment
					// later, without waiting for the swarm.
					events: yield* told(state, reached("Reviewed")),
				};
			}),
		);
		expect(result.started).toMatchObject({ swarmId: "covers-1", created: true });
		expect(result.again).toEqual({ ...result.started, created: false });
		expect(result.during).toEqual({ alive: true, jobKeys: ["rust", "go", "zig"] });
		expect(result.after).toEqual({ alive: false, jobKeys: ["rust", "go", "zig"] });
		expect(result.outcome.ending).toBe("completed");
		expect(result.outcome.jobs).toEqual([
			{ _tag: "Success", key: "rust", value: { topic: "Rust", covered: true } },
			{ _tag: "Success", key: "go", value: { topic: "Go", covered: true } },
			{ _tag: "Success", key: "zig", value: { topic: "Zig", covered: false } },
		]);
		expect(result.outcome.forks.map(({ jobKey, fate }) => [jobKey, fate])).toEqual([
			["rust", "pinned"],
			["go", "destroyed"],
			["zig", "destroyed"],
		]);
		expect(result.kept).toEqual(["rust"]);
		// The in-storage driver says what a fork's own entries weigh as JSON, and nothing of the primed thread's they
		// were forked with: Pi cannot delete a conversation, so nothing was freed. The same number twice.
		const [kept, ...cleaned] = result.forks.map((fork) => fork.own);
		expect(kept).toBeGreaterThan(0);
		expect(result.destroyed).toEqual({ bytesWritten: Option.some(kept) });
		expect(result.twice).toEqual(result.destroyed);
		expect(result.outcome.forks.map((fork) => fork.bytesWritten)).toEqual([
			Option.none(),
			...cleaned.map((own) => Option.some(own)),
		]);
		expect(result.left).toEqual([]);
		// A fork is no thread: the outcome sink was told of the primed thread, and of no job's conversation.
		expect(result.events.map((event) => [event.thread, said(event)])).toEqual([
			["t1", "Started"],
			["t1", "Reviewed"],
		]);
		expect(state.told.calls).toBe(2);
		// The forks answer once each, are not reviewed, and their records are in the sink under their own ids.
		expect([labs.author.state.callCount, labs.reviewer.state.callCount]).toEqual([4, 1]);
		expect(
			result.forks.map((fork) =>
				committed(state)
					.filter((record) => record.conversation === fork.id)
					.map((record) => shape(record)._tag),
			),
		).toEqual([
			["Message", "ModelCall", "Message"],
			["Message", "ModelCall", "Message"],
			["Message", "ModelCall", "Message"],
		]);
		// Every fork was set up in the commit that created it. Its grant is the allowance that stands, the first
		// one, narrowed to what its thread holds (`lookup`, and not `write_note`), with the thread's classification;
		// it leaves the review out; and the swarm says which conversation each job ran in.
		expect(
			result.forks.map(({ ran, tools, reviewed, grant, review }) => ({ ran, tools, reviewed, grant, review })),
		).toEqual(
			result.forks.map(({ id }) => ({
				ran: { conversationId: id, actorId: null },
				tools: ["lookup"],
				reviewed: false,
				grant: { tools: ["lookup"], classification: "internal" },
				review: "NotRequired",
			})),
		);
		// A fork draws on the lease under its own share: its request is attributed to its conversation.
		const reserved = reservations(state);
		const [rust, go, zig] = result.forks.map((fork) => fork.id);
		expect(
			reserved.map(({ request, settlements }) => [request.model, request.conversation, settlements.length]),
		).toEqual([
			["author", result.source, 1],
			["reviewer", result.source, 1],
			["author", rust, 1],
			["author", go, 1],
			["author", zig, 1],
		]);
		const spentBy = (conversation: number | undefined) =>
			reserved
				.filter(({ request }) => request.conversation === conversation)
				.reduce((sum, { settlements }) => sum + (settlements[0]?.cost ?? 0n), 0n);
		expect(result.forks.map((fork) => fork.share)).toEqual(
			result.forks.map(({ id }) => ({ conversation: id, cap: FORK.cap, settled: spentBy(id) })),
		);
		// The swarm's money is readable per job, in plan order, and to the micro unit.
		expect(result.spent).toEqual([
			{ key: "rust", settledMicros: Option.some(spentBy(rust)) },
			{ key: "go", settledMicros: Option.some(spentBy(go)) },
			{ key: "zig", settledMicros: Option.some(spentBy(zig)) },
		]);
		expect(result.spent.every((job) => Option.getOrThrow(job.settledMicros) > 0n)).toBe(true);
		// A thread's money includes the forks of the swarms run on it: the outcome read after the swarm is the
		// primed one with the three jobs added, and all of it is what the lease was told.
		expect(result.primed).toMatchObject({ _tag: "Reviewed", counts: { settledMicros: spentBy(result.source) } });
		const all = reserved.reduce((sum, { settlements }) => sum + (settlements[0]?.cost ?? 0n), 0n);
		expect(result.thread).toEqual(
			Option.some({ ...result.primed, counts: { ...result.primed.counts, settledMicros: all } }),
		);
		// The same sum as with forks that are actors (rivet-suite.ts): the thread's own, and each job's once. The
		// forks are conversations here, so their shares are counted where they are and not again as accounts.
		const jobs = result.spent.reduce((sum, job) => sum + Option.getOrThrow(job.settledMicros), 0n);
		expect(all).toBe(result.primed.counts.settledMicros + jobs);
	});

	it("stops a fork at its cap: its job fails, and what it settled is its own", async () => {
		const state = outside();
		const labs = providers({
			author: [
				scripted,
				// The job's first answer is no JSON: the correction the swarm asks for would be the fork's second request.
				answer("It covers Rust, I think."),
			],
			reviewer: [answer('{"findings":[]}')],
		});
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const swarms = yield* Swarms.Swarms;
				yield* threads.work(work("t1", "Read this record: ...", []));
				const [job] = JOBS;
				yield* swarms.run(Covers, {
					id: "covers-4",
					thread: "t1",
					jobs: [job],
					cap: 1,
					onFailure: "collect",
					fork: { tools: [], cap: 1n },
				});
				return {
					source: (yield* threads.conversation("t1")).id,
					outcome: yield* swarms.result(Covers, "covers-4"),
					spent: yield* swarms.spent("covers-4"),
				};
			}),
		);
		// The check is against settled amounts: the request that crosses the cap is served, the next one is refused.
		expect(result.outcome.jobs).toMatchObject([{ _tag: "Failure", key: "rust", reason: "unanswered" }]);
		expect(labs.author.state.callCount).toBe(2);
		const [fork] = reservations(state).filter(({ request }) => request.conversation !== result.source);
		expect(result.spent).toEqual([{ key: "rust", settledMicros: Option.some(fork?.settlements[0]?.cost ?? 0n) }]);
		expect((fork?.settlements[0]?.cost ?? 0n) > 1n).toBe(true);
		// The refused request is an error entry of the fork, with the budget's own sentence.
		const [refused] = committed(state).filter(
			(record) => record._tag === "ModelCall" && record.stopReason === "error" && record.provider === "router",
		);
		expect(refused).toMatchObject({
			conversation: fork?.request.conversation,
			error: expect.stringContaining("the conversation has used up its share"),
		});
	});

	it("forks nothing for a swarm nobody gave an allowance: every job fails, and no request is sent", async () => {
		const state = outside();
		const labs = providers({ author: [scripted], reviewer: [answer('{"findings":[]}')] });
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				yield* threads.work(work("t1", "Read this record: ...", []));
				const source = (yield* threads.conversation("t1")).id;
				// Started past the composition's service: the fork setup finds no allowance, and fails closed.
				yield* Swarm.start(Covers, { id: "covers-5", source, jobs: JOBS, cap: 2, onFailure: "collect" });
				const outcome = yield* Swarm.result(Covers, "covers-5");
				const owned = yield* Harness.commit((tx) => tx.scanConversations({ ownerConversationId: source }, 10));
				return { outcome, forks: owned.items.length };
			}),
		);
		expect(result.outcome.jobs.map((job) => [job.key, job._tag, job._tag === "Failure" ? job.reason : ""])).toEqual([
			["rust", "Failure", "gone"],
			["go", "Failure", "gone"],
			["zig", "Failure", "gone"],
		]);
		expect(result.outcome.jobs[0]).toMatchObject({ message: expect.stringContaining("has no allowance") });
		expect(result.forks).toBe(0);
		expect(labs.author.state.callCount).toBe(1);
	});

	it("is cancelled while its jobs work: nothing new starts, and every job says so", async () => {
		const state = outside();
		const stuck = [held(answer("never")), held(answer("never"))];
		const labs = providers({
			author: [scripted, ...stuck.map((turn) => turn.response)],
			reviewer: [answer('{"findings":[]}')],
		});
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const swarms = yield* Swarms.Swarms;
				yield* threads.work(work("t1", "Read this record: ...", []));
				yield* swarms.run(Covers, {
					id: "covers-2",
					thread: "t1",
					jobs: JOBS,
					cap: 2,
					onFailure: "collect",
					fork: FORK,
				});
				// Two forks work, under the cap; the third job has not started.
				yield* Effect.forEach(stuck, (turn) => turn.requested);
				const cancelling = yield* swarms.cancel("covers-2");
				const outcome = yield* swarms.result(Covers, "covers-2");
				return {
					cancelling,
					outcome,
					probe: yield* swarms.probe("covers-2"),
					again: yield* swarms.cancel("covers-2"),
					spent: yield* swarms.spent("covers-2"),
				};
			}),
		);
		expect(result.cancelling).toBe("cancelling");
		expect(result.outcome.ending).toBe("cancelled");
		expect(result.outcome.jobs.map((job) => [job.key, job._tag, job._tag === "Failure" ? job.reason : ""])).toEqual([
			["rust", "Failure", "cancelled"],
			["go", "Failure", "cancelled"],
			["zig", "Failure", "cancelled"],
		]);
		expect(result.outcome.forks.every((fork) => fork.fate === "destroyed")).toBe(true);
		expect(result.probe).toEqual({ alive: false, jobKeys: ["rust", "go", "zig"] });
		expect(result.again).toBe("ended");
		// The third job never reached a provider; the two requests in flight were aborted and settled.
		expect(labs.author.state.callCount).toBe(3);
		expect(reservations(state).map(({ settlements }) => settlements.map((settlement) => settlement.outcome))).toEqual(
			[["returned"], ["returned"], ["aborted"], ["aborted"]],
		);
		// The two forks that worked have a share with nothing settled; the job that never started has no fork.
		expect(result.spent).toEqual([
			{ key: "rust", settledMicros: Option.some(0n) },
			{ key: "go", settledMicros: Option.some(0n) },
			{ key: "zig", settledMicros: Option.none() },
		]);
	});

	it("reads a thread's money when one of its swarms was refused: an id without a swarm counts nothing", async () => {
		const state = outside();
		const labs = providers({ author: [scripted], reviewer: [answer('{"findings":[]}')] });
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const swarms = yield* Swarms.Swarms;
				const primed = yield* threads.work(work("t1", "Read this record: ...", []));
				// The thread keeps a swarm's id before the swarm is stored, and this one never is.
				const refused = yield* Effect.flip(
					swarms.run(Covers, {
						id: "covers-5",
						thread: "t1",
						jobs: [JOBS[0], JOBS[0]],
						cap: 1,
						onFailure: "fail",
						fork: FORK,
					}),
				);
				return { primed, refused: refused._tag, thread: yield* threads.outcome("t1") };
			}),
		);
		expect(result.refused).toBe("InvalidPlan");
		expect(result.thread).toEqual(Option.some(result.primed));
	});

	it("fails typed for a thread and a swarm that do not exist", async () => {
		const state = outside();
		const result = await run(
			state,
			providers(),
			Effect.gen(function* () {
				const swarms = yield* Swarms.Swarms;
				return {
					run: yield* Effect.flip(
						swarms.run(Covers, {
							id: "covers-3",
							thread: "nobody",
							jobs: JOBS,
							cap: 1,
							onFailure: "fail",
							fork: FORK,
						}),
					),
					probe: yield* Effect.flip(swarms.probe("covers-3")),
					cancel: yield* Effect.flip(swarms.cancel("covers-3")),
					spent: yield* Effect.flip(swarms.spent("covers-3")),
				};
			}),
		);
		expect(result.run).toEqual(new ThreadNotFound({ thread: "nobody" }));
		expect(result.probe).toEqual(new Swarm.SwarmNotFound({ swarmId: "covers-3" }));
		expect(result.cancel).toEqual(new Swarm.SwarmNotFound({ swarmId: "covers-3" }));
		expect(result.spent).toEqual(new Swarm.SwarmNotFound({ swarmId: "covers-3" }));
	});
});
