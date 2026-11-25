// The budget and the router in the composition: a lease fenced in the middle of a thread, a route that fails over and
// whose failed attempt is settled before the next route is tried, and the classification, regions and labels of a
// thread at the router.

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { LeaseFenced } from "@gunta/pi-budget-effect";
import { answer, toolCall } from "@gunta/pi-durable-effect/testing";
import type { RouteTable } from "@gunta/pi-router-effect";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { Routing, Session, Threads } from "../src/index.ts";
import {
	BACKUP,
	committed,
	expectedCost,
	JUDGE,
	outside,
	providers,
	ROUTES,
	reservations,
	routed,
	run,
	SUBAGENT,
	shape,
	WRITER,
	work,
} from "./world.ts";

describe("a lease fenced in the middle of a thread", () => {
	it("stops the thread with the lease's reason, retries nothing, and continues under a new lease to an answer", async () => {
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
			reviewer: [answer('{"findings":[]}')],
		});
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const stopped = yield* threads.work(work("t1", "What is record 42 called?"));
				const paused = {
					steps: state.lease.steps.map((step) => step.step),
					requests: [labs.author.state.callCount, labs.reviewer.state.callCount],
					probe: yield* threads.probe("t1"),
					// A resume while the lease is still fenced stops again, without a request.
					again: yield* threads.resume("t1"),
				};
				state.lease.fenced = undefined;
				return { stopped, paused, continued: yield* threads.resume("t1") };
			}),
		);
		const first = reservations(state)[0]?.settlements[0]?.cost ?? 0n;
		expect(result.stopped).toEqual({
			_tag: "BudgetStopped",
			refusal: new LeaseFenced({ reason: "expired" }),
			// The tool result is in the transcript: the stop loses nothing.
			counts: { turns: 1, toolCalls: 1, refusedToolCalls: 0, settledMicros: first },
		});
		// One request was sent and settled. The refused one was asked of the lease once: nothing retried it.
		expect(result.paused.steps).toEqual(["reserve", "settle", "fenced"]);
		expect(result.paused.requests).toEqual([1, 0]);
		expect(result.paused.probe).toEqual({ alive: false });
		expect(result.paused.again).toEqual(result.stopped);
		expect(state.lease.steps.map((step) => step.step)).toEqual([
			"reserve",
			"settle",
			"fenced",
			"fenced",
			"reserve",
			"settle",
			"reserve",
			"settle",
		]);
		expect(result.continued).toMatchObject({
			_tag: "Reviewed",
			counts: { turns: 2, toolCalls: 1, refusedToolCalls: 0 },
			verdict: { outcome: { _tag: "Passed" } },
		});
		// The tool ran once, and the answer follows its result: the continuation ran on the transcript as it was.
		expect(state.ran).toEqual({ lookup: 1 });
		expect([labs.author.state.callCount, labs.reviewer.state.callCount]).toEqual([2, 1]);
		expect(reservations(state).map(({ settlements }) => settlements.length)).toEqual([1, 1, 1]);
		// A refused request is an error entry of the transcript, so the sink has it as a failed model call. The last
		// one is the reviewer's request, from its verdict.
		expect(
			committed(state)
				.map(shape)
				.flatMap((record) => (record._tag === "ModelCall" ? [[record.provider, record.stopReason]] : [])),
		).toEqual([
			["author-lab", "toolUse"],
			["router", "error"],
			["router", "error"],
			["author-lab", "stop"],
			["reviewer-lab", "stop"],
		]);
	});
});

