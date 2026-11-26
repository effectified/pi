// The outcome sink of a thread in one process: which events it is told, their ids and their order, the record sink
// before it, a sink that fails, and a product that asks instead.

import { Harness, Storage } from "@effectified/pi-durable";
import { answer, held, toolCall } from "@effectified/pi-durable/testing";
import { Effect, Fiber, Layer, Option, Schedule, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Composition, OutcomeCursor, OutcomeEvent, OutcomeSink, Threads } from "../src/index.ts";
import { committed, config, outside, ports, providers, reached, run, said, told, work } from "./world.ts";

const BLOCKING = answer('{"findings":[{"severity":"block","text":"Six times seven is 42.","location":"It is 41."}]}');
const CLEAN = answer('{"findings":[]}');

/** An id as its parts: the thread, then what the event rests on. */
const parts = (event: OutcomeEvent) => event.id.split(":");

describe("what the outcome sink is told of a thread", () => {
	it("is told that work started and then the outcome, each with an id of the submission and the entry it rests on", async () => {
		const state = outside();
		const labs = providers({
			author: [toolCall("lookup", { id: "42" }, { id: "call-1" }), answer("Record 42 is titled Answer.")],
			reviewer: [CLEAN],
		});
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const outcome = yield* threads.work(work("t1", "What is record 42 called?"));
				const events = yield* told(state, reached("Reviewed"));
				const conversation = yield* threads.conversation("t1");
				return { outcome, events, head: yield* conversation.head };
			}),
		);
		const [started, ended] = result.events;
		expect(result.events.map(said)).toEqual(["Started", "Reviewed"]);
		// Both name the submission by the request key its task was admitted under, the thread's own first one.
		expect(result.events.map(({ thread, key, attempt }) => ({ thread, key, attempt }))).toEqual([
			{ thread: "t1", key: "t1#0", attempt: 0 },
			{ thread: "t1", key: "t1#0", attempt: 0 },
		]);
		// `<thread>:<submission>:started`, then `<thread>:<submission>:<entry>:<state>` with the newest entry of the
		// thread's conversation, the verdict the outcome rests on.
		const submission = parts(started)[1];
		expect(parts(started)).toEqual(["t1", submission, "started"]);
		expect(Number(submission)).toBeGreaterThan(0);
		expect(parts(ended)).toEqual(["t1", submission, String(Option.getOrThrow(result.head)), "Reviewed"]);
		// The outcome is the one `work` gave, to the last field.
		expect(ended).toMatchObject({ _tag: "Reached", outcome: result.outcome });
		// An event is plain data: it crosses a boundary as JSON and comes back the same.
		const codec = Schema.toCodecJson(OutcomeEvent);
		for (const event of result.events) {
			const wire = JSON.parse(JSON.stringify(Schema.encodeSync(codec)(event)));
			expect(Schema.decodeUnknownSync(codec)(wire)).toEqual(event);
		}
	});

	it("has the records of the thread in the record sink before it is told the outcome", async () => {
		const state = outside();
		const labs = providers({
			author: [toolCall("lookup", { id: "42" }, { id: "call-1" }), answer("Record 42 is titled Answer.")],
			reviewer: [CLEAN],
		});
		await run(
			state,
			labs,
			Effect.gen(function* () {
				yield* Threads.Threads.use((threads) => threads.work(work("t1", "What is record 42 called?")));
				yield* told(state, reached("Reviewed"));
			}),
		);
		// When `Reviewed` came, the record sink had every record the thread ever got: the transcript, the verdict and
		// the reviewer's model call. Nothing came after it.
		const all = committed(state).map((record) => record.id);
		expect(all).toHaveLength(8);
		expect(state.told.recorded[1]?.filter((id) => all.includes(id))).toEqual(all);
		// `Started` came no later than the first record of the answer: it waits for no run.
		expect(state.told.recorded[0]?.length).toBeLessThan(all.length);
	});

	it("is told each state a held thread goes through: held, then what a person's decision made of it", async () => {
		const state = outside();
		const labs = providers({
			author: [answer("It is 41."), answer("It is 40."), answer("It is 39."), answer("It is 42.")],
			reviewer: [BLOCKING, BLOCKING, BLOCKING, CLEAN],
		});
		// The sink takes nothing while the thread works and a person decides: the courier tells of the thread only
		// after both holds were released, from the transcript and not from where the thread stands.
		state.told.failing = Number.POSITIVE_INFINITY;
		const events = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				yield* threads.work(work("t1", "What is six times seven?"));
				const correct = { _tag: "Correct", by: "user:ada", correction: "Multiply again." } as const;
				yield* threads.release("t1", correct);
				yield* threads.release("t1", correct);
				const before = state.told.events.length;
				state.told.failing = 0;
				return { before, events: yield* told(state, reached("Reviewed")) };
			}),
			{ outcomes: { retry: Schedule.spaced("5 millis") } },
		);
		expect(events.before).toBe(0);
		expect(events.events.map(said)).toEqual(["Started", "Held", "Held", "Reviewed"]);
		// One submission all along: a correction continues the run. Each hold rests on its own verdict, so the two have
		// different ids, and the outcome on the newest entry after them.
		const [, first, second, passed] = events.events.map(parts);
		expect(new Set(events.events.map((event) => parts(event)[1])).size).toBe(1);
		expect(Number(second?.[2])).toBeGreaterThan(Number(first?.[2]));
		expect(Number(passed?.[2])).toBeGreaterThan(Number(second?.[2]));
		expect(new Set(events.events.map((event) => event.id)).size).toBe(4);
		// Each hold is told with the verdict that held the answer, which names the submission it is about.
		const held = events.events.flatMap((event) =>
			event._tag === "Reached" && event.outcome._tag === "Held" ? [event.outcome.verdict] : [],
		);
		expect(held.map((verdict) => [verdict.pass, verdict.outcome._tag])).toEqual([
			[2, "Held"],
			[3, "Held"],
		]);
		expect(held.map((verdict) => verdict.inputs)).toEqual([[Number(first?.[1])], [Number(first?.[1])]]);
	});

	it("is told each deferral of a review that was asked for again at once, then the outcome", async () => {
		const state = outside();
		const labs = providers({
			author: [
				// The product loses its lease while the author's request is out: the reviewer's finds it fenced.
				() => {
					state.lease.fenced = "expired";
					return answer("It is 42.");
				},
			],
			reviewer: [CLEAN],
		});
		state.told.failing = Number.POSITIVE_INFINITY;
		const events = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				yield* threads.work(work("t1", "What is six times seven?"));
				// Asked again while the lease is still fenced: refused again. Then under a new lease: reviewed.
				yield* threads.resume("t1");
				state.lease.fenced = undefined;
				yield* threads.resume("t1");
				state.told.failing = 0;
				return yield* told(state, reached("Reviewed"));
			}),
			{ outcomes: { retry: Schedule.spaced("5 millis") } },
		);
		expect(events.map(said)).toEqual(["Started", "BudgetStopped", "BudgetStopped", "Reviewed"]);
		expect(
			events.flatMap((event) =>
				event._tag === "Reached" && event.outcome._tag === "BudgetStopped" ? [event.outcome.review?.outcome] : [],
			),
		).toMatchObject([
			{ _tag: "Deferred", attempt: 1 },
			{ _tag: "Deferred", attempt: 2 },
		]);
		expect(new Set(events.map((event) => event.id)).size).toBe(4);
	});

	it("is told of a stop the product took on before it was told, before the continuation", async () => {
		const state = outside();
		const labs = providers({
			author: [
				() => {
					state.lease.fenced = "expired";
					return toolCall("lookup", { id: "42" }, { id: "call-1" });
				},
				answer("Record 42 is titled Answer."),
			],
			reviewer: [CLEAN],
		});
		state.told.failing = Number.POSITIVE_INFINITY;
		const events = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				yield* threads.work(work("t1", "What is record 42 called?"));
				state.lease.fenced = undefined;
				yield* threads.resume("t1");
				state.told.failing = 0;
				return yield* told(state, reached("Reviewed"));
			}),
			{ outcomes: { retry: Schedule.spaced("5 millis") } },
		);
		expect(events.map((event) => [said(event), event.key, event.attempt])).toEqual([
			["Started", "t1#0", 0],
			["BudgetStopped", "t1#0", 0],
			["Started", "t1#1", 1],
			["Reviewed", "t1#1", 1],
		]);
	});

	it("is told of a stop by the budget, and of the continuation as a submission of its own", async () => {
		const state = outside();
		const labs = providers({
			author: [
				// The product loses its lease while the first request is out: the next one finds it fenced.
				() => {
					state.lease.fenced = "expired";
					return toolCall("lookup", { id: "42" }, { id: "call-1" });
				},
				answer("Record 42 is titled Answer."),
			],
			reviewer: [CLEAN],
		});
		const events = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				yield* threads.work(work("t1", "What is record 42 called?"));
				yield* told(state, reached("BudgetStopped"));
				state.lease.fenced = undefined;
				yield* threads.takeOn("t1", "job-2");
				return yield* told(state, reached("Reviewed"));
			}),
		);
		expect(events.map((event) => [said(event), event.key, event.attempt])).toEqual([
			["Started", "t1#0", 0],
			["BudgetStopped", "t1#0", 0],
			["Started", "job-2", 1],
			["Reviewed", "job-2", 1],
		]);
		// Two submissions, each named by its events.
		const submissions = events.map((event) => parts(event)[1]);
		expect(submissions[0]).toBe(submissions[1]);
		expect(submissions[2]).toBe(submissions[3]);
		expect(submissions[0]).not.toBe(submissions[2]);
	});

	it("is told of a cancelled thread, and of an answered one that asked for no review", async () => {
		const state = outside();
		const turn = held(answer("Never said."));
		const labs = providers({ author: [turn.response, answer("Hi.")] });
		const events = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const working = yield* Effect.forkScoped(threads.work(work("t1", "Say hi.")));
				yield* turn.requested;
				yield* threads.cancel("t1");
				yield* Fiber.join(working);
				yield* told(state, reached("Cancelled"));
				yield* threads.work({ ...work("t2", "Say hi."), review: false });
				return yield* told(state, reached("Answered"));
			}),
		);
		expect(events.map((event) => [event.thread, said(event)])).toEqual([
			["t1", "Started"],
			["t1", "Cancelled"],
			["t2", "Started"],
			["t2", "Answered"],
		]);
	});
});

