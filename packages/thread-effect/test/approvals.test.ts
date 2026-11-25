// Approvals in the composition: a call that needs a person parks, and the outcome and the records follow the decision.

import * as Approvals from "@gunta/pi-approvals-effect";
import { answer, toolCall } from "@gunta/pi-durable-effect/testing";
import { Effect, Fiber, Queue } from "effect";
import { describe, expect, it } from "vitest";
import { Threads } from "../src/index.ts";
import { committed, type Outside, outside, providers, run, shape, work } from "./world.ts";

/** A thread whose model asks for a transfer, worked until a person decided with `decide`. */
const play = (
	state: Outside,
	said: string,
	decide: (request: Approvals.Request) => Effect.Effect<Approvals.Decision>,
) => {
	const labs = providers({
		author: [toolCall("transfer", { to: "bob", amount: 250 }, { id: "call-1" }), answer(said)],
		reviewer: [answer('{"findings":[]}')],
	});
	return run(
		state,
		labs,
		Effect.gen(function* () {
			const threads = yield* Threads.Threads;
			const working = yield* Effect.forkScoped(threads.work(work("t1", "Send bob 250.", ["transfer"])));
			// The call parks before it runs. The thread has not ended: it is alive, and has no outcome yet.
			const request = yield* Queue.take(state.inbox);
			const parked = {
				probe: yield* threads.probe("t1"),
				outcome: yield* threads.outcome("t1"),
				pending: (yield* Approvals.pending).map((open) => open.id),
				ran: { ...state.ran },
			};
			const delivery = yield* Approvals.decide(request, yield* decide(request));
			const outcome = yield* Fiber.join(working);
			return { request, parked, delivery, outcome, pending: yield* Approvals.pending };
		}),
	);
};

describe("a tool that needs approval", () => {
	it("parks, runs once after a person approved it, and keeps who decided with its result", async () => {
		const state = outside();
		const result = await play(state, "Sent.", (request) => Approvals.approve(request, "user:ada"));
		expect(result.request).toMatchObject({
			tool: "transfer",
			callId: "call-1",
			arguments: { amount: 250, to: "bob" },
		});
		expect(result.parked).toMatchObject({ probe: { alive: true }, outcome: { _tag: "None" }, ran: {} });
		expect(result.parked.pending).toEqual([result.request.id]);
		expect(result.delivery).toBe("delivered");
		expect(result.pending).toEqual([]);
		expect(result.outcome).toMatchObject({
			_tag: "Reviewed",
			counts: { turns: 2, toolCalls: 1, refusedToolCalls: 0 },
		});
		expect(state.ran).toEqual({ transfer: 1 });
		const [called] = committed(state).flatMap((record) => (record._tag === "ToolCallResult" ? [record] : []));
		expect(shape(called)).toEqual({
			_tag: "ToolCallResult",
			name: "transfer",
			callId: "call-1",
			isError: false,
			codes: [],
			text: "Sent 250 to bob.",
		});
		// The decision travels to the sink in the result's details: the recorder needs no knowledge of approvals.
		expect(called?.details).toMatchObject({
			approvals: {
				request: { id: result.request.id, digest: result.request.digest },
				outcome: { _tag: "Approved", by: "user:ada", digest: result.request.digest },
			},
		});
	});

	it("never runs after a person denied it: the model is told, and the call is a tool call, not a refused one", async () => {
		const state = outside();
		const result = await play(state, "I was not allowed to send it.", (request) =>
			Approvals.deny(request, "user:bob", "Over this month's limit."),
		);
		expect(result.delivery).toBe("delivered");
		expect(state.ran).toEqual({});
		// A denial is a person's decision about a call the agent may make: the guard's count stays at zero.
		expect(result.outcome).toMatchObject({
			_tag: "Reviewed",
			counts: { turns: 2, toolCalls: 1, refusedToolCalls: 0 },
		});
		const [called] = committed(state).flatMap((record) => (record._tag === "ToolCallResult" ? [record] : []));
		expect(shape(called)).toEqual({
			_tag: "ToolCallResult",
			name: "transfer",
			callId: "call-1",
			isError: true,
			codes: ["blocked"],
			text: "<harness>\n[error] Tool call blocked: Approval denied: Over this month's limit.\n</harness>",
		});
		expect(called?.details).toMatchObject({
			approvals: { outcome: { _tag: "Denied", by: "user:bob", note: "Over this month's limit." } },
		});
	});
});
