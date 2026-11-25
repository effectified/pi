import type { ConversationId } from "@earendil-works/pi-durable";
import { runTest } from "@gunta/pi-ai-effect/testing";
import { Harness } from "@gunta/pi-durable-effect";
import { answer, ScriptedModels } from "@gunta/pi-durable-effect/testing";
import { Effect, Option, Schema } from "effect";
import type { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { continueStopped, NoProviderSession, Shares, stopOf } from "../src/index.ts";
import {
	type Budgeted,
	budgetedHarness,
	root as rootConversation,
	type Step,
	TestLease,
	withEvents,
} from "./support.ts";

const run = <A, E>(body: Effect.Effect<A, E, Harness.Harness | Budgeted | TestClock.TestClock>) =>
	runTest(Effect.provide(body, budgetedHarness()));

/** A second conversation on the scripted model: what a subagent runs in. */
const child = ScriptedModels.use(({ model }) =>
	Harness.createConversation({
		ownership: { kind: "ownerless" },
		agent: { model: { provider: model.provider, modelId: model.id } },
	}),
);

describe("a conversation with a cap", () => {
	it("stops when it has settled its cap, with a reason of its own, while the root goes on", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				const shares = yield* Shares;
				yield* scripted.setResponses([answer("One."), answer("Two."), answer("Three."), answer("Four.")]);
				const root = yield* rootConversation;
				const sub = yield* child;
				expect(yield* shares.setCap(sub.id, 1n)).toEqual({ conversation: sub.id, cap: 1n, settled: 0n });

				// Under its cap the conversation is served, on the harness's lease, and its request names it.
				expect(yield* sub.prompt("First")).toMatchObject({ status: "done" });
				const [reserve, settle] = lease.steps;
				if (reserve?.step !== "reserve" || settle?.step !== "settle") throw new Error("a reserve and a settle");
				expect(reserve.request.conversation).toBe(sub.id);
				const spent = settle.settlement.cost;
				expect(spent).toBeGreaterThan(1n);
				expect(yield* shares.get(sub.id)).toEqual(Option.some({ conversation: sub.id, cap: 1n, settled: spent }));

				// At its cap it is refused before the lease is asked, and the provider sees nothing.
				const [refused, events] = yield* withEvents(1, sub.prompt("Second"));
				expect(refused).toMatchObject({ status: "unanswered", reason: "model_error" });
				expect(Option.getOrThrow(yield* stopOf(sub.id)).refusal).toMatchObject({
					_tag: "ShareExhausted",
					conversation: sub.id,
					cap: 1n,
					settled: spent,
				});
				expect(events).toMatchObject([
					{
						_tag: "Refused",
						request: { kind: "chat", conversation: sub.id, session: reserve.request.session },
						refusal: { _tag: "ShareExhausted", cap: 1n, settled: spent },
					},
				]);
				expect(lease.steps.length).toBe(2);
				expect(yield* scripted.callCount).toBe(1);

				// The root has no cap and the lease is live: it goes on.
				expect(yield* root.prompt("Hello")).toMatchObject({ status: "done" });
				expect(lease.steps.map(({ step }) => step)).toEqual(["reserve", "settle", "reserve", "settle"]);
				expect(lease.steps[2]).toMatchObject({ request: { kind: "chat" } });
				expect(lease.steps[2]).not.toHaveProperty("request.conversation");

				// A higher cap, and the stopped conversation continues.
				expect(yield* shares.setCap(sub.id, spent + 1n)).toEqual({
					conversation: sub.id,
					cap: spent + 1n,
					settled: spent,
				});
				const continued = yield* continueStopped(sub);
				expect(yield* continued.wait).toMatchObject({ status: "done" });
				expect(yield* scripted.callCount).toBe(3);
				expect((yield* shares.get(sub.id)).pipe(Option.map((share) => share.settled > spent))).toEqual(
					Option.some(true),
				);
			}),
		));

	it("has no share without a cap, and no cap for a conversation that does not exist", () =>
		run(
			Effect.gen(function* () {
				const shares = yield* Shares;
				const root = yield* rootConversation;
				expect(yield* shares.get(root.id)).toEqual(Option.none());
				const missing = 987654 as ConversationId;
				expect(yield* shares.get(missing)).toEqual(Option.none());
				const error = yield* Effect.flip(shares.setCap(missing, 5n));
				expect(error).toBeInstanceOf(NoProviderSession);
				expect(error).toMatchObject({ conversation: missing });
			}),
		));
});