describe("an outcome sink that fails", () => {
	it("is asked again on the product's schedule with the same event, and the thread does not wait for it", async () => {
		const state = outside();
		const labs = providers({ author: [answer("It is 42.")], reviewer: [CLEAN] });
		// The sink fails every call while the thread works, however long that takes on the machine of the run: a
		// count of failures would be used up on a slow one, and the sink would have taken an event by then.
		state.told.failing = Number.POSITIVE_INFINITY;
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				// The sink takes nothing yet: the thread works to its end all the same.
				const outcome = yield* threads.work(work("t1", "What is six times seven?"));
				const before = { taken: state.told.events.length, calls: state.told.calls };
				// From here on it fails three more calls, and takes what it is offered after them.
				state.told.failing = 3;
				return { outcome: outcome._tag, before, events: yield* told(state, reached("Reviewed")) };
			}),
			{ outcomes: { retry: Schedule.spaced("5 millis") } },
		);
		expect(result.outcome).toBe("Reviewed");
		expect(result.before.taken).toBe(0);
		expect(result.events.map(said)).toEqual(["Started", "Reviewed"]);
		// Every call during the work failed and three after it, then two were taken: an event is offered until it is
		// taken, and the next one only then.
		const [started, ended] = result.events.map((event) => event.id);
		const failed = result.before.calls + 3;
		expect(state.told.calls).toBe(failed + 2);
		expect(state.told.offered.map((event) => event.id)).toEqual([
			...Array.from({ length: failed + 1 }, () => started),
			ended,
		]);
		// An event that is offered again is the same value: the id, and the content under it.
		for (const event of result.events) {
			const copies = state.told.offered.filter((other) => other.id === event.id);
			expect(copies.length).toBeGreaterThan(0);
			for (const copy of copies) expect(copy).toEqual(event);
		}
	});

	it("is left alone once the product's schedule ends, until the thread moves again", async () => {
		const state = outside();
		const labs = providers({ author: [answer("It is 41."), answer("It is 42.")], reviewer: [BLOCKING, CLEAN] });
		state.told.failing = 2;
		const events = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				// `Started` fails twice and the schedule allows one retry: the courier sleeps until it is woken. The
				// thread's own change wakes it: the verdict of its first answer, then the end of its run.
				yield* threads.work(work("t1", "What is six times seven?"));
				return yield* told(state, reached("Reviewed"));
			}),
			{ outcomes: { retry: Schedule.recurs(1) } },
		);
		expect(events.map(said)).toEqual(["Started", "Reviewed"]);
	});
});