describe("a route that fails with a retryable error", () => {
	it("falls back to the next route, and the lease is told what both attempts cost: all the router priced", async () => {
		const state = outside();
		const labs = providers({
			// No content: a response that had output is never taken over by another route.
			author: [fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded" })],
			backup: [answer("It is 42.")],
			reviewer: [answer('{"findings":[]}')],
		});
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const outcome = yield* threads.work(work("t1", "What is six times seven?"));
				return {
					outcome,
					conversation: (yield* threads.conversation("t1")).id,
					events: [...(yield* routed(state, 3))],
					stored: yield* threads.outcome("t1"),
				};
			}),
		);
		expect(
			result.events.map(({ alias, route, attempt, outcome, fallback }) => [
				alias,
				route.provider,
				attempt,
				outcome,
				fallback,
			]),
		).toEqual([
			["author", WRITER.provider, 1, "failed", true],
			["author", BACKUP.provider, 2, "served", false],
			["reviewer", "reviewer-lab", 1, "served", false],
		]);
		expect([labs.author.state.callCount, labs.backup.state.callCount]).toEqual([1, 1]);
		const [failed] = result.events;
		const reserved = reservations(state);
		const requests = reserved.filter(({ request }) => request.key === undefined);
		const spends = reserved.filter(({ request }) => request.key !== undefined);
		// One request of the harness is one reservation, whichever route served it, settled at that route's price.
		expect(requests.map(({ request, settlements }) => [request.model, settlements.length])).toEqual([
			["author", 1],
			["reviewer", 1],
		]);
		const [served] = committed(state).flatMap((record) => (record._tag === "ModelCall" ? [record] : []));
		expect(shape(served)).toEqual({
			_tag: "ModelCall",
			provider: BACKUP.provider,
			model: BACKUP.modelId,
			stopReason: "stop",
			error: null,
		});
		const { input, output, cacheRead, cacheWrite } = served?.usage ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		};
		expect(requests[0]?.settlements[0]).toEqual({
			usage: { input, output, cacheRead, cacheWrite },
			cost: expectedCost(BACKUP, { input, output, cacheRead, cacheWrite }),
			outcome: "returned",
		});
		// The attempt the backup took over used tokens. It is a reservation of its own, of exactly its cost, under
		// the attempt's own name, of the route's model and for the thread's conversation, settled once as failed.
		expect((failed?.cost.micros ?? 0n) > 0n).toBe(true);
		expect(spends).toEqual([
			{
				token: expect.any(String),
				estimate: failed?.cost.micros,
				request: {
					kind: "chat",
					provider: WRITER.provider,
					model: WRITER.modelId,
					session: failed?.sessionId,
					conversation: result.conversation,
					requestKey: failed?.requestKey,
					key: `${failed?.requestId}#1`,
				},
				settlements: [
					{
						usage: failed?.usage,
						cost: expectedCost(WRITER, failed?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
						outcome: "failed",
					},
				],
			},
		]);
		// The router and the budget make one key of the request, each its own way: the request's reservation, its
		// route events and the charge of its failed attempt all have it.
		expect(failed?.requestKey).toMatch(/^[0-9a-f]{64}$/);
		expect(result.events[1]?.requestKey).toBe(failed?.requestKey);
		expect(requests[0]?.request.requestKey).toBe(failed?.requestKey);
		// What the lease was told is what the router priced, to the micro unit, and it is the thread's money: the
		// outcome `work` returned has all of it, and so has one read later.
		const told = reserved.reduce((sum, { settlements }) => sum + (settlements[0]?.cost ?? 0n), 0n);
		const priced = result.events.reduce((sum, event) => sum + event.cost.micros, 0n);
		expect(told).toBe(priced);
		expect(result.outcome).toMatchObject({
			_tag: "Reviewed",
			verdict: { author: { ...BACKUP, family: "alpha" } },
			counts: { turns: 1, settledMicros: told },
		});
		expect(result.stored).toEqual(Option.some(result.outcome));
	});

	it("tells the lease of the failed attempt inside its request, before the next route is tried", async () => {
		const state = outside();
		/** What the lease had been told when the backup route was asked. */
		let whenTakenOver: ReadonlyArray<string> = [];
		const labs = providers({
			author: [fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded" })],
			backup: [
				() => {
					whenTakenOver = state.lease.steps.map((step) => step.step);
					return answer("It is 42.");
				},
			],
			reviewer: [answer('{"findings":[]}')],
		});
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const returned = yield* threads.work(work("t1", "What is six times seven?"));
				// Read as the thread ends, with no wait: the router waited for the settlement itself.
				return {
					returned,
					steps: state.lease.steps.map((step) => [step.step, step.step === "fenced" ? "" : step.token]),
				};
			}),
		);
		// The order the packages document: `reserve` for the request, `reserve` and `settle` for the attempt another
		// route takes over, then that route is asked, then `settle` for the request; and the review after it.
		expect(whenTakenOver).toEqual(["reserve", "reserve", "settle"]);
		expect(result.steps).toEqual([
			["reserve", "r1"],
			["reserve", "r2"],
			["settle", "r2"],
			["settle", "r1"],
			["reserve", "r3"],
			["settle", "r3"],
		]);
		const [request, attempt, review] = reservations(state);
		expect([request?.request.key, review?.request.key]).toEqual([undefined, undefined]);
		expect(attempt?.request).toMatchObject({ provider: WRITER.provider, model: WRITER.modelId });
		expect(attempt?.request.key).toMatch(/#1$/);
		expect(attempt?.settlements.map((settlement) => settlement.outcome)).toEqual(["failed"]);
		// So the outcome `work` returned has the failed attempt: nothing is settled beside the request any more.
		const told = reservations(state).reduce((sum, { settlements }) => sum + (settlements[0]?.cost ?? 0n), 0n);
		expect(result.returned.counts.settledMicros).toBe(told);
		expect((attempt?.settlements[0]?.cost ?? 0n) > 0n).toBe(true);
	});

	it("tries no other route when the lease refuses the failed attempt: the request ends with it, settled on its own reservation", async () => {
		const state = outside();
		const labs = providers({
			author: [
				// The product loses its lease while the first route is out: the failed attempt cannot be recorded.
				() => {
					state.lease.fenced = "expired";
					return fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded" });
				},
			],
			backup: [answer("It is 42.")],
		});
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const outcome = yield* threads.work(work("t1", "What is six times seven?"));
				return { outcome, events: [...(yield* routed(state, 1))] };
			}),
		);
		// The attempt was not settled, so no route took it over: its event says so, and the backup was never asked.
		expect(result.events.map(({ route, outcome, fallback }) => [route.provider, outcome, fallback])).toEqual([
			[WRITER.provider, "failed", false],
		]);
		expect([labs.author.state.callCount, labs.backup.state.callCount]).toEqual([1, 0]);
		// The lease gave the request's reservation before it was fenced, so it is told what the provider billed after
		// all: the refused record, then the settlement of the request with the failed route's usage, at its price.
		expect(state.lease.steps.map((step) => step.step)).toEqual(["reserve", "fenced", "settle"]);
		const [request] = reservations(state);
		const [failed] = result.events;
		expect(request?.settlements).toEqual([{ usage: failed?.usage, cost: failed?.cost.micros, outcome: "failed" }]);
		expect((failed?.cost.micros ?? 0n) > 0n).toBe(true);
		// The run ends errored with the router's own sentence, in which no budget refusal is found.
		expect(result.outcome).toMatchObject({
			_tag: "Errored",
			reason: "model_error",
			counts: { turns: 0, settledMicros: failed?.cost.micros },
		});
	});
});

