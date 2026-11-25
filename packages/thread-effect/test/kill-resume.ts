// Test helper: the kill-and-resume suite of the composition, registered once per SQLite driver by a platform test file.
//
// One thread on a SQLite file: an input, a model turn that calls a tool, the tool, a model turn that answers, and the
// review of the answer. A first composition is closed while the thread stands at one point; a second one, opened on
// the same file with the same lease, sink, inbox and providers, takes it to its end. The points:
//
//   model      the author's first request is in flight
//   tool       the tool's handler runs
//   approval   the tool call is parked for a person's approval
//   review     the reviewer's request is in flight
//   deferred   the review is deferred: the lease was fenced when the reviewer was to be asked
//
// What the packages document for each, and this suite states as numbers:
//
// - A model request a close stopped is sent again on reopen (durable-effect README, "Interruption": "A model request
//   a close stopped is sent again"), and the budget settles the stopped one as aborted and reserves for the new one
//   (budget-effect README, "Guarantees and their limits"). So: one more provider request, one more reservation.
// - A `replay: "safe"` tool a close stopped runs again (durable-effect README, "Tool"). No model request is repeated.
// - A parked call survives a close and a reopen, and its request is published again with the same id
//   (approvals-effect README, "The request"). No model request is repeated.
// - A reviewer that had not answered is asked again (review-effect README, "Restarts": "A check that had not answered
//   runs again"). So: one more reviewer request, one more reservation.
// - A deferred review stays deferred across a close and a reopen, by the same task and with the same reason, and
//   nobody is asked again (review-effect README, "Restarts": "Deferred stays deferred"). The product renews its lease
//   and resumes, and the review is asked for once. So: no request and no reservation more, and the lease is not
//   asked while the thread waits.

import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import { createExpectAssertions, type StorageConformanceRunner } from "@earendil-works/pi-durable/testing";
import * as Approvals from "@gunta/pi-approvals-effect";
import { LeaseFenced } from "@gunta/pi-budget-effect";
import { Storage } from "@gunta/pi-durable-effect";
import { answer, toolCall } from "@gunta/pi-durable-effect/testing";
import { Effect, Fiber, Layer, Queue, Schedule } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { type Outcome, Threads } from "../src/index.ts";
import {
	advisory,
	committed,
	conflicts,
	type Outside,
	open,
	outside,
	type Providers,
	providers,
	reached,
	reservations,
	said,
	shape,
	told,
	work,
} from "./world.ts";

/** Opens the driver's client on a database file. */
export type ClientLayer = (filename: string) => Layer.Layer<SqlClient, SqlError>;

/** Runs `use` with the path of a database file that is removed afterwards. */
export type WithDatabaseFile = <A>(use: (filename: string) => Promise<A>) => Promise<A>;

/** Where the first composition is closed. */
type Point = "model" | "tool" | "approval" | "review" | "deferred";

/**
 * The thread: `lookup` calls a tool that runs at once, `transfer` one that waits for a person, and `unpaid` is the
 * `lookup` thread of a product that loses its lease while the author's answer is out, renews it once the thread
 * stopped, and resumes.
 */
type Flow = "lookup" | "transfer" | "unpaid";

const FLOWS: ReadonlyArray<Flow> = ["lookup", "transfer", "unpaid"];

/** The one tool each thread calls. */
const TOOL: Readonly<Record<Flow, "lookup" | "transfer">> = {
	lookup: "lookup",
	transfer: "transfer",
	unpaid: "lookup",
};

interface Case {
	readonly point: Point;
	readonly flow: Flow;
	/** What the close adds to an uninterrupted run, as the packages document it. */
	readonly more: {
		readonly author: number;
		readonly reviewer: number;
		readonly reservations: number;
		readonly tool: number;
	};
}

