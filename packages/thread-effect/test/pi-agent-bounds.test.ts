// The numbers of an agent change at their bounds, through Pi's exported `configure` and through the wire schema of
// this package (`ForkAgent.Wire`, the facade's `Agent.ByName`, which `admit` also decodes a thread's agent with):
// each value gets the same verdict from both. The schema restates Pi's bounds (turns 1 or more, token counts 0 or
// more, safe integers) so that a change it lets through is never refused in a creating commit; a bound Pi moves
// fails here.

import { type AgentChange, type ConversationId, configure, type Tx } from "@earendil-works/pi-durable";
import { runTest } from "@effectified/pi-ai/testing";
import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as ForkAgent from "../src/rivet/fork-agent.ts";

/**
 * Pi's verdict on `change`: whether `configure` takes it. `configure` reads the conversation's agent document from
 * the commit and applies the change to it, refusing a bad number before it writes; a stand-in commit that hands it a
 * fresh document is all it needs.
 */
function piTakes(change: AgentChange): Effect.Effect<boolean> {
	// A stand-in: `configure` calls only `doc` of the commit.
	const tx = { doc: async () => ({}) } as unknown as Tx;
	return Effect.map(Effect.exit(Effect.tryPromise(() => configure(tx, 1 as ConversationId, change))), Exit.isSuccess);
}

/** Our verdict on `change`: whether the wire schema decodes it. */
const wireTakes = (change: unknown): boolean => Exit.isSuccess(Schema.decodeUnknownExit(ForkAgent.Wire)(change));

const UNSAFE = 2 ** 53;

/** Values at and around each bound, and values no count may be. */
const TURNS = [0, 1, 2, -1, 1.5, Number.MAX_SAFE_INTEGER, UNSAFE, Number.NaN, Number.POSITIVE_INFINITY];
const TOKENS = [-1, 0, 1, 0.5, -0.5, Number.MAX_SAFE_INTEGER, UNSAFE, Number.NaN, Number.POSITIVE_INFINITY];
const TOKEN_FIELDS = ["reserveTokens", "keepRecentTokens", "backgroundTokens"] as const;

/** Every change the test asks both about: one number at a time, in each place a count is. */
function changes(): ReadonlyArray<{ readonly label: string; readonly change: AgentChange }> {
	return [
		...TURNS.map((maxTurns) => ({ label: `maxTurns ${maxTurns}`, change: { maxTurns } })),
		...TOKEN_FIELDS.flatMap((field) =>
			TOKENS.flatMap((value) => [
				{ label: `compaction.${field} ${value}`, change: { compaction: { [field]: value } } },
				{
					label: `compaction.modelOverrides.${field} ${value}`,
					change: { compaction: { modelOverrides: { "faux/faux-1": { [field]: value } } } },
				},
			]),
		),
	];
}

describe("the numbers of an agent change", () => {
	it("are taken by the wire schema exactly when Pi's configure takes them", () =>
		runTest(
			Effect.gen(function* () {
				const verdicts = [];
				for (const { label, change } of changes()) {
					verdicts.push({ label, pi: yield* piTakes(change), wire: wireTakes(change) });
				}
				expect(verdicts.filter(({ pi, wire }) => pi !== wire)).toEqual([]);
				// Both refuse something and take something: the comparison is not vacuous.
				expect(new Set(verdicts.map(({ pi }) => pi))).toEqual(new Set([true, false]));
			}),
		));

	it("clears a number with null in both", () =>
		runTest(
			Effect.gen(function* () {
				const cleared: AgentChange = { maxTurns: null, compaction: null };
				expect({ pi: yield* piTakes(cleared), wire: wireTakes(cleared) }).toEqual({ pi: true, wire: true });
			}),
		));
});