/** The cost of each settled request, in the order the lease was told. */
const costs = (steps: ReadonlyArray<Step>) =>
	steps.flatMap((step) => (step.step === "settle" ? [step.settlement.cost] : []));

/** The conversation each reservation named; undefined for one that named none. */
const reservedFor = (steps: ReadonlyArray<Step>) =>
	steps.flatMap((step) => (step.step === "reserve" ? [step.request.conversation] : []));

class Rejected extends Schema.TaggedError<Rejected>()("Rejected", {}) {}

describe("a cap set in a commit", () => {
	it("is stored with the commit that creates the conversation, and its first request counts against it", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				const shares = yield* Shares;
				yield* scripted.setResponses([answer("One."), answer("Never.")]);
				let inCommit: unknown;
				const sub = yield* Harness.createConversation({
					ownership: { kind: "ownerless" },
					agent: { model: { provider: scripted.model.provider, modelId: scripted.model.id } },
					init: (tx, conversation) =>
						Effect.gen(function* () {
							inCommit = yield* shares.setCapIn(tx, conversation, 1n);
						}),
				});
				// The same durable result as `setCap`: the share exists as soon as the conversation does.
				expect(inCommit).toEqual({ conversation: sub.id, cap: 1n, settled: 0n });
				expect(yield* shares.get(sub.id)).toEqual(Option.some({ conversation: sub.id, cap: 1n, settled: 0n }));

				expect(yield* sub.prompt("First")).toMatchObject({ status: "done" });
				expect(reservedFor(lease.steps)).toEqual([sub.id]);
				const [spent] = costs(lease.steps);
				expect(yield* shares.get(sub.id)).toEqual(Option.some({ conversation: sub.id, cap: 1n, settled: spent }));

				expect(yield* sub.prompt("Second")).toMatchObject({ status: "unanswered", reason: "model_error" });
				expect(Option.getOrThrow(yield* stopOf(sub.id)).refusal).toMatchObject({
					_tag: "ShareExhausted",
					conversation: sub.id,
					cap: 1n,
					settled: spent,
				});
				expect(yield* scripted.callCount).toBe(1);
			}),
		));

	it("leaves no cap behind when its commit is rolled back", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				const shares = yield* Shares;
				yield* scripted.setResponses([answer("One."), answer("Two.")]);
				const sub = yield* child;
				expect(yield* sub.prompt("First")).toMatchObject({ status: "done" });
				const failed = yield* Effect.flip(
					Harness.commit((tx) => Effect.andThen(shares.setCapIn(tx, sub.id, 1n), Effect.fail(new Rejected()))),
				);
				expect(failed).toBeInstanceOf(Rejected);
				expect(yield* shares.get(sub.id)).toEqual(Option.none());
				// The request after the failed commit is served, and counts against nothing.
				expect(yield* sub.prompt("Second")).toMatchObject({ status: "done" });
				expect(reservedFor(lease.steps)).toEqual([undefined, undefined]);
			}),
		));

	it("holds from the next request of a conversation that was already at work without one", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				const shares = yield* Shares;
				yield* scripted.setResponses([answer("One."), answer("Two."), answer("Never.")]);
				const sub = yield* child;
				expect(yield* sub.prompt("First")).toMatchObject({ status: "done" });
				expect(yield* Harness.commit((tx) => shares.setCapIn(tx, sub.id, 1n))).toEqual({
					conversation: sub.id,
					cap: 1n,
					settled: 0n,
				});
				// What it settled before it had a share was counted nowhere: the share starts at zero.
				expect(yield* sub.prompt("Second")).toMatchObject({ status: "done" });
				expect(yield* sub.prompt("Third")).toMatchObject({ status: "unanswered", reason: "model_error" });
				expect(reservedFor(lease.steps)).toEqual([undefined, sub.id]);
				expect(yield* shares.get(sub.id)).toEqual(
					Option.some({ conversation: sub.id, cap: 1n, settled: costs(lease.steps)[1] }),
				);
			}),
		));

	it("changes the cap of a share and keeps what it settled", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				const shares = yield* Shares;
				yield* scripted.setResponses([answer("One."), answer("Two.")]);
				const sub = yield* child;
				yield* shares.setCap(sub.id, 1n);
				expect(yield* sub.prompt("First")).toMatchObject({ status: "done" });
				const [spent] = costs(lease.steps);
				expect(yield* Harness.commit((tx) => shares.setCapIn(tx, sub.id, spent + 1n))).toEqual({
					conversation: sub.id,
					cap: spent + 1n,
					settled: spent,
				});
				expect(yield* sub.prompt("Second")).toMatchObject({ status: "done" });
				expect(yield* scripted.callCount).toBe(2);
			}),
		));

	it("fails its commit for a conversation that does not exist, and stores nothing", () =>
		run(
			Effect.gen(function* () {
				const shares = yield* Shares;
				const missing = 987654 as ConversationId;
				const exit = yield* Effect.exit(Harness.commit((tx) => shares.setCapIn(tx, missing, 5n)));
				expect(exit._tag).toBe("Failure");
				expect(yield* shares.get(missing)).toEqual(Option.none());
			}),
		));
});