const CASES: ReadonlyArray<Case> = [
	{ point: "model", flow: "lookup", more: { author: 1, reviewer: 0, reservations: 1, tool: 0 } },
	{ point: "tool", flow: "lookup", more: { author: 0, reviewer: 0, reservations: 0, tool: 1 } },
	{ point: "approval", flow: "transfer", more: { author: 0, reviewer: 0, reservations: 0, tool: 0 } },
	{ point: "review", flow: "lookup", more: { author: 0, reviewer: 1, reservations: 1, tool: 0 } },
	{ point: "deferred", flow: "unpaid", more: { author: 0, reviewer: 0, reservations: 0, tool: 0 } },
];

/** Registers the suite for one driver. */
export function registerKillResume(
	runner: StorageConformanceRunner,
	driver: string,
	client: ClientLayer,
	withDatabaseFile: WithDatabaseFile,
): void {
	const { describe, it } = runner;
	const assert = createExpectAssertions(runner.expect);
	const play = (flow: Flow, point: Point | undefined) =>
		withDatabaseFile((filename) => scenario(client(filename), flow, point));

	describe(`kill and resume of the composition (${driver})`, () => {
		for (const flow of FLOWS) {
			it(`an uninterrupted ${flow} thread makes three provider requests and three reservations`, async () => {
				const whole = await play(flow, undefined);
				assert.strictEqual(whole.outcome._tag, "Reviewed");
				assert.deepEqual(whole.requests, { author: 2, reviewer: 1 });
				assert.deepEqual(whole.settlements, [["returned"], ["returned"], ["returned"]]);
				assert.deepEqual(whole.ran, { [TOOL[flow]]: 1 });
				assert.deepEqual(whole.conflicts, []);
				// The sink has the transcript and, after it, the verdict and the reviewer's request, each record once.
				assert.deepEqual(whole.records.at(-2)?.[1], { _tag: "Entry", kind: "review.verdict" });
				assert.partialDeepEqual(whole.records.at(-1)?.[1], { _tag: "ModelCall", provider: "reviewer-lab" });
				assert.strictEqual(whole.deliveries, whole.records.length);
				// The outcome sink was told that work started and what came of it, each event once.
				assert.deepEqual(
					whole.told.map(([, state]) => state),
					flow === "unpaid" ? ["Started", "BudgetStopped", "Reviewed"] : ["Started", "Reviewed"],
				);
				assert.strictEqual(whole.offered, whole.told.length);
			});
		}

		for (const { point, flow, more } of CASES) {
			it(`a close ${TITLES[point]} resumes to the same outcome, with every reservation settled once`, async () => {
				const whole = await play(flow, undefined);
				const resumed = await play(flow, point);
				// The same outcome: what stands, the counts, the verdict. The money is compared below.
				assert.deepEqual(comparable(resumed.outcome), comparable(whole.outcome));
				// The same records under the same ids, and no id delivered with two contents. Delivery is at least once:
				// a close may make a batch come again.
				assert.deepEqual(resumed.records, whole.records);
				assert.ok(resumed.deliveries >= resumed.records.length);
				assert.deepEqual(resumed.conflicts, []);
				// The same outcome events under the same ids, in the same order, and no id told with two contents: what
				// the closed composition had reached and not told, the one that reopened the storage told.
				assert.deepEqual(resumed.told, whole.told);
				assert.ok(resumed.offered >= resumed.told.length);
				assert.deepEqual(resumed.toldTwice, []);
				// The documented number of provider requests and of reservations, each settled exactly once.
				assert.deepEqual(resumed.requests, {
					author: whole.requests.author + more.author,
					reviewer: whole.requests.reviewer + more.reviewer,
				});
				assert.strictEqual(resumed.settlements.length, whole.settlements.length + more.reservations);
				assert.ok(resumed.settlements.every((settled) => settled.length === 1));
				assert.strictEqual(
					resumed.settlements.filter(([outcome]) => outcome === "aborted").length,
					more.reservations,
				);
				assert.deepEqual(resumed.ran, { [TOOL[flow]]: 1 + more.tool });
				// The thread's money is what the lease was told, to the micro unit.
				assert.strictEqual(resumed.outcome.counts.settledMicros, resumed.settled);
				assert.strictEqual(whole.outcome.counts.settledMicros, whole.settled);
			});
		}

		it("an outcome its sink refused is told when the storage is opened again, with nobody asking", async () => {
			const left = await withDatabaseFile(async (filename) => {
				const storage = Storage.sql().pipe(Layer.provide(client(filename)), Layer.orDie);
				const state = outside();
				const labs = scripted(state, "lookup", stopAt(state, undefined));
				// The next attempt of a refused event is an hour away: no retry comes in the time of the test.
				const options = { storage, outcomes: { retry: Schedule.spaced("1 hour") } };
				state.told.failing = 1;
				const first = await Effect.runPromise(
					Effect.gen(function* () {
						const outcome = yield* Threads.Threads.use((threads) => threads.work(INPUT.lookup));
						return { outcome, calls: state.told.calls, taken: state.told.events.length };
					}).pipe(Effect.scoped, Effect.provide(open(state, labs, options))),
				);
				// The second composition is only opened: no thread operation is called in it.
				const events = await Effect.runPromise(
					told(state, reached("Reviewed")).pipe(Effect.scoped, Effect.provide(open(state, labs, options))),
				);
				return { first, events, offered: state.told.offered };
			});
			// The thread ended in the first composition, whose sink had taken nothing.
			assert.strictEqual(left.first.outcome._tag, "Reviewed");
			assert.deepEqual([left.first.calls, left.first.taken], [1, 0]);
			// Opened again, it was told both events, the refused one as it was offered the first time.
			assert.deepEqual(left.events.map(said), ["Started", "Reviewed"]);
			assert.deepEqual(left.offered.slice(0, 2), [left.events[0], left.events[0]]);
			assert.partialDeepEqual(left.events[1], { _tag: "Reached", outcome: left.first.outcome });
		});

		it("a close while parked publishes the same request again, and one decision ends the wait", async () => {
			const resumed = await play("transfer", "approval");
			assert.ok(resumed.shown.length >= 2);
			assert.strictEqual(new Set(resumed.shown).size, 1);
		});

		it("a close while a review is deferred leaves it deferred, and nobody is asked until the lease is renewed", async () => {
			const whole = await play("unpaid", undefined);
			const resumed = await play("unpaid", "deferred");
			// `work` stopped once in the uninterrupted run, and once in each of the two processes of the closed one.
			assert.strictEqual(whole.stopped.length, 1);
			assert.strictEqual(resumed.stopped.length, 2);
			for (const stopped of [...whole.stopped, ...resumed.stopped]) {
				assert.partialDeepEqual(stopped, {
					_tag: "BudgetStopped",
					refusal: new LeaseFenced({ reason: "expired" }),
					counts: { turns: 2, toolCalls: 1, refusedToolCalls: 0 },
					review: { pass: 1, outcome: { _tag: "Deferred", attempt: 1 } },
				});
			}
			// The process that reopened the storage reads the stop the first one left, to the last field.
			assert.deepEqual(resumed.stopped[1], resumed.stopped[0]);
			// The lease was asked for the review twice, as in the uninterrupted run: once fenced, once renewed. The
			// reopen asked it nothing.
			const steps = ["reserve", "settle", "reserve", "settle", "fenced", "reserve", "settle"];
			assert.deepEqual(whole.lease, steps);
			assert.deepEqual(resumed.lease, steps);
		});
	});
}

