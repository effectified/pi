// A conversation in Effect: submit and prompt, commit, fork, configure, compact, reset, abort, read and watch.

import type {
	CommitOptions,
	CompactionResult,
	ContextView,
	ConversationAbortOptions,
	ConversationId,
	ConversationOwnership,
	ConversationRecord,
	ConversationView,
	ConversationWindow,
	EntryId,
	EntryRecord,
	InputSubmissionDraft,
	Agent as PiAgent,
	Conversation as PiConversation,
	SettledSubmissionRecord,
	SubmissionDraft,
	SubmissionId,
	TaskId,
	UserInput,
} from "@earendil-works/pi-durable";
import type { StrictOmit } from "@effectified/pi-ai";
import { Effect, Option, Predicate, type Stream } from "effect";
import * as Agent from "./agent.ts";
import { call } from "./call.ts";
import * as Entries from "./entries.ts";
import { type DurableError, UnexpectedError } from "./errors.ts";
import * as Ids from "./id.ts";
import { type Init as Created, creating } from "./init.ts";
import * as Submission from "./submission.ts";
import * as Transcript from "./transcript.ts";
import * as Tx from "./tx.ts";
import * as Watch from "./watch.ts";

/** The options of an input besides its content: `requestId`, `whenBusy`, `whenIdle`, `onAbort`, `entry`, `notify`. */
export type PromptOptions = StrictOmit<InputSubmissionDraft, "type" | "content">;

/** Where a fork starts, who owns it, what it runs with, and what it gets in the commit that creates it. */
export interface ForkOptions<E = never, R = never> {
	/** The newest entry of this conversation the fork sees. */
	readonly at: EntryId;
	readonly ownership: ConversationOwnership;
	/** Applied over the agent the parent had at `at`, in the creating commit. */
	readonly agent?: Agent.Change;
	/** Runs in the creating commit, after the `agent` change: see `Init`. */
	readonly init?: Init<E, R>;
}

/** What a new conversation gets in the commit that creates it. */
export type Init<E = never, R = never> = Created<E, R>;

/** Which entries `entries` reads, and how many per storage read. */
export type EntriesQuery = Entries.EntriesQuery;

/**
 * The schema of a conversation id, for a document, a task state or a wire that keeps one: the number Pi stores, typed
 * with Pi's brand.
 */
export const Id = Ids.conversation;

/** A handle for one conversation: a plain object of Effects, bound to its harness. Compare handles by `id`. */
export interface Conversation {
	readonly id: ConversationId;
	/**
	 * The conversation's stored record, which never changes: its id, its `parent` and its `owner`. Pi stores nothing
	 * else of a conversation's creation, no time and no creator besides the owner. Read in a commit that writes nothing.
	 */
	readonly record: Effect.Effect<ConversationRecord, DurableError>;
	/** Where this conversation was forked from: the parent and the last entry of it this one sees; none for no fork. */
	readonly parent: Effect.Effect<Option.Option<Parent>, DurableError>;
	/** The task that owns this conversation, and that task's conversation; none for an ownerless one. */
	readonly owner: Effect.Effect<Option.Option<Owner>, DurableError>;
	/** Durably admits input, a write or a continue; succeeds at admission, not at the answer. */
	readonly submit: (draft: SubmissionDraft) => Effect.Effect<Submission.Submission, DurableError>;
	/** `submit` of an input, then `wait`: the settled record, `done` with the answer's entry or `unanswered`. */
	readonly prompt: (input: UserInput, options?: PromptOptions) => Effect.Effect<SettledSubmissionRecord, DurableError>;
	/**
	 * One atomic commit whose body is an Effect on its transaction (see `Tx`): the body's value once the commit is
	 * stored, the body's own failure, with nothing stored, when it fails. Tasks the body creates default to this
	 * conversation.
	 */
	readonly commit: <A, E, R>(
		change: (tx: Tx.Tx) => Effect.Effect<A, E, R>,
		options?: CommitOptions,
	) => Effect.Effect<A, E | DurableError, R>;
	/**
	 * Admits a submission inside the caller's commit, with the rules of `submit`, and gives its id: stored with that
	 * commit or not at all. It comes before the commit's first table write.
	 */
	readonly admit: (tx: Tx.Tx, draft: SubmissionDraft) => Effect.Effect<SubmissionId, DurableError>;
	/**
	 * A new conversation that sees this one's entries up to `at` and continues alone, created in one commit. It fails
	 * with `init`'s own failure when that failed, and nothing is stored then.
	 */
	readonly fork: <E = never, R = never>(
		options: ForkOptions<E, R>,
	) => Effect.Effect<Conversation, E | DurableError, R>;
	/** What the conversation runs with now: its stored agent resolved against the registry and the settings. */
	readonly agent: Effect.Effect<PiAgent, DurableError>;
	/** Changes what the conversation runs with, in one commit; tools and extensions as values or as names. */
	readonly configure: (change: Agent.Change) => Effect.Effect<void, DurableError>;
	/** Admits a manual compaction and gives its task's id; the conversation keeps working meanwhile. */
	readonly compact: (instructions?: string) => Effect.Effect<TaskId<CompactionResult>, DurableError>;
	/** Admits a reset: a new context, starting from `handoff` when given. Older entries stay stored. */
	readonly reset: (handoff?: string) => Effect.Effect<void, DurableError>;
	/** Withdraws queued inputs, aborts the conversation's work, and succeeds once it is idle. */
	readonly abort: (options?: ConversationAbortOptions) => Effect.Effect<void, DurableError>;
	/** Succeeds once the conversation has no live work. Interrupting it cancels only this wait. */
	readonly waitForIdle: Effect.Effect<void, DurableError>;
	/** The active transcript and the model context, as of now or of the entry `at`. */
	readonly context: (options?: { readonly at?: EntryId }) => Effect.Effect<ContextView, DurableError>;
	/**
	 * The id of the newest entry visible from this conversation, the one a fork `at` it would end with; none while the
	 * conversation is empty. Not Pi's `EntryRecord.head`, which marks where an active context starts.
	 */
	readonly head: Effect.Effect<Option.Option<EntryId>, DurableError>;
	/** The stored history, fork-aware, newest first unless `order` is `ascending`, read page by page as it is pulled. */
	readonly entries: (query?: EntriesQuery) => Stream.Stream<EntryRecord, DurableError>;
	/**
	 * Pi's `watch` as a Stream: the conversation's view now (a window over its entries, and its built-in documents such
	 * as `pi.live`, `pi.inbox` and `pi.usage`), then one element per change, with its Chord operations. Pi folds the
	 * commits a slow consumer misses into its next element. Closing the stream's scope releases the watch. `window`
	 * bounds the entries the view holds: the newest 50 by default, up to 100.
	 */
	readonly changes: (window?: ConversationWindow) => Stream.Stream<Watch.Change<ConversationView>, DurableError>;
	/**
	 * A new, empty client transcript of this conversation (Pi's `ConversationTranscript`): merge each value of `changes`
	 * into it, or use `Transcript.stream`. Fails with `UnexpectedError` for a `pageSize` that is not an integer `1` or
	 * more.
	 */
	readonly transcript: (options?: Transcript.Options) => Effect.Effect<Transcript.Transcript, DurableError>;
}

