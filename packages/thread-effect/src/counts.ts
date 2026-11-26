// What a thread took: its turns and tool calls counted from the entries Pi stored, its money from the budget's shares
// and from the accounts of its swarms' forks.

import { AssistantEntry, type ConversationId, type EntryRecord, ToolResultEntry } from "@earendil-works/pi-durable";
import { ANSWERED } from "@effectified/pi-ai";
import { Shares, type SharesService } from "@effectified/pi-budget";
import { type Conversation, type Doc, Harness } from "@effectified/pi-durable";
import { type MalformedRefusal, Refused } from "@effectified/pi-guard";
import * as Swarm from "@effectified/pi-swarm";
import { Effect, Option, Stream } from "effect";
import * as Forks from "./forks.ts";
import type { Counts, Outcome } from "./outcome.ts";
import type { Ending } from "./standing.ts";
import * as StorageFork from "./storage-fork.ts";
import * as Thread from "./thread.ts";

/**
 * What reading the counts fails with: a failed Pi call, a stored value of a plugin that does not decode, or a swarm
 * of the thread whose coordinator was stored by another version of the swarm plugin.
 */
export type Failure = Doc.Failure | MalformedRefusal | Swarm.SwarmFaulted;

/**
 * The counts of the thread `thread`, which runs in `conversation`, read from the harness storage, so they are the same
 * after a restart. One pass over the conversation's entries, then the money: `settled`, and `forked`.
 */
export function of(
	thread: string,
	conversation: Conversation.Conversation,
	shares: SharesService,
): Effect.Effect<Counts, Failure, Harness.Harness | Forks.Accounts> {
	return Effect.gen(function* () {
		const entries = yield* Stream.runCollect(conversation.entries({ order: "ascending" }));
		// The guard writes its record into the result of every call it kept from running: a block by another
		// extension, such as a person's denial through the approval gate, has none.
		const refused = yield* Effect.forEach(entries, Refused.of);
		return {
			turns: entries.filter(returned).length,
			toolCalls: entries.filter((entry) => ToolResultEntry.is(entry)).length,
			refusedToolCalls: refused.filter(Option.isSome).length,
			settledMicros: (yield* settled(shares, conversation.id)) + (yield* forked(thread)),
		};
	});
}

/**
 * `ending` as the thread's outcome: with what the thread took so far. Of the counts, only the money of a swarm's fork
 * that is an actor and still exists is asked of that actor.
 */
export function counted(
	thread: string,
	conversation: Conversation.Conversation,
	ending: Ending,
): Effect.Effect<Outcome, Failure, Harness.Harness | Shares | Forks.Accounts> {
	return Effect.map(
		Shares.use((shares) => of(thread, conversation, shares)),
		(counts) => ({ ...ending, counts }),
	);
}

/**
 * Whether the entry is a model response that answered, by Pi's rule (`ANSWERED`): Pi also stores a failed attempt as
 * one, an error, an abort, a `pending` partial or a `deferred` response without a handle. A deferred response with a
 * handle is not stored until it is fetched.
 */
function returned(entry: EntryRecord): boolean {
	const message = AssistantEntry.is(entry) ? entry.model?.[0] : undefined;
	return message?.role === "assistant" && ANSWERED[message.stopReason];
}

/**
 * What the budget settled in this storage for `conversation` and for every conversation its tasks own, at any depth:
 * the stored totals of their shares. That is a thread's own requests and its review, its subagents' children, and
 * the forks of its swarms that are conversations of this storage, each of which the composition gives a share in its
 * creating commit. A conversation without a share has no stored total and counts as zero. In a copied storage a
 * share's `settled` is what the copy settled itself (the budget's `onStorageFork`), so nothing of its source is here.
 */
export function settled(
	shares: SharesService,
	conversation: ConversationId,
): Effect.Effect<bigint, Doc.Failure, Harness.Harness> {
	return Effect.gen(function* () {
		const own = Option.match(yield* shares.get(conversation), { onNone: () => 0n, onSome: (share) => share.settled });
		const owned = yield* Stream.runCollect(Harness.scanConversations({ ownerConversationId: conversation }));
		const below = yield* Effect.forEach(owned, (child) => settled(shares, child.id));
		return below.reduce((sum, amount) => sum + amount, own);
	});
}

/**
 * What the forks of the thread's swarms settled in other storages: for every swarm started on `thread` in this
 * storage, the account of each job whose fork is an actor (`Forks.Accounts`), kept in this storage once the fork is
 * destroyed and asked of the fork until then. With `settled` it is the thread's money wherever its forks live.
 *
 * - A fork that is a conversation of this storage is not counted here: `settled` has its share.
 * - A swarm this storage was copied with is its source's (`StorageFork.inherited`).
 * - A job whose fork cannot be asked now has no account to give, and counts as zero until it can.
 */
function forked(
	thread: string,
): Effect.Effect<bigint, Doc.Failure | Swarm.SwarmFaulted, Harness.Harness | Forks.Accounts> {
	return Effect.gen(function* () {
		const accounts = yield* Forks.Accounts;
		const inherited = yield* StorageFork.inherited;
		const perSwarm = yield* Effect.forEach(yield* Thread.swarms(thread), (swarmId) =>
			Effect.gen(function* () {
				const status = yield* Swarm.status(swarmId);
				if (inherited(status.taskId)) return 0n;
				const elsewhere = status.jobs.filter((job) => !Option.exists(job.ran, (place) => place.actorId === null));
				const spent = yield* Effect.forEach(elsewhere, (job) => accounts.spent(swarmId, job));
				return spent.reduce((sum, account) => sum + Option.getOrElse(account, () => 0n), 0n);
			}).pipe(
				// An id is noted before its swarm is stored: a start that was cut off or refused left one without a swarm.
				Effect.catchTag("SwarmNotFound", () => Effect.succeed(0n)),
			),
		);
		return perSwarm.reduce((sum, amount) => sum + amount, 0n);
	});
}
