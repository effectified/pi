import { createHash } from "node:crypto";
import { runTest } from "@effectified/pi-ai/testing";
import { Gate, Harness, Hook } from "@effectified/pi-durable";
import { answer, ScriptedModels, toolCall } from "@effectified/pi-durable/testing";
import { Context, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { approve, Digest, decide, deny, type Policy, pending } from "../src/index.ts";
import { HOUR, parked, results, scene, shown, status, submit } from "./scene.ts";

/** The digest the package must give, computed without it. */
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const HI = sha256('{"text":"hi"}');

describe("a call that needs approval", () => {
	it("parks, shows the inbox one request with the call and its digest, and does not run the tool", async () => {
		const { written, published, layer } = scene();
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				yield* TestClock.setTime(1_000_000);
				const { root, submission } = yield* submit();
				const request = yield* parked(published);
				const task = (yield* Harness.inspect).tasks.find((task) => task.record.kind === "pi.tool");
				return { root: root.id, request, task, submission: (yield* submission.status).status };
			}).pipe(Effect.provide(layer), Effect.provide(TestClock.layer())),
		);
		expect(published).toEqual([
			{
				id: `${seen.task?.record.id}:0:${HI}`,
				conversation: seen.root,
				task: seen.task?.record.id,
				callId: "call-1",
				tool: "write",
				arguments: { text: "hi" },
				digest: HI,
				askedAt: 1_000_000,
				expiresAt: 1_000_000 + HOUR,
			},
		]);
		// The call holds no process: it sleeps on the request's id until the expiry.
		expect(seen.task?.state).toEqual({ kind: "sleeping", until: 1_000_000 + HOUR });
		expect(seen.task?.record.state).toMatchObject({
			status: "sleeping",
			signals: [{ signal: "approvals.decision", key: seen.request.id }],
		});
		expect(seen.submission).toBe("placed");
		expect(written).toEqual([]);
	});

	it("runs the tool once, with the approved arguments, when it is approved, and the run answers", async () => {
		const { written, published, layer } = scene();
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* submit();
				const request = yield* parked(published);
				const delivery = yield* decide(request, yield* approve(request, "ada"));
				const settled = yield* submission.wait;
				yield* root.waitForIdle;
				const requests = yield* ScriptedModels.use((models) => models.callCount);
				return { delivery, settled: settled.status, requests, results: (yield* results(root)).map(shown) };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen).toEqual({
			delivery: "delivered",
			settled: "done",
			requests: 2,
			results: [{ isError: false, text: "wrote hi" }],
		});
		expect(written).toEqual(["hi"]);
		expect(published).toHaveLength(1);
	});

	it("gives the model the note and never runs the tool when it is denied", async () => {
		const { written, published, layer } = scene();
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* submit();
				const request = yield* parked(published);
				const delivery = yield* decide(request, yield* deny(request, "ada", "Not on a Friday."));
				const settled = yield* submission.wait;
				yield* root.waitForIdle;
				return { delivery, settled: settled.status, results: (yield* results(root)).map(shown) };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen).toEqual({
			delivery: "delivered",
			settled: "done",
			results: [
				{
					isError: true,
					text: "<harness>\n[error] Tool call blocked: Approval denied: Not on a Friday.\n</harness>",
				},
			],
		});
		expect(written).toEqual([]);
	});

	it("says only that approval was denied when the denial has no note", async () => {
		const { published, layer } = scene();
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* submit();
				const request = yield* parked(published);
				yield* decide(request, yield* deny(request, "ada"));
				yield* submission.wait;
				return shown((yield* results(root))[0]);
			}).pipe(Effect.provide(layer)),
		);
		expect(result?.text).toBe("<harness>\n[error] Tool call blocked: Approval denied\n</harness>");
	});

	it("expires on the TestClock without real waiting: the model is told, and the tool never runs", async () => {
		const { written, published, layer } = scene();
		const started = performance.now();
		const seen = await runTest(
			Effect.gen(function* () {
				yield* TestClock.setTime(1_000_000);
				const { root, submission } = yield* submit();
				const request = yield* parked(published);
				// One millisecond before the expiry nothing has moved.
				yield* TestClock.adjust(HOUR - 1);
				const early = { status: yield* status(request.task), pending: (yield* pending).length };
				yield* TestClock.adjust(1);
				const settled = yield* submission.wait;
				yield* root.waitForIdle;
				const late = yield* decide(request, yield* approve(request, "ada"));
				return { early, settled: settled.status, late, results: (yield* results(root)).map(shown) };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen).toEqual({
			early: { status: "sleeping", pending: 1 },
			settled: "done",
			late: "gone",
			results: [
				{
					isError: true,
					text: "<harness>\n[error] Tool call blocked: The approval request expired without a decision\n</harness>",
				},
			],
		});
		expect(written).toEqual([]);
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	it("is not released by a decision made for another digest", async () => {
		const { written, published, layer } = scene();
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { root } = yield* submit();
				const request = yield* parked(published);
				const other = yield* approve({ digest: Digest.Digest.make(sha256('{"text":"bye"}')) }, "ada");
				const error = yield* Effect.flip(decide(request, other));
				const after = { status: yield* status(request.task), pending: yield* pending };
				yield* root.abort();
				return { request, error, after };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen.error).toMatchObject({
			_tag: "DigestMismatch",
			request: seen.request.id,
			expected: HI,
			actual: sha256('{"text":"bye"}'),
		});
		expect(seen.after).toEqual({ status: "sleeping", pending: [seen.request] });
		expect(written).toEqual([]);
	});
});

describe("rewritten arguments", () => {
	it("ask again under a new request id, and never run on the approval of the old arguments", async () => {
		// A hook installed before the gate that changes its mind: from its second pass on it rewrites the text.
		let passes = 0;
		const Rewriter = Hook.beforeTool((call) =>
			Effect.sync(() => {
				passes += 1;
				return passes === 1 ? Gate.allow : Gate.rewrite({ text: `${String(call.arguments.text)}!` });
			}),
		);
		const { written, published, layer } = scene({ before: [Rewriter] });
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* submit();
				const first = yield* parked(published);
				// The person approves what they saw; the wake asks every hook again, and the arguments are other ones now.
				const approved = yield* decide(first, yield* approve(first, "ada"));
				const second = yield* parked(published, 2);
				const between = { written: [...written], pending: yield* pending, status: yield* status(first.task) };
				const stale = yield* decide(first, yield* approve(first, "ada"));
				const mixed = yield* Effect.flip(decide(second, yield* approve(first, "ada")));
				const delivered = yield* decide(second, yield* approve(second, "bob"));
				const settled = yield* submission.wait;
				yield* root.waitForIdle;
				return { first, second, approved, between, stale, mixed, delivered, settled: settled.status };
			}).pipe(Effect.provide(layer)),
		);
		const HI_BANG = sha256('{"text":"hi!"}');
		expect([seen.first.id, seen.second.id]).toEqual([
			`${seen.first.task}:0:${HI}`,
			`${seen.first.task}:1:${HI_BANG}`,
		]);
		expect(seen.second).toMatchObject({ arguments: { text: "hi!" }, digest: HI_BANG, callId: "call-1" });
		expect(seen.approved).toBe("delivered");
		// The approval of `hi` was stored and released nothing: the call waits for a decision about `hi!`.
		expect(seen.between).toEqual({ written: [], pending: [seen.second], status: "sleeping" });
		expect(seen.stale).toBe("superseded");
		expect(seen.mixed).toMatchObject({ _tag: "DigestMismatch", expected: HI_BANG, actual: HI });
		expect([seen.delivered, seen.settled]).toEqual(["delivered", "done"]);
		expect(written).toEqual(["hi!"]);
		expect(published).toEqual([seen.first, seen.second]);
	});
});

