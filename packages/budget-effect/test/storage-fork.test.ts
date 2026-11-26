// `onStorageFork` on one storage, which stands in for a copy of itself here: the suite on a copied SQLite file is in
// sqlite-suites.ts.

import { Harness } from "@effectified/pi-durable";
import { answer, ScriptedModels } from "@effectified/pi-durable/testing";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { onStorageFork, ShareDocument, Shares } from "../src/index.ts";
import { type Budgeted, budgetedHarness, root as rootConversation, TestLease } from "./support.ts";

const run = <A, E>(body: Effect.Effect<A, E, Harness.Harness | Budgeted>) =>
	Effect.runPromise(Effect.provide(body, budgetedHarness()));

/** A second conversation on the scripted model. */
const child = ScriptedModels.use(({ model }) =>
	Harness.createConversation({
		ownership: { kind: "ownerless" },
		agent: { model: { provider: model.provider, modelId: model.id } },
	}),
);

/** What the lease was told so far, in micro units. */
const told = TestLease.use((lease) =>
	Effect.sync(() => lease.steps.reduce((sum, step) => sum + (step.step === "settle" ? step.settlement.cost : 0n), 0n)),
);

describe("onStorageFork", () => {
	it("moves what every share settled into what it inherited, keeps the caps, and leaves other conversations without a share", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const shares = yield* Shares;
				yield* scripted.setResponses([answer("One."), answer("Two.")]);
				const root = yield* rootConversation;
				const capped = yield* child;
				const idle = yield* child;
				const bare = yield* child;
				yield* shares.track(root.id);
				yield* shares.setCap(capped.id, 1_000_000n);
				yield* shares.setCap(idle.id, 5n);
				yield* root.prompt("First");
				const first = yield* told;
				yield* capped.prompt("Second");
				const second = (yield* told) - first;

				yield* onStorageFork("copy-1");
				expect(yield* shares.get(root.id)).toEqual(
					Option.some({ conversation: root.id, settled: 0n, inherited: first }),
				);
				expect(yield* shares.get(capped.id)).toEqual(
					Option.some({ conversation: capped.id, cap: 1_000_000n, settled: 0n, inherited: second }),
				);
				// A share that had settled nothing is as it was, and a conversation without one still has none.
				expect(yield* shares.get(idle.id)).toEqual(Option.some({ conversation: idle.id, cap: 5n, settled: 0n }));
				expect(yield* shares.get(bare.id)).toEqual(Option.none());
			}),
		));

	it("changes nothing when it runs again under the same name, and moves again under the name of a copy of the copy", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const shares = yield* Shares;
				yield* scripted.setResponses([answer("One."), answer("Two.")]);
				const root = yield* rootConversation;
				yield* shares.track(root.id);
				yield* root.prompt("First");
				const first = yield* told;
				yield* onStorageFork("copy-1");
				// The budget goes on from the moved share, not from what it had counted in memory.
				yield* root.prompt("Second");
				const second = (yield* told) - first;
				const own = Option.some({ conversation: root.id, settled: second, inherited: first });
				expect(yield* shares.get(root.id)).toEqual(own);
				yield* onStorageFork("copy-1");
				expect(yield* shares.get(root.id)).toEqual(own);
				// What a copy of this storage finds: the mark of its source, under another name than its own.
				yield* onStorageFork("copy-2");
				expect(yield* shares.get(root.id)).toEqual(
					Option.some({ conversation: root.id, settled: 0n, inherited: first + second }),
				);
			}),
		));

	it("exports the share document under the plugin's kind, keyed by the provider session", () => {
		expect([ShareDocument.kind, ShareDocument.scope, ShareDocument.family]).toEqual([
			"budget.share",
			"session",
			true,
		]);
	});
});