/** The fork source of a conversation: Pi's `ConversationRecord.parent`. */
export type Parent = NonNullable<ConversationRecord["parent"]>;

/** The creator edge of a conversation: Pi's `ConversationRecord.owner`. */
export type Owner = NonNullable<ConversationRecord["owner"]>;

/** The Effect form of a Pi Durable conversation handle. */
export function fromPi(conversation: PiConversation): Conversation {
	const submit = (draft: SubmissionDraft) =>
		Effect.map(
			call((context) => conversation.submit(draft, context)),
			Submission.fromPi,
		);
	const record = Effect.filterOrFail(
		call((context) => conversation.commit((tx) => tx.conversation(conversation.id), context)),
		Predicate.isNotUndefined,
		// Pi gives a handle only for a stored conversation and never deletes one: this is Pi's own inconsistency.
		() => new UnexpectedError({ cause: new Error(`Conversation ${conversation.id} has no record`) }),
	);
	return {
		id: conversation.id,
		record,
		parent: Effect.map(record, (found) => Option.fromUndefinedOr(found.parent)),
		owner: Effect.map(record, (found) => Option.fromUndefinedOr(found.owner)),
		submit,
		prompt: (input, options) =>
			Effect.flatMap(submit({ ...options, type: "input", content: input }), (submission) => submission.wait),
		commit: (change, options) =>
			Tx.commit((body, context, given) => conversation.commit(body, context, given), change, options),
		admit: (tx, draft) => Tx.admit(conversation, tx, draft),
		fork: ({ at, ownership, agent, init }) =>
			Effect.map(
				creating(init, (given, context) =>
					conversation.fork(at, { ...Agent.creation({ ownership, agent }), ...given }, context),
				),
				fromPi,
			),
		agent: call((context) => conversation.agent(context)),
		configure: (change) => call((context) => conversation.configure(Agent.toPi(change), context)),
		compact: (instructions) => call((context) => conversation.compact(instructions, context)),
		reset: (handoff) => call((context) => conversation.reset(handoff, context)),
		abort: (options) => call((context) => conversation.abort(context, options)),
		waitForIdle: call((context) => conversation.waitForIdle(context)),
		context: (options) => call((context) => conversation.context(context, options)),
		head: Effect.map(
			call((context) => conversation.entries({}, 1, undefined, context)),
			(page) => Option.fromNullishOr(page.items[0]?.id),
		),
		entries: (query) => Entries.stream((...page) => conversation.entries(...page), query),
		changes: (window) => Watch.stream((context) => conversation.watch(context, window)),
		transcript: (options) => Transcript.fromPi(conversation, options),
	};
}
