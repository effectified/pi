// The recorder: a pump that delivers the records of committed entries to the sink, in order, at least once.

import type { ConversationId, EntryRecord } from "@effectified/pi-durable";
import { type Doc, type DurableError, Entry, Harness } from "@effectified/pi-durable";
import { Array as Arr, Context, Effect, Layer, Option, Queue, RcMap, Schedule, Semaphore, Stream } from "effect";
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
export class Recorder extends Context.Service<Recorder, Service>()("@effectified/pi-recorder/recorder") {}

/** Options of `layer`. */
export interface Options {
	/**
	 * How a failing sink is tried again: its input is the sink's error. Default: forever, 100 milliseconds apart at
	 * first, doubling up to 30 seconds. When a schedule ends, the batch stays undelivered until the conversation's next
	 * commit or a flush.
	 */
	readonly retry?: Schedule.Schedule<unknown, RecordSinkError>;
}

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
	return Layer.effect(Recorder, make(options));
}

/** Entries read, and delivered as one batch, per step. */
const BATCH_ENTRIES = 100;

/** Conversations the background pump delivers at once; a flush is not counted. */
const CONCURRENT_CONVERSATIONS = 16;

const DEFAULT_RETRY: Schedule.Schedule<unknown, RecordSinkError> = Schedule.min([
	Schedule.exponential("100 millis"),
	Schedule.spaced("30 seconds"),
]);

/** The pump of `layer`, its fibers in the Layer's scope. */
const make = Effect.fn("Recorder.make")(function* (options: Options) {
	const harness = yield* Harness.Harness;
	const sink = yield* RecordSink;
	const retry = options.retry ?? DEFAULT_RETRY;
	const onHarness = Effect.provideService(Harness.Harness, harness);
	// One lock per conversation while an attempt on it holds or awaits it; dropped when the last one is done.
	const locks = yield* RcMap.make({ lookup: (_conversationId: ConversationId) => Semaphore.make(1) });
	// Conversation ids are numbers, which native sets compare by value; `notice` runs inside Pi's publication.
	/** Conversations that may hold undelivered entries: queued, being delivered, or left by a failed attempt. */
	const behind = new Set<ConversationId>();
	/** Those of `behind` that wait in `queue` for an attempt that has not started. */
	const queued = new Set<ConversationId>();
	const queue = yield* Effect.acquireRelease(Queue.unbounded<ConversationId>(), Queue.shutdown);
	yield* onHarness(Cursor.ensure);

	/** Notes that a conversation may be behind, and queues it unless it waits already. Called by Pi in a publication. */
	const notice = (conversationId: ConversationId): void => {
		behind.add(conversationId);
		if (queued.has(conversationId)) return;
		queued.add(conversationId);
		Queue.offerUnsafe(queue, conversationId);
	};

	/** Delivers the records of one batch of a conversation's entries, then moves its cursor past the batch. */
	const deliver = Effect.fn("Recorder.deliver")(function* (
		conversationId: ConversationId,
		batch: Arr.NonEmptyReadonlyArray<EntryRecord>,
	) {
		const records = Arr.flatMap(batch, fromEntry);
		if (Arr.isArrayNonEmpty(records)) yield* Effect.retry(sink.deliver(records), retry);
		yield* Cursor.advance(conversationId, Arr.lastNonEmpty(batch).id);
	});

	/**
	 * Delivers every entry of a conversation after its cursor, batch by batch, as they are read: a page of Pi's per
	 * batch, and an entry committed meanwhile is in a later page.
	 */
	const drain = Effect.fn("Recorder.drain")(function* (conversationId: ConversationId) {
		const conversation = yield* Harness.conversation(conversationId);
		if (Option.isNone(conversation)) return;
		const delivered = yield* Cursor.start(conversationId);
		const after = Option.match(delivered, { onNone: () => ({}), onSome: (id) => ({ minEntryId: Entry.after(id) }) });
		yield* conversation.value.entries({ order: "ascending", ...after, pageSize: BATCH_ENTRIES }).pipe(
			Stream.grouped(BATCH_ENTRIES),
			Stream.runForEach((batch) => deliver(conversationId, batch)),
		);
	});

	/** One attempt to bring a conversation up to date, alone on that conversation. A failure leaves it `behind`. */
	const attempt = Effect.fn("Recorder.attempt")(function* (conversationId: ConversationId) {
		const lock = yield* RcMap.get(locks, conversationId);
		yield* Semaphore.withPermit(
			lock,
			Effect.gen(function* () {
				// From here on a commit is noticed again: this attempt may have read before it.
				queued.delete(conversationId);
				yield* onHarness(drain(conversationId));
				if (!queued.has(conversationId)) behind.delete(conversationId);
			}),
		);
	}, Effect.scoped);

	// Pi's commit observer itself, not the Stream of `Harness.commits`: a stream element is taken by a fiber later,
	// and `flush` and `flushAll` must find every conversation a commit before them touched. Attached before the
	// storage is read, so no commit falls between the two.
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
	yield* Stream.runForEach(Harness.scanConversations(), (conversation) =>
		Effect.sync(() => notice(conversation.id)),
	).pipe(onHarness);
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
	return Recorder.of({
		flush: attempt,
		flushAll: Effect.suspend(() =>
			Effect.forEach(Arr.fromIterable(behind), attempt, { concurrency: "unbounded", discard: true }),
		),
	});
});

/** `Service.flush` of the pump of the context. */
export const flush: (conversationId: ConversationId) => Effect.Effect<void, Failure, Recorder> = Effect.fn(
	"Recorder.flush",
)(function* (conversationId) {
	const recorder = yield* Recorder;
	yield* recorder.flush(conversationId);
});

/** `Service.flushAll` of the pump of the context. */
export const flushAll: Effect.Effect<void, Failure, Recorder> = Recorder.use((recorder) => recorder.flushAll);