describe("a conversation with a share and no cap", () => {
	it("is never refused, and what it settles is counted and stored, one commit per settled request", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				const shares = yield* Shares;
				yield* scripted.setResponses([answer("One."), answer("Two."), answer("Three.")]);
				const root = yield* rootConversation;
				expect(yield* shares.track(root.id)).toEqual({ conversation: root.id, settled: 0n });
				expect(yield* root.prompt("First")).toMatchObject({ status: "done" });
				expect(yield* root.prompt("Second")).toMatchObject({ status: "done" });
				const [first, second] = costs(lease.steps);
				expect(first).toBeGreaterThan(0n);
				expect(reservedFor(lease.steps)).toEqual([root.id, root.id]);
				// One Effect answers what the conversation has spent: the stored share, which has no cap.
				const share = Option.getOrThrow(yield* shares.get(root.id));
				expect(share).toEqual({ conversation: root.id, settled: first + second });
				expect(share).not.toHaveProperty("cap");

				// A cap can follow: what was counted stays, and tracking again takes the cap away no more.
				yield* shares.setCap(root.id, first + second);
				expect(yield* shares.track(root.id)).toEqual({
					conversation: root.id,
					cap: first + second,
					settled: first + second,
				});
				expect(yield* root.prompt("Third")).toMatchObject({ status: "unanswered", reason: "model_error" });
			}),
		));

	it("gets its share in the commit that creates it, so its first request is counted", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				const shares = yield* Shares;
				yield* scripted.setResponses([answer("One.")]);
				const sub = yield* Harness.createConversation({
					ownership: { kind: "ownerless" },
					agent: { model: { provider: scripted.model.provider, modelId: scripted.model.id } },
					init: (tx, conversation) => Effect.asVoid(shares.trackIn(tx, conversation)),
				});
				expect(yield* shares.get(sub.id)).toEqual(Option.some({ conversation: sub.id, settled: 0n }));
				expect(yield* sub.prompt("First")).toMatchObject({ status: "done" });
				expect(reservedFor(lease.steps)).toEqual([sub.id]);
				expect(yield* shares.get(sub.id)).toEqual(
					Option.some({ conversation: sub.id, settled: costs(lease.steps)[0] }),
				);
			}),
		));

	it("cannot be given to a conversation that does not exist", () =>
		run(
			Effect.gen(function* () {
				const shares = yield* Shares;
				const missing = 987654 as ConversationId;
				expect(yield* Effect.flip(shares.track(missing))).toBeInstanceOf(NoProviderSession);
			}),
		));
});
