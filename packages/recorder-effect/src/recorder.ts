// The recorder: a pump that delivers the records of committed entries to the sink, in order, at least once.

import type { ConversationId, Cursor as ScanCursor } from "@earendil-works/pi-durable";
import { type Doc, type DurableError, Entry, Harness } from "@effectified/pi-durable";
import { Context, Effect, Layer, Option, Queue, Schedule, Semaphore, Stream } from "effect";
import * as Cursor from "./cursor.ts";
import { fromEntry } from "./from-entry.ts";
import { RecordSink, type RecordSinkError } from "./sink.ts";

/** What a delivery fails with: the sink, after its retries, or the harness (a failed read or cursor commit). */
export type Failure = RecordSinkError | Doc.Failure;

/** What the pump gives a host. */
export interface Service {
	/**
	 * Succeeds once the records of every entry the conversation had committed when it was called are delivered. It
	 * waits while the sink is retried, and fails when the retry schedule ends or the harness refuses a read or a
	 * commit; nothing is lost then, and a later flush or commit delivers.
	 */
	readonly flush: (conversationId: ConversationId) => Effect.Effect<void, Failure>;
	/** `flush` for every conversation of the harness that this pump knows to be behind. */
	readonly flushAll: Effect.Effect<void, Failure>;
}

/** The running pump of this program. */
export class Recorder extends Context.Service<Recorder, Service>()("@effectified/pi-recorder/Recorder") {}

/** Options of `layer`. */
export interface Options {
	/**
	 * How a failing sink is tried again: its input is the sink's error. Default: forever, 100 milliseconds apart at
	 * first, doubling up to 30 seconds. When a schedule ends, the batch stays undelivered until the conversation's next
	 * commit or a flush.
	 */
	readonly retry?: Schedule.Schedule<unknown, RecordSinkError>;
}

/** Entries read, and delivered as one batch, per step. */
const BATCH_ENTRIES = 100;

/** Conversations the background pump delivers at once; a flush is not counted. */
const CONCURRENT_CONVERSATIONS = 16;

const DEFAULT_RETRY: Schedule.Schedule<unknown, RecordSinkError> = Schedule.min([
	Schedule.exponential("100 millis"),
	Schedule.spaced("30 seconds"),
]);

/** Every conversation of the storage, read page by page in commits that only read. */
const conversations = Stream.paginate(undefined, (cursor: ScanCursor | undefined) =>
	Effect.map(
		Harness.commit((tx) => tx.scanConversations({}, BATCH_ENTRIES, cursor)),
		(page) => [page.items, Option.fromNullishOr(page.next)] as const,
	),
);

/**
 * Starts the pump for the scope. The entries are the outbox: a record is derived from an entry Pi committed with its
 * step, and the cursor document says, per conversation, how far delivery got.
 *
 * - **Recovery.** Building the Layer reads every conversation of the storage and queues it, so what an earlier
 *   process committed and did not deliver is delivered now. The Layer does not wait for those deliveries.
 * - **Following.** It observes Pi's stored commits: one that holds an entry queues that entry's conversation. A quiet
 *   harness costs nothing. Every conversation is covered so: the root, created ones, forks and task-owned ones.
 * - **Order.** One batch of a conversation at a time, in entry order; the cursor moves, in a commit of its own, only
 *   after the sink took the batch. Conversations are delivered independently of each other.
 */