const TITLES: Readonly<Record<Point, string>> = {
	model: "in the middle of a model request",
	tool: "in the middle of a tool call",
	approval: "while parked for approval",
	review: "in the middle of a review",
	deferred: "while a review is deferred",
};

/** What a scenario left behind. */
interface Left {
	readonly outcome: Outcome;
	/** The outcomes `work` gave an `unpaid` thread before its lease was renewed: one per composition that ran it. */
	readonly stopped: ReadonlyArray<Outcome>;
	/** Provider requests, over both compositions. */
	readonly requests: { readonly author: number; readonly reviewer: number };
	/** Per reservation, in order, the outcomes of its settlements. */
	readonly settlements: ReadonlyArray<ReadonlyArray<string>>;
	/** What the lease was asked, in order: a reservation, a refusal for a fenced lease, a settlement. */
	readonly lease: ReadonlyArray<string>;
	/** What the lease was told in all, in micro units. */
	readonly settled: bigint;
	/** The committed records, each id once: the id, and what the record says. */
	readonly records: ReadonlyArray<readonly [string, Record<string, unknown>]>;
	/** The committed records the sink took, repeats included. */
	readonly deliveries: number;
	/** The advisory records, each id once. */
	readonly advisories: number;
	readonly conflicts: ReadonlyArray<string>;
	readonly ran: Readonly<Record<string, number>>;
	/** The ids of the approval requests the inbox was shown. */
	readonly shown: ReadonlyArray<string>;
	/** The outcome events the sink took, each id once, in order: the id, and the state it tells. */
	readonly told: ReadonlyArray<readonly [string, string]>;
	/** How often the outcome sink was called. */
	readonly offered: number;
	/** The ids the outcome sink was offered with two contents: none is what the composition promises. */
	readonly toldTwice: ReadonlyArray<string>;
}