/** `ROUTES` with the author's two routes changed: the first by `first`, the backup by `second`. */
function routesWith(first: Partial<RouteTable["aliases"][number]["routes"][number]>, second = first): RouteTable {
	const [author, ...rest] = ROUTES.aliases;
	const [writer, backup] = author.routes;
	return {
		...ROUTES,
		aliases: [
			{
				...author,
				routes: [
					{ ...writer, ...first },
					{ ...backup, ...second },
				],
			},
			...rest,
		],
	};
}

/** The route that served each request, by alias. */
const servedBy = (events: ReadonlyArray<{ readonly alias: string; readonly route: { readonly provider: string } }>) =>
	events.map(({ alias, route }) => [alias, route.provider]);

describe("what a thread says of its routes", () => {
	it("is served by a route cleared for the classification of its grant, and by no other", async () => {
		// The author's first route may see public content only; its second one internal content too.
		const routes = routesWith({ ceiling: "public" }, {});
		const state = outside();
		const labs = providers({
			author: [answer("It is 42.")],
			backup: [answer("It is 42.")],
			reviewer: [answer('{"findings":[]}'), answer('{"findings":[]}')],
		});
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const open = yield* threads.work({
					...work("public", "What is six times seven?"),
					grant: { tools: [], classification: "public" },
				});
				const closed = yield* threads.work(work("internal", "What is six times seven?"));
				return { outcomes: [open._tag, closed._tag], events: [...(yield* routed(state, 4))] };
			}),
			{ routes },
		);
		expect(result.outcomes).toEqual(["Reviewed", "Reviewed"]);
		// Each thread's own classification reached the router, by the provider session of its requests: the public
		// thread took the first route, the internal one was kept from it. No attempt failed over.
		expect(servedBy(result.events)).toEqual([
			["author", WRITER.provider],
			["reviewer", JUDGE.provider],
			["author", BACKUP.provider],
			["reviewer", JUDGE.provider],
		]);
		expect(result.events.every((event) => event.outcome === "served")).toBe(true);
		expect([labs.author.state.callCount, labs.backup.state.callCount]).toEqual([1, 1]);
	});

	it("is served only from its regions and only by routes that carry its labels", async () => {
		// The first route is in another region and promises nothing; the backup and the reviewer do both.
		const [author, reviewer, clone] = routesWith(
			{ region: "us" },
			{ region: "eu", labels: ["no-retention"] },
		).aliases;
		const [judge] = reviewer.routes;
		const routes = {
			...ROUTES,
			aliases: [author, { ...reviewer, routes: [{ ...judge, region: "eu", labels: ["no-retention"] }] }, clone],
		};
		const state = outside();
		const labs = providers({ backup: [answer("It is 42.")], reviewer: [answer('{"findings":[]}')] });
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const outcome = yield* threads.work({
					...work("t1", "What is six times seven?"),
					routing: { regions: ["eu"], requires: ["no-retention"] },
				});
				return { outcome: outcome._tag, events: [...(yield* routed(state, 2))] };
			}),
			{ routes },
		);
		expect(result.outcome).toBe("Reviewed");
		expect(servedBy(result.events)).toEqual([
			["author", BACKUP.provider],
			["reviewer", JUDGE.provider],
		]);
		expect(labs.author.state.callCount).toBe(0);
	});

	it("is sent nowhere when no route may serve it: the run ends errored, and nothing is reserved on a provider", async () => {
		// Both of the author's routes may see public content only, and the thread holds internal content.
		const routes = routesWith({ ceiling: "public" });
		const state = outside();
		const labs = providers({ author: [answer("It is 42.")], backup: [answer("It is 42.")] });
		const outcome = await run(
			state,
			labs,
			Threads.Threads.use((threads) => threads.work(work("t1", "What is six times seven?"))),
			{ routes },
		);
		expect(outcome).toMatchObject({
			_tag: "Errored",
			reason: "model_error",
			counts: { turns: 0, settledMicros: 0n },
		});
		expect([labs.author.state.callCount, labs.backup.state.callCount]).toEqual([0, 0]);
		expect(state.routed).toEqual([]);
	});

	it("routes a subagent as its parent: the child holds its parent's classification and limits", async () => {
		const routes = routesWith({ ceiling: "public" }, {});
		const state = outside();
		const labs = providers({
			backup: [
				toolCall(SUBAGENT, { subagent: "researcher", task: "What is record 42 called?" }, { id: "call-1" }),
				answer("Record 42 is titled Answer."),
				answer("The researcher says: Answer."),
			],
			reviewer: [answer('{"findings":[]}')],
		});
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const outcome = yield* threads.work({
					...work("t1", "Ask the researcher.", [SUBAGENT]),
					routing: { regions: ["test"] },
				});
				const events = [...(yield* routed(state, 4))];
				const parent = (yield* threads.conversation("t1")).id;
				// Every request named a provider session the index knows: the parent's, or the child's.
				const conversations = yield* Effect.forEach(events, (event) =>
					Session.conversationOf(event.sessionId ?? ""),
				);
				const owners = [
					...new Set(conversations.map((found) => (found._tag === "Some" ? found.value : undefined))),
				];
				const [, child] = owners;
				return {
					outcome: outcome._tag,
					events,
					parent,
					owners,
					limits: child === undefined ? undefined : yield* Routing.of(child),
				};
			}),
			{ routes },
		);
		expect(result.outcome).toBe("Reviewed");
		expect(result.owners).toHaveLength(2);
		expect(result.owners[0]).toBe(result.parent);
		expect(result.limits).toEqual({ regions: ["test"] });
		// The child's request was kept from the public route as its parent's were.
		expect(servedBy(result.events)).toEqual([
			["author", BACKUP.provider],
			["author", BACKUP.provider],
			["author", BACKUP.provider],
			["reviewer", JUDGE.provider],
		]);
		expect(labs.author.state.callCount).toBe(0);
	});
});
