// The guard in the composition: a tool outside the grant and a forbidden verb never run, and the refusals are
// published as they happen, kept in the results for good, counted from there and delivered to the sink.

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Extension, Tool, ToolName } from "@effectified/pi-durable";
import { answer, held, toolCall } from "@effectified/pi-durable/testing";
import { DeniedTool, Guard, Refused } from "@effectified/pi-guard";
import { Effect, Fiber, Layer, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { Composition, ThreadKey, Threads } from "../src/index.ts";
import { committed, config, outside, ports, providers, reservations, run, shape, work } from "./world.ts";

/** Runs `program` while it keeps the first `count` refusals the guard publishes. */
const withRefusals = <A, E, R>(count: number, program: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const refusals = yield* Effect.forkScoped(Stream.runCollect(Stream.take(Guard.refusals, count)));
		// The subscription is made when the fiber first runs.
		yield* Effect.sleep("1 millis");
		const result = yield* program;
		const published = yield* Fiber.join(refusals);
		return { result, refusals: published.map(({ tool, rule, conversationId }) => ({ tool, rule, conversationId })) };
	});

/** The guard's records in the tool results the sink took, in delivery order. */
const refusedBy = (state: Parameters<typeof committed>[0]) =>
	Effect.runSync(
		Effect.forEach(
			committed(state).flatMap((record) => (record._tag === "ToolCallResult" ? [record.details] : [])),
			Refused.fromDetails,
		),
	).flatMap(Option.toArray);

describe("the guard in the composition", () => {
	it("refuses a tool outside the grant and a forbidden verb: neither runs, both are recorded and counted", async () => {
		const state = outside();
		const labs = providers({
			author: [
				fauxAssistantMessage(
					[
						fauxToolCall("write_note", { text: "remember" }, { id: "call-1" }),
						fauxToolCall("delete_record", { id: "42" }, { id: "call-2" }),
					],
					{ stopReason: "toolUse" },
				),
				answer("I may do neither."),
			],
			reviewer: [answer('{"findings":[]}')],
		});
		const { result, refusals } = await run(
			state,
			labs,
			withRefusals(
				2,
				Effect.gen(function* () {
					const threads = yield* Threads.Threads;
					const outcome = yield* threads.work(work("t1", "Write a note and delete record 42.", ["lookup"]));
					return { outcome, conversation: (yield* threads.conversation(ThreadKey.make("t1"))).id };
				}),
			),
		);
		expect(result.outcome).toMatchObject({
			_tag: "Reviewed",
			counts: { turns: 2, toolCalls: 2, refusedToolCalls: 2 },
		});
		// No handler ran: `write_note` is registered and not granted, `delete_record` could never be registered.
		expect(state.ran).toEqual({});
		// The grant is Pi's own selection, so Pi refuses both before any hook is asked; the guard publishes them.
		expect(refusals).toEqual([
			{ tool: "write_note", rule: "unavailable", conversationId: result.conversation },
			{ tool: "delete_record", rule: "unavailable", conversationId: result.conversation },
		]);
		expect(
			committed(state)
				.map(shape)
				.filter((record) => record._tag === "ToolCallResult"),
		).toEqual([
			{
				_tag: "ToolCallResult",
				name: "write_note",
				callId: "call-1",
				isError: true,
				codes: ["tool_unavailable"],
				text: "<harness>\n[error] Tool write_note is not available\n</harness>",
			},
			{
				_tag: "ToolCallResult",
				name: "delete_record",
				callId: "call-2",
				isError: true,
				codes: ["tool_unavailable"],
				text: "<harness>\n[error] Tool delete_record is not available\n</harness>",
			},
		]);
		// The count is the guard's own record in each result, which the sink takes with it: the rule, never the
		// arguments.
		expect(refusedBy(state)).toEqual([{ rule: "unavailable" }, { rule: "unavailable" }]);
		// A refused call costs nothing by itself: the two requests of the author and the review are all there is.
		expect(reservations(state)).toHaveLength(3);
	});

	it("blocks a tool outside the grant in its own hook when Pi's selection was widened behind it", async () => {
		const state = outside();
		const first = held(toolCall("lookup", { id: "42" }, { id: "call-1" }));
		const labs = providers({
			author: [
				first.response,
				toolCall("write_note", { text: "remember" }, { id: "call-2" }),
				answer("I may not write notes."),
			],
			reviewer: [answer('{"findings":[]}')],
		});
		const { result, refusals } = await run(
			state,
			labs,
			withRefusals(
				1,
				Effect.gen(function* () {
					const threads = yield* Threads.Threads;
					const working = yield* Effect.forkScoped(threads.work(work("t1", "Write a note.", ["lookup"])));
					yield* first.requested;
					// Not through the guard: from the next request on Pi resolves the tool, and only the guard's hook
					// stands before it.
					yield* (yield* threads.conversation(ThreadKey.make("t1"))).configure({
						tools: [ToolName.make("lookup"), ToolName.make("write_note")],
					});
					yield* first.release;
					return yield* Fiber.join(working);
				}),
			),
		);
		expect(result).toMatchObject({ _tag: "Reviewed", counts: { turns: 3, toolCalls: 2, refusedToolCalls: 1 } });
		expect(state.ran).toEqual({ lookup: 1 });
		expect(refusals.map(({ tool, rule }) => [tool, rule])).toEqual([["write_note", "allow-list"]]);
		expect(
			committed(state)
				.map(shape)
				.filter((record) => record._tag === "ToolCallResult" && record.isError === true),
		).toEqual([
			{
				_tag: "ToolCallResult",
				name: "write_note",
				callId: "call-2",
				isError: true,
				codes: ["blocked"],
				text: "<harness>\n[error] Tool call blocked: Tool write_note is not available\n</harness>",
			},
		]);
		// The call that ran has no record; the blocked one says which rule blocked it.
		expect(refusedBy(state)).toEqual([{ rule: "allow-list" }]);
	});

	it("does not build a registry that holds a forbidden verb, so no harness opens", async () => {
		const state = outside();
		const labs = providers();
		const Sign = Tool.make("sign_document", {
			description: "Sign a document.",
			parameters: Schema.Struct({ id: Schema.String }),
			success: Schema.String,
			handler: () => Effect.succeed("signed"),
		});
		const product = config(state, labs);
		const refused = await Effect.runPromise(
			Layer.build(
				Composition.layer({ ...product, extensions: [Extension.make({ name: "office", tools: [Sign] })] }),
			).pipe(Effect.provide(ports(state)), Effect.scoped, Effect.flip),
		);
		expect(refused).toBeInstanceOf(DeniedTool);
		expect(refused).toMatchObject({ tool: "sign_document", extension: "office" });
	});
});