describe("the policy", () => {
	it("never asks about a tool it does not name", async () => {
		const { published, layer } = scene({
			responses: [toolCall("read", { path: "a.txt" }, { id: "call-1" }), answer("Done.")],
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* submit("Read a.txt.");
				const settled = yield* submission.wait;
				yield* root.waitForIdle;
				return { settled: settled.status, results: (yield* results(root)).map(shown), pending: yield* pending };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen).toEqual({ settled: "done", results: [{ isError: false, text: "read a.txt" }], pending: [] });
		expect(published).toEqual([]);
	});

	it("asks its rule about the other tools, with the call, and a rule's service comes from the registry's Layer", async () => {
		class Limits extends Context.Service<Limits, { readonly longest: number }>()("test/Limits") {}
		const calls: unknown[] = [];
		const policy: Policy<Limits> = {
			expiresAfter: "1 hour",
			rule: (call) =>
				Limits.use((limits) =>
					Effect.sync(() => {
						calls.push(call);
						return String(call.arguments.text).length > limits.longest;
					}),
				),
		};
		const { written, published, layer } = scene({
			policy,
			responses: [
				toolCall("write", { text: "hi" }, { id: "short" }),
				toolCall("write", { text: "a long text" }, { id: "long" }),
				answer("Done."),
			],
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { root } = yield* submit();
				const request = yield* parked(published);
				yield* root.abort();
				return { root: root.id, request };
			}).pipe(Effect.provide(layer), Effect.provide(Layer.succeed(Limits, { longest: 5 }))),
		);
		expect(calls).toEqual([
			{ tool: "write", arguments: { text: "hi" }, conversation: seen.root, callId: "short" },
			{ tool: "write", arguments: { text: "a long text" }, conversation: seen.root, callId: "long" },
		]);
		expect(written).toEqual(["hi"]);
		expect(published).toMatchObject([{ callId: "long", arguments: { text: "a long text" } }]);
	});

	it("asks its rule only until a call first needs approval: changed arguments ask again whatever it would say", async () => {
		let passes = 0;
		const Rewriter = Hook.beforeTool(() =>
			Effect.sync(() => {
				passes += 1;
				return passes === 1 ? Gate.allow : Gate.rewrite({ text: "harmless" });
			}),
		);
		const judged: unknown[] = [];
		const { written, published, layer } = scene({
			before: [Rewriter],
			policy: {
				expiresAfter: "1 hour",
				rule: (call) =>
					Effect.sync(() => {
						judged.push(call.arguments.text);
						return call.arguments.text === "hi";
					}),
			},
		});
		const second = await Effect.runPromise(
			Effect.gen(function* () {
				const { root } = yield* submit();
				const first = yield* parked(published);
				yield* decide(first, yield* approve(first, "ada"));
				const second = yield* parked(published, 2);
				yield* root.abort();
				return second;
			}).pipe(Effect.provide(layer)),
		);
		expect(judged).toEqual(["hi"]);
		expect(second).toMatchObject({ arguments: { text: "harmless" }, id: `${second.task}:1:${second.digest}` });
		expect(written).toEqual([]);
	});

	it("asks a person when its rule fails or dies", async () => {
		for (const rule of [() => Effect.fail("no answer"), () => Effect.die(new Error("broken rule"))]) {
			const { written, published, layer } = scene({ policy: { expiresAfter: "1 hour", rule } });
			const request = await Effect.runPromise(
				Effect.gen(function* () {
					const { root } = yield* submit();
					const request = yield* parked(published);
					yield* root.abort();
					return request;
				}).pipe(Effect.provide(layer)),
			);
			expect(request).toMatchObject({ tool: "write", arguments: { text: "hi" }, digest: HI });
			expect(written).toEqual([]);
		}
	});
});

describe("the inbox", () => {
	it("blocks the call when publishing dies, so the tool never runs unseen", async () => {
		const { written, published, layer } = scene({ publish: () => Effect.die(new Error("the inbox is down")) });
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* submit();
				const settled = yield* submission.wait;
				yield* root.waitForIdle;
				return { settled: settled.status, results: (yield* results(root)).map(shown), pending: yield* pending };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen).toEqual({
			settled: "done",
			results: [{ isError: true, text: "<harness>\n[error] Tool call blocked: the inbox is down\n</harness>" }],
			pending: [],
		});
		expect(published).toHaveLength(1);
		expect(written).toEqual([]);
	});
});