export function layer(options: Options = {}): Layer.Layer<Recorder, DurableError, Harness.Harness | RecordSink> {
	return Layer.effect(
		Recorder,
		Effect.gen(function* () {
			const harness = yield* Harness.Harness;
			const sink = yield* RecordSink;
			const retry = options.retry ?? DEFAULT_RETRY;
			const onHarness = Effect.provideService(Harness.Harness, harness);
			const locks = new Map<ConversationId, Semaphore.Semaphore>();
			/** Conversations that may hold undelivered entries: queued, being delivered, or left by a failed attempt. */
			const behind = new Set<ConversationId>();
			/** Those of `behind` that wait in `queue` for an attempt that has not started. */
			const queued = new Set<ConversationId>();
			const queue = yield* Effect.acquireRelease(Queue.unbounded<ConversationId>(), Queue.shutdown);
			yield* onHarness(Cursor.ensure);

			/** Called by Pi inside its publication of a commit, so it only notes the conversation. */
			const notice = (conversationId: ConversationId): void => {
				behind.add(conversationId);
				if (queued.has(conversationId)) return;
				queued.add(conversationId);
				Queue.offerUnsafe(queue, conversationId);
			};

			/** Delivers the next batch after the cursor, then moves the cursor; true when more entries may follow. */
			const deliverNext = (conversationId: ConversationId): Effect.Effect<boolean, Failure, Harness.Harness> =>
				Effect.gen(function* () {
					const conversation = yield* Harness.conversation(conversationId);
					if (Option.isNone(conversation)) return false;
					const delivered = yield* Cursor.start(conversationId);
					const entries = yield* Stream.runCollect(
						conversation.value
							.entries({
								order: "ascending",
								...Option.match(delivered, {
									onNone: () => ({}),
									onSome: (id) => ({ minEntryId: Entry.after(id) }),
								}),
								pageSize: BATCH_ENTRIES,
							})
							.pipe(Stream.take(BATCH_ENTRIES)),
					);
					const last = entries.at(-1);
					if (last === undefined) return false;
					const records = entries.flatMap(fromEntry);
					if (records.length > 0) yield* sink.deliver(records).pipe(Effect.retry(retry));
					yield* Cursor.advance(conversationId, last.id);
					return entries.length === BATCH_ENTRIES;
				});

			const drain = (conversationId: ConversationId): Effect.Effect<void, Failure, Harness.Harness> =>
				Effect.flatMap(deliverNext(conversationId), (more) => (more ? drain(conversationId) : Effect.void));

			/** One attempt to bring a conversation up to date, alone on that conversation. A failure leaves it `behind`. */
			const attempt = (conversationId: ConversationId): Effect.Effect<void, Failure> => {
				let lock = locks.get(conversationId);
				if (lock === undefined) {
					lock = Semaphore.makeUnsafe(1);
					locks.set(conversationId, lock);
				}
				return Semaphore.withPermit(
					lock,
					Effect.gen(function* () {
						// From here on a commit is noticed again: this attempt may have read before it.
						queued.delete(conversationId);
						yield* onHarness(drain(conversationId));
						if (!queued.has(conversationId)) behind.delete(conversationId);
					}),
				);
			};

			// Attached before the storage is read, so no commit falls between the two.
			yield* Effect.acquireRelease(
				Effect.sync(() =>
					harness.observeCommits({
						advance: (publication) => {
							for (const change of publication.changes) {
								if (change.type === "entry") notice(change.value.conversationId);
							}
						},
						end: () => {},
					}),
				),
				(observation) => Effect.sync(() => observation.detach()),
			);
			yield* Stream.runForEach(conversations, (conversation) => Effect.sync(() => notice(conversation.id))).pipe(
				onHarness,
			);
			yield* Effect.forkScoped(
				Stream.fromQueue(queue).pipe(
					Stream.mapEffect(
						(conversationId) =>
							Effect.catch(attempt(conversationId), (error) =>
								// Never the error's message: a sink's or Pi's may quote content.
								Effect.annotateLogs(
									Effect.logWarning("The recorder could not deliver; the next commit or flush tries again"),
									{ conversationId, error: error._tag },
								),
							),
						{ concurrency: CONCURRENT_CONVERSATIONS, unordered: true },
					),
					Stream.runDrain,
				),
			);
			return {
				flush: attempt,
				flushAll: Effect.suspend(() =>
					Effect.forEach([...behind], attempt, { concurrency: "unbounded", discard: true }),
				),
			};
		}),
	);
}

/** `Service.flush` of the pump of the context. */
export function flush(conversationId: ConversationId): Effect.Effect<void, Failure, Recorder> {
	return Recorder.use((recorder) => recorder.flush(conversationId));
}

/** `Service.flushAll` of the pump of the context. */
export const flushAll: Effect.Effect<void, Failure, Recorder> = Recorder.use((recorder) => recorder.flushAll);
