// The examples of README.md as tests. The quick start, from `Transfer` to `program`, and the code under each
// "README:" comment are the README's, line for line; only the imports differ (the README names the package, this
// file its sources).

import { Tool } from "@gunta/pi-durable-effect";
import { answer, TestHarness, toolCall } from "@gunta/pi-durable-effect/testing";
import { Context, Effect, Layer, Option, Queue, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import * as Approvals from "../src/index.ts";

const Transfer = Tool.make("transfer", {
	description: "Transfer money to someone.",
	parameters: Schema.Struct({ to: Schema.String, amount: Schema.Number }),
	success: Schema.String,
	handler: ({ to, amount }) => Effect.succeed(`sent ${amount} to ${to}`),
});

// The port: where your product shows a request to a person. Here, a queue the program below reads.
const shown = Effect.runSync(Queue.unbounded<Approvals.Request>());
const InboxLive = Layer.succeed(Approvals.Inbox, {
	publish: (request) => Effect.asVoid(Queue.offer(shown, request)),
});

const live = TestHarness.layer({
	extensions: [
		{ name: "app", tools: [Transfer] },
		// After every extension that blocks or rewrites tool calls.
		Approvals.extension({ tools: ["transfer"], expiresAfter: "1 day" }),
	],
	// No provider and no key: the model answers with these turns, in order.
	responses: [toolCall("transfer", { to: "bob", amount: 250 }), answer("Sent.")],
}).pipe(Layer.provide(InboxLive));

const program = Effect.gen(function* () {
	const root = yield* TestHarness.root;
	const submission = yield* root.submit({ type: "input", content: "Send bob 250." });
	// The call parks before it runs and holds no process. The inbox was shown what it would run with.
	const request = yield* Queue.take(shown);
	// Later, once your host has authenticated the person who decides:
	const delivery = yield* Approvals.decide(request, yield* Approvals.approve(request, "user:ada"));
	// The tool runs once, with exactly the arguments of the request, and the model answers.
	const settled = yield* submission.wait;
	yield* root.waitForIdle;
	// Who decided is kept with the tool's result.
	const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
	const records = yield* Effect.forEach(entries, Approvals.applied);
	return { request, delivery, settled: settled.status, record: records.find(Option.isSome) };
});

describe("the README", () => {
	it("quick start: the call parks, is approved, runs once, and the result says who approved it", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const told = yield* program;
				const entries = yield* Stream.runCollect((yield* TestHarness.root).entries({ order: "ascending" }));
				return { ...told, result: entries.find((entry) => entry.kind === "pi.tool-result")?.model?.[0] };
			}).pipe(Effect.provide(live)),
		);
		// The tool ran once, with the arguments of the request.
		expect(seen.result).toMatchObject({ isError: false, content: [{ type: "text", text: "sent 250 to bob" }] });
		expect(seen.request).toMatchObject({
			tool: "transfer",
			arguments: { amount: 250, to: "bob" },
			id: `${seen.request.task}:0:${seen.request.digest}`,
			expiresAt: seen.request.askedAt + 24 * 60 * 60 * 1000,
		});
		expect([seen.delivery, seen.settled]).toEqual(["delivered", "done"]);
		expect(seen.record).toEqual(
			Option.some({
				request: seen.request,
				outcome: { _tag: "Approved", digest: seen.request.digest, by: "user:ada", at: expect.any(Number) },
			}),
		);
	});

	it("policy: a rule is an Effect over the call, and what it needs is a requirement of the registry", async () => {
		// README: policy
		class Limits extends Context.Service<Limits, { readonly free: number }>()("app/Limits") {}

		const policy: Approvals.Policy<Limits> = {
			// Every call of these tools needs approval.
			tools: ["close_account"],
			// A call of any other tool needs it when this says so. A rule that fails means it does.
			rule: (call) =>
				Limits.use((limits) =>
					Effect.succeed(call.tool === "transfer" && Number(call.arguments.amount) > limits.free),
				),
			// How long a request stays open.
			expiresAfter: "1 day",
		};
		// A registry with `Approvals.extension(policy)` requires `Limits` and `Approvals.Inbox`.
		// README: end
		const inbox: Approvals.Request[] = [];
		const sent: string[] = [];
		const Counted = Tool.make("transfer", {
			description: "Transfer money to someone.",
			parameters: Schema.Struct({ to: Schema.String, amount: Schema.Number }),
			success: Schema.String,
			handler: ({ to, amount }) => Effect.sync(() => void sent.push(`${amount} to ${to}`)).pipe(Effect.as("sent")),
		});
		const layer = TestHarness.layer({
			extensions: [{ name: "app", tools: [Counted] }, Approvals.extension(policy)],
			responses: [
				toolCall("transfer", { to: "bob", amount: 10 }),
				toolCall("transfer", { to: "bob", amount: 250 }),
				answer("Sent."),
			],
		}).pipe(
			Layer.provide(
				Layer.succeed(Approvals.Inbox, { publish: (request) => Effect.sync(() => void inbox.push(request)) }),
			),
			Layer.provide(Layer.succeed(Limits, { free: 100 })),
		);
		const listed = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.submit({ type: "input", content: "Send bob 10, then 250." });
				while (inbox.length === 0) yield* Effect.sleep("1 millis");
				// README: pending
				// Every request a decision can still reach, read from the harness storage: the same after a restart.
				const open = yield* Approvals.pending;
				// README: end
				yield* root.abort();
				return open;
			}).pipe(Effect.provide(layer)),
		);
		expect(sent).toEqual(["10 to bob"]);
		expect(listed).toEqual(inbox);
		expect(listed).toMatchObject([{ tool: "transfer", arguments: { amount: 250, to: "bob" } }]);
	});

	it("deny: the model reads the note, and the tool never runs", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const submission = yield* root.submit({ type: "input", content: "Send bob 250." });
				const request = yield* Queue.take(shown);
				// README: deny
				const denial = yield* Approvals.deny(request, "user:bob", "Over this month's limit.");
				const delivery = yield* Approvals.decide(request, denial);
				// The tool never runs. The model reads: Tool call blocked: Approval denied: Over this month's limit.
				// README: end
				yield* submission.wait;
				yield* root.waitForIdle;
				const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
				const result = entries.find((entry) => entry.kind === "pi.tool-result")?.model?.[0];
				// README: late
				// A second decision changes nothing, and neither does one for a call that ended.
				const late = yield* Approvals.decide(request, yield* Approvals.approve(request, "user:ada")); // "gone"
				// README: end
				return { delivery, late, result };
			}).pipe(Effect.provide(live)),
		);
		expect([seen.delivery, seen.late]).toEqual(["delivered", "gone"]);
		expect(seen.result).toMatchObject({
			role: "toolResult",
			isError: true,
			content: [
				{
					type: "text",
					text: "<harness>\n[error] Tool call blocked: Approval denied: Over this month's limit.\n</harness>",
				},
			],
		});
	});

	it("digest: the same arguments have one digest, whatever order their keys are in", async () => {
		const digests = await Effect.runPromise(
			Effect.gen(function* () {
				// README: digest
				const digest = yield* Approvals.Digest.of({ to: "bob", amount: 250 });
				const same = yield* Approvals.Digest.of({ amount: 250, to: "bob" }); // equal to `digest`
				// README: end
				return { digest, same, canonical: Approvals.Digest.canonical({ to: "bob", amount: 250 }) };
			}),
		);
		expect(digests.same).toBe(digests.digest);
		expect(digests.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(digests.canonical).toBe('{"amount":250,"to":"bob"}');
	});
});
