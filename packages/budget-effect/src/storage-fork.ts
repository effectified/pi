// A copied storage has settled nothing itself: what a host runs on a copy of a whole harness storage before its first
// request, so that money stored in two storages is counted once.

import { Doc, Harness } from "@effectified/pi-durable";
import { Effect, Option, Schema, Stream } from "effect";
import { forget, type Share, ShareDocument, Shares, seedOf, sessionOf } from "./shares.ts";

/**
 * Makes the shares a copy inherited its own: every share's `settled` total is moved into `inherited`, and its cap
 * stays. Run it on a storage copied from another one (an actor fork), on a harness opened with `resume: false`,
 * before the copy's first request.
 *
 * Why: a copy of a storage holds every `budget.share` with the total its source had settled, so that money is stored
 * in two storages, and a sum over them counts it twice. After this step:
 *
 * - `settled` is what this storage settled since it was copied: a sum of `settled` over storages counts every
 *   request once, in the storage that sent it;
 * - `inherited` is what was settled before the copy, in every storage this one descends from, and a cap counts
 *   both. A copy of a conversation at 90% of its cap has 10% left, not a cap of its own to spend again.
 *
 * `copy` names this copy: a text that is the same whenever the step runs again on it, and that no storage it was
 * copied from, and no other copy, is given. For a Rivet actor fork that is the fork's actor id. The name is stored
 * with the move, in one commit, as the mark `budget.copy`, which is what makes the step idempotent: run again under
 * the same name, also after the copy has settled requests of its own, it changes nothing. A copy of this copy runs
 * it under its own name, and what this one settled becomes inherited there.
 *
 * It reads and writes the storage of the `Harness` of the context, so it needs no `Shares.attach`; the `Shares` is
 * the budget's, which then reads the moved shares again instead of going on from what it counted in memory.
 */
export function onStorageFork(copy: string): Effect.Effect<void, Doc.Failure, Harness.Harness | Shares> {
	return Effect.gen(function* () {
		const mark = yield* Harness.snapshot(Copy);
		if (Option.getOrUndefined(mark)?.copy === copy) return;
		const settled = yield* spent;
		yield* Harness.commit((tx) =>
			Effect.gen(function* () {
				for (const [session, share] of settled) {
					const document = yield* tx.doc(ShareDocument, session, seedOf(share));
					// Read as the body runs: the amount moved is the one stored now.
					yield* document.update((current) => ({
						...current,
						settled: 0n,
						inherited: (current.inherited ?? 0n) + current.settled,
					}));
				}
				yield* Effect.flatMap(tx.doc(Copy), (document) => document.set({ copy }));
			}),
		);
		yield* forget(
			yield* Shares,
			settled.map(([session]) => session),
		);
	});
}

/**
 * The mark of a copied storage, kind `budget.copy`: the name of the copy whose shares were last made its own; null in
 * a storage no step ran on. It is copied with the storage, so a copy of a copy finds its source's name, not its own.
 */
const Copy = Doc.make({
	kind: "budget.copy",
	version: 1,
	scope: "session",
	schema: Schema.Struct({ copy: Schema.NullOr(Schema.String) }),
	initial: () => ({ copy: null }),
	// One short text, written once per copy.
	checkpointWhen: () => true,
});

/**
 * Every share of the storage that has settled something, by its provider session. Pi lists no documents, so a share
 * is found through its conversation; and it is read outside a commit, where a document that does not exist is none:
 * a commit would create a share for every conversation it looked at.
 */
const spent: Effect.Effect<ReadonlyArray<readonly [string, Share]>, Doc.Failure, Harness.Harness> = Effect.gen(
	function* () {
		const found: Array<readonly [string, Share]> = [];
		yield* Stream.runForEach(Harness.scanConversations(), (conversation) =>
			Effect.gen(function* () {
				const session = yield* sessionOf(conversation.id);
				if (Option.isNone(session)) return;
				const share = yield* Harness.snapshot(ShareDocument, session.value);
				if (Option.isSome(share) && share.value.settled > 0n) found.push([session.value, share.value]);
			}),
		);
		return found;
	},
);
