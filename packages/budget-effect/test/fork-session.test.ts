// What a share rests on when a conversation is forked: Pi gives the fork a provider session of its own (the fork rule
// of its built-in `pi.provider` document), so a fork starts without its parent's share, its requests carry another
// session and another key, and what it spends is not counted against the parent's cap. A Pi that copied the
// parent's session would put both conversations on one share: this fails then.

import { runTest } from "@effectified/pi-ai/testing";
import { BuiltinDoc, type Conversation, Harness } from "@effectified/pi-durable";
import { answer, ScriptedModels } from "@effectified/pi-durable/testing";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { Shares } from "../src/index.ts";
import { budgetedHarness, root as rootConversation, TestLease } from "./support.ts";

/** The requests the lease reserved, in order: their conversation's session and their key. */
const reserved = TestLease.use((lease) =>
	Effect.succeed(
		lease.steps.flatMap((step) =>
			step.step === "reserve" ? [{ session: step.request.session, key: step.request.requestKey }] : [],
		),
	),
);

/** The provider session Pi gave `conversation`: the `sessionId` of its `pi.provider` document. */
const sessionOf = (conversation: Conversation.Conversation) =>
	Effect.map(Harness.snapshot(BuiltinDoc.provider, conversation.id), (state) => Option.getOrThrow(state).sessionId);

/** The newest entry of `conversation`, where a fork of it starts. */
const newest = (conversation: Conversation.Conversation) =>
	Effect.flatMap(conversation.head, (head) =>
		Option.match(head, {
			onNone: () => Effect.die(new Error("the conversation has no entry")),
			onSome: Effect.succeed,
		}),
	);

describe("a forked conversation", () => {
	it("gets a provider session of its own, so it has no share of its parent and its requests carry another key", () =>
		runTest(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const shares = yield* Shares;
				yield* scripted.setResponses([answer("Parent."), answer("Fork."), answer("Parent again.")]);
				const parent = yield* rootConversation;
				yield* shares.setCap(parent.id, 1_000_000_000n);
				expect(yield* parent.prompt("Hello")).toMatchObject({ status: "done" });
				const parentShare = Option.getOrThrow(yield* shares.get(parent.id));

				const fork = yield* parent.fork({ at: yield* newest(parent), ownership: { kind: "ownerless" } });
				const parentSession = yield* sessionOf(parent);
				const forkSession = yield* sessionOf(fork);
				expect(forkSession).not.toBe(parentSession);
				// The share document has session scope: a fork with the parent's session would see the parent's share.
				expect(yield* shares.get(fork.id)).toEqual(Option.none());

				expect(yield* fork.prompt("Again")).toMatchObject({ status: "done" });
				// What the fork spent is not the parent's.
				expect(yield* shares.get(parent.id)).toEqual(Option.some(parentShare));
				expect(yield* parent.prompt("Once more")).toMatchObject({ status: "done" });

				const [first, forked, again] = yield* reserved;
				expect([first?.session, forked?.session, again?.session]).toEqual([
					parentSession,
					forkSession,
					parentSession,
				]);
				expect(forked?.key).not.toBe(first?.key);
				expect(new Set([first?.key, forked?.key, again?.key]).size).toBe(3);
			}).pipe(Effect.provide(budgetedHarness())),
		));
});