describe("a product that asks instead", () => {
	it("provides the sink that keeps nothing: the composition opens, and the thread works as before", async () => {
		const state = outside();
		const labs = providers({ author: [answer("It is 42.")], reviewer: [CLEAN] });
		const live = Composition.open(config(state, labs)).pipe(
			// Nearest wins: the sink that keeps nothing, before the one of the test's ports.
			Layer.provide(OutcomeSink.none),
			Layer.provide(Storage.memory),
			Layer.provide(ports(state)),
		);
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const outcome = yield* Threads.Threads.use((threads) =>
					threads.work(work("t1", "What is six times seven?")),
				);
				// The events are worked out and noted as delivered all the same, and the courier ends.
				let cursor = Option.getOrThrow(yield* Harness.snapshot(OutcomeCursor.Document, "t1"));
				while (cursor.courier !== null) {
					yield* Effect.sleep("1 millis");
					cursor = Option.getOrThrow(yield* Harness.snapshot(OutcomeCursor.Document, "t1"));
				}
				return { outcome: outcome._tag, cursor };
			}).pipe(Effect.provide(live)),
		);
		expect(result.outcome).toBe("Reviewed");
		expect(result.cursor).toMatchObject({ delivered: { state: "Reviewed" }, pending: null, waiting: null });
		expect(state.told.calls).toBe(0);
	});
});