/**
 * An outcome without what a close may change: the money and the tokens of the reviewer's request, which depend on the
 * provider's prompt cache, and the times of the verdict and of the request.
 */
function comparable(outcome: Outcome): unknown {
	const { settledMicros: _settled, ...counts } = outcome.counts;
	// Every scenario ends reviewed, which the uninterrupted cases assert: any other outcome is compared whole.
	if (outcome._tag !== "Reviewed") return { ...outcome, counts };
	const { time: _time, call, ...verdict } = outcome.verdict;
	const { timestamp: _timestamp, durationMs: _duration, ...asked } = call ?? {};
	return { ...outcome, counts, verdict: { ...verdict, call: { ...asked, usage: call?.usage?.totalTokens } } };
}

const INPUT = {
	lookup: work("t1", "What is record 42 called?", ["lookup"]),
	transfer: work("t1", "Send bob 250.", ["transfer"]),
	unpaid: work("t1", "What is record 42 called?", ["lookup"]),
} as const;

/**
 * Runs the scenario on the database of `client`: with `point`, in two compositions on the same outside state, the
 * first closed at that point; without, in one.
 */
async function scenario(client: Layer.Layer<SqlClient, SqlError>, flow: Flow, point: Point | undefined): Promise<Left> {
	const storage = Storage.sql().pipe(Layer.provide(client), Layer.orDie);
	const state = outside();
	const stop = stopAt(state, point);
	const labs = scripted(state, flow, stop);
	const stopped: Array<Outcome> = [];
	if (point !== undefined) {
		await Effect.runPromise(
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				if (point === "deferred") {
					// The thread goes as far as it can by itself: its answer is there, and its review waits for a lease.
					stopped.push(yield* threads.work(INPUT[flow]));
					return;
				}
				yield* Effect.forkScoped(threads.work(INPUT[flow]));
				yield* point === "approval" ? Effect.asVoid(Queue.take(state.inbox)) : Effect.promise(() => stop.reached);
				// Leaving the scope closes the composition while the thread stands at `point`.
			}).pipe(Effect.scoped, Effect.provide(open(state, labs, { storage }))),
		);
	}
	stop.release();
	const outcome = await Effect.runPromise(
		Effect.gen(function* () {
			const threads = yield* Threads.Threads;
			// The same input finds the thread the first composition started.
			const working = yield* Effect.forkScoped(threads.work(INPUT[flow]));
			if (flow === "transfer") {
				const request = yield* Queue.take(state.inbox);
				yield* Approvals.decide(request, yield* Approvals.approve(request, "user:ada"));
			}
			const worked = yield* Fiber.join(working);
			if (flow === "unpaid") {
				// The product renews its lease and resumes at once, without waiting to be told of the stop: the deferred
				// review is asked for again, and the stop is told all the same, from its verdict.
				stopped.push(worked);
				state.lease.fenced = undefined;
			}
			const ended = flow === "unpaid" ? yield* threads.resume(INPUT[flow].thread) : worked;
			// Before the composition closes: the thread's courier tells of the end after the commit that ends it.
			yield* told(state, reached(ended._tag));
			return ended;
		}).pipe(Effect.scoped, Effect.provide(open(state, labs, { storage }))),
	);
	const once = new Map(state.told.events.map((event) => [event.id, said(event)] as const));
	const contents = new Map<string, Set<string>>();
	for (const event of state.told.offered) {
		contents.set(event.id, (contents.get(event.id) ?? new Set()).add(JSON.stringify(event, bigintsAsText)));
	}
	const reserved = reservations(state);
	return {
		outcome,
		stopped,
		requests: { author: labs.author.state.callCount, reviewer: labs.reviewer.state.callCount },
		settlements: reserved.map(({ settlements }) => settlements.map((settlement) => settlement.outcome)),
		lease: state.lease.steps.map((step) => step.step),
		settled: reserved
			.flatMap(({ settlements }) => settlements)
			.reduce((sum, settlement) => sum + settlement.cost, 0n),
		records: committed(state).map((record) => [record.id, shape(record)] as const),
		deliveries: state.delivered.flat().filter((record) => record._tag !== "ModelCallRequested").length,
		advisories: advisory(state).length,
		conflicts: conflicts(state),
		ran: { ...state.ran },
		shown: state.shown.map((request) => request.id),
		told: [...once],
		offered: state.told.calls,
		toldTwice: [...contents].flatMap(([id, seen]) => (seen.size > 1 ? [id] : [])),
	};
}

