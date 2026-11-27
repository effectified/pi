// Test helper: a fork made exactly once per job key, as a swarm makes its forks. `init` claims the key in the commit
// that creates the fork, so the key and the fork exist together or not at all, and a retried job finds its fork again.
// Used on memory (init.test.ts) and across a crash on a SQLite file (keyed-fork-crash.ts).

import type { ConversationId } from "@earendil-works/pi-durable";
import { Effect, Option, Schema } from "effect";
import { type Conversation, Doc, Harness } from "../src/index.ts";

/** One document per job key, of the whole session: which conversation the job forked. */
export const Jobs = Doc.family({
	kind: "swarm.job",
	version: 1,
	scope: "session",
	schema: Schema.Struct({ conversationId: Schema.NullOr(Schema.Number) }),
	initial: () => ({ conversationId: null }),
	checkpointWhen: () => false,
});

/** On the fork itself: the job it was made for. */
export const Job = Doc.make({
	kind: "swarm.fork",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	schema: Schema.Struct({ key: Schema.String }),
	initial: () => ({ key: "" }),
	checkpointWhen: () => false,
});

/** The job `key` has its fork already. */
export class AlreadyForked extends Schema.TaggedError<AlreadyForked, { readonly brand: unique symbol }>()(
	"AlreadyForked",
	{
		key: Schema.String,
		conversationId: Schema.Number,
	},
) {}

/**
 * Forks `parent` at its head for the job `key`. `init` runs in the creating commit: it fails the commit, so no fork is
 * stored, when the key is claimed, and claims it otherwise.
 */
export const forkFor = (parent: Conversation.Conversation, key: string) =>
	Effect.gen(function* () {
		const at = Option.getOrThrow(yield* parent.head);
		return yield* parent.fork({
			at,
			ownership: { kind: "ownerless" },
			init: (tx, conversationId) =>
				Effect.gen(function* () {
					const job = yield* tx.doc(Jobs, key, null);
					const claimed = (yield* job.get).conversationId;
					if (claimed !== null) return yield* new AlreadyForked({ key, conversationId: claimed });
					yield* job.set({ conversationId });
					yield* (yield* tx.doc(Job, conversationId)).set({ key });
				}),
		});
	});

/** The fork of the job `key`, by the session document `init` wrote: one read, whatever the number of conversations. */
export const findByKey = (key: string) =>
	Effect.map(Harness.snapshot(Jobs, key), (job) =>
		Option.flatMap(job, ({ conversationId }) => Option.fromNullOr(conversationId as ConversationId | null)),
	);

/** The same fork, found by scanning every conversation for the document `init` wrote on it. */
export const findByScan = (key: string) =>
	Effect.gen(function* () {
		const { items } = yield* Harness.commit((tx) => tx.scanConversations({}, 100));
		const found = yield* Effect.filter(items, (conversation) =>
			Effect.map(Harness.snapshot(Job, conversation.id), (job) => Option.isSome(job) && job.value.key === key),
		);
		return found.map((conversation) => conversation.id);
	});

/** Every conversation the storage holds. */
export const conversations = Effect.map(
	Harness.commit((tx) => tx.scanConversations({}, 100)),
	(page) => page.items,
);
