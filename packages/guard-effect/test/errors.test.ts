import { fromPiModelRef } from "@effectified/pi-ai";
import type { ConversationId } from "@effectified/pi-durable";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { ModelNotCleared, Unguarded, UnguardedReason } from "../src/index.ts";

const id = 7 as ConversationId;

describe("Unguarded", () => {
	it("says in one sentence why, for each of its reasons", () => {
		const { NoRegistry, NotSelected, NotFirst } = UnguardedReason.cases;
		const messages = [NoRegistry.make({}), NotSelected.make({}), NotFirst.make({})].map(
			(reason) => Unguarded.make({ conversationId: id, reason }).message,
		);
		expect(messages).toEqual([
			"This guard built no registry: nothing would enforce a grant of conversation 7",
			"Conversation 7 does not select the guard's extension",
			"Conversation 7 asks another extension before the guard's",
		]);
	});

	it("lets a caller pick one reason with Effect.catchReason, and keeps the others as failures", async () => {
		const failing = (reason: UnguardedReason) => Effect.fail(Unguarded.make({ conversationId: id, reason }));
		const lenient = (reason: UnguardedReason) =>
			failing(reason).pipe(Effect.catchReason("Unguarded", "NotFirst", () => Effect.succeed("asked later")));
		expect(await Effect.runPromise(lenient({ _tag: "NotFirst" }))).toBe("asked later");
		const kept = await Effect.runPromiseExit(lenient({ _tag: "NotSelected" }));
		expect(Exit.isFailure(kept)).toBe(true);
	});
});

describe("ModelNotCleared", () => {
	it("names the model with its branded ids, and says what is missing", () => {
		const model = fromPiModelRef({ provider: "acme", modelId: "small" });
		const messages = [
			ModelNotCleared.make({ ...model, classification: "secret", ceiling: "internal" }),
			ModelNotCleared.make({ ...model, classification: "secret", ceiling: undefined }),
			ModelNotCleared.make({ ...model, classification: undefined, ceiling: "internal" }),
		].map((error) => error.message);
		expect(messages).toEqual([
			"Model acme/small is cleared up to internal, not for secret",
			"Model acme/small has no classification ceiling",
			"Model acme/small may not serve a conversation without a classification",
		]);
	});
});