/** For `JSON.stringify`: an outcome's money is a bigint, which JSON has no form for. */
function bigintsAsText(_key: string, value: unknown): unknown {
	return typeof value === "bigint" ? value.toString() : value;
}

/** Where a scenario's first composition stops, and how the test learns that it got there. */
interface Stop {
	/** The point the thread is held at; undefined once released. */
	at: Point | undefined;
	readonly reached: Promise<void>;
	readonly arrived: () => void;
	/** Lets everything run: the second composition holds nothing. */
	readonly release: () => void;
}

function stopAt(state: Outside, point: Point | undefined): Stop {
	const reached = Promise.withResolvers<void>();
	const stop: Stop = {
		at: point,
		reached: reached.promise,
		arrived: () => reached.resolve(),
		release: () => {
			stop.at = undefined;
			state.held = undefined;
		},
	};
	if (point === "tool") state.held = { tool: "lookup", reached: stop.arrived };
	return stop;
}

/**
 * The providers of a scenario, shared by both compositions as a real provider is. Each answers from what it is shown,
 * so a request that is sent again gets the same turn; a held request answers when the closing harness aborts it. The
 * author of an `unpaid` thread fences the lease as it gives its answer, once: the reviewer's request finds it so.
 */
function scripted(state: Outside, flow: Flow, stop: Stop): Providers {
	const call =
		TOOL[flow] === "lookup"
			? toolCall("lookup", { id: "42" }, { id: "call-1" })
			: toolCall("transfer", { to: "bob", amount: 250 }, { id: "call-1" });
	const holding =
		(
			point: Point,
			turnOf: (context: Parameters<FauxResponseFactory>[0]) => ReturnType<typeof answer>,
		): FauxResponseFactory =>
		(context, options) => {
			const turn = turnOf(context);
			if (stop.at !== point || turn.stopReason !== (point === "model" ? "toolUse" : "stop")) return turn;
			stop.arrived();
			return new Promise((resolve) =>
				options?.signal?.addEventListener("abort", () => resolve(turn), { once: true }),
			);
		};
	let paid = flow !== "unpaid";
	const author = holding("model", (context) => {
		if (!context.messages.some((message) => message.role === "toolResult")) return call;
		if (!paid) {
			paid = true;
			state.lease.fenced = "expired";
		}
		return answer("It is done.");
	});
	const reviewer = holding("review", () => answer('{"findings":[]}'));
	return providers({
		author: Array.from({ length: 6 }, () => author),
		reviewer: Array.from({ length: 6 }, () => reviewer),
	});
}
