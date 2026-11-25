// The in-storage driver: a swarm's forks are conversation forks of the source, in the harness its coordinator runs in.

import { type ConversationId, type EntryId, SubmissionSettled, type TaskId } from "@earendil-works/pi-durable";
import { type Conversation, Doc, Harness, type Tx } from "@gunta/pi-durable-effect";
import { Deferred, Effect, Layer, Option, Schema, Stream } from "effect";
import {
	type Destroyed,
	type Fork,
	ForkDriver,
	type ForkDriverService,
	ForkGone,
	type ForkRequest,
	ForkRetryLater,
} from "./driver.ts";
import type { ForkSetupFailed } from "./errors.ts";
import type { Forked } from "./fork-setup.ts";
import { jobStatus } from "./job-status.ts";

/**
 * The driver, before its harness is open: the registry needs it to install the coordinators, and the harness needs
 * the registry. Every operation waits until `attach` has given it the open harness.
 */
export const layer: Layer.Layer<ForkDriver> = Layer.effect(
	ForkDriver,
	Effect.map(Deferred.make<Harness.Open>(), (harness) => {
		const driver = make(harness);
		harnesses.set(driver, harness);
		return driver;
	}),
);

/**
 * Gives the driver the open harness its forks live in: build it on top of `Harness.layer`. A harness that continues
 * a swarm as it opens may call the driver before this ran; that call waits for it.
 */
export const attach: Layer.Layer<never, never, ForkDriver | Harness.Harness> = Layer.effectDiscard(
	Effect.gen(function* () {
		const harness = yield* Harness.Harness;
		const waiting = Option.fromUndefinedOr(harnesses.get(yield* ForkDriver));
		// Another driver is none of this module's: it has no harness to wait for.
		if (Option.isSome(waiting)) yield* Deferred.succeed(waiting.value, harness);
	}),
);

// Keyed by the driver and held weakly: the service a product sees has only the port's operations.
const harnesses = new WeakMap<ForkDriverService, Deferred.Deferred<Harness.Open>>();

/** A complete copy of the document is stored after this many changes, which bounds what a reopen replays. */
const CHECKPOINT_EVERY = 64;

/**
 * One document per swarm id: under each job key, the conversation that is its fork. It is the lookup that finds a
 * fork again by its key, the list of a swarm's forks, and where a destroyed fork is marked, since Pi cannot delete a
 * conversation, with what it had written by then (`bytesWritten`, see `written`). Written in the commit that creates
 * the fork, so the key and the fork exist together or not at all.
 */
const Forks = Doc.family({
	kind: "swarm.forks",
	version: 1,
	scope: "session",
	schema: Schema.Record(
		Schema.String,
		Schema.Struct({
			conversationId: Schema.Number,
			destroyed: Schema.Boolean,
			bytesWritten: Schema.optionalKey(Schema.Number),
		}),
	),
	initial: () => ({}),
	checkpointWhen: (_stored, _ops, info) => info.deltasSinceBase >= CHECKPOINT_EVERY,
});

/** The fork a job key holds, as stored. */
interface Held {
	readonly conversationId: number;
	readonly destroyed: boolean;
	/** What the fork had written when it was destroyed; absent before that, and for one whose conversation is lost. */
	readonly bytesWritten?: number;
}

/** The job key has its fork already: what fails the creating commit of a second one. */
class Claimed extends Schema.TaggedError<Claimed>()("SwarmForkClaimed", {
	conversationId: Schema.Number,
	destroyed: Schema.Boolean,
}) {}

function make(harness: Deferred.Deferred<Harness.Open>): ForkDriverService {
	const attached = <A, E>(effect: Effect.Effect<A, E, Harness.Harness>): Effect.Effect<A, E> =>
		Effect.flatMap(Deferred.await(harness), (open) => Effect.provideService(effect, Harness.Harness, open));
	return {
		fork: (request) => attached(orGone("fork", fork(request))),
		run: (request) =>
			attached(
				orGone(
					"run",
					Effect.flatMap(conversationOf(request.fork), (conversation) =>
						Effect.as(
							conversation.submit({
								type: "input",
								content: request.prompt,
								requestId: request.requestId,
								// Pi brands ids in the type system only: the coordinator's task id is the number.
								notify: { taskId: request.notify.taskId as TaskId, key: request.notify.key },
							}),
							// Pi delivers its own signal in the commit that settles the submission: nothing is polled. The job
							// runs in the fork's conversation, in the storage of the swarm itself.
							{
								_tag: "Signal" as const,
								signal: SubmissionSettled.name,
								place: { conversationId: conversation.id, actorId: null },
							},
						),
					),
				),
			),
		job: (fork, requestId) =>
			attached(
				orGone(
					"job",
					Effect.flatMap(conversationOf(fork), (conversation) => jobStatus(conversation.id, requestId)),
				),
			),
		cancel: (fork) =>
			attached(
				orLater(
					"cancel",
					Effect.flatMap(Effect.option(conversationOf(fork)), (conversation) =>
						Option.match(conversation, { onNone: () => Effect.void, onSome: (found) => found.abort() }),
					),
				),
			),
		destroy: (fork) => attached(orLater("destroy", destroy(fork))),
		list: (swarmId) =>
			attached(
				orLater(
					"list",
					Effect.map(Harness.snapshot(Forks, swarmId), (forks) =>
						Object.entries(Option.getOrElse(forks, () => ({}))).flatMap(([jobKey, held]) =>
							held.destroyed ? [] : [toFork(swarmId, jobKey, held)],
						),
					),
				),
			),
	};
}

/**
 * Finds the fork of the job key, or forks the source for it in one commit that also claims the key and runs the
 * product's fork setup. The setup's `beforeStart` runs before the fork is answered, for a fork that was found too:
 * a call that was cut off after its commit is made again, and finds the fork.
 */
function fork(request: ForkRequest): Effect.Effect<Fork, ForkGone | Doc.Failure, Harness.Harness> {
	// Pi brands ids in the type system only: the ids of a request are the numbers.
	const sourceConversationId = request.sourceConversationId as ConversationId;
	const forked = (conversationId: ConversationId): Forked => ({
		swarmId: request.swarmId,
		jobKey: request.jobKey,
		sourceConversationId,
		conversationId,
	});
	const refused = (failure: ForkSetupFailed) => gone(request, "fork", failure.message);
	const found = (held: Held): Effect.Effect<Fork, ForkGone> =>
		held.destroyed
			? Effect.fail(gone(request, "fork", "It was destroyed"))
			: Effect.as(
					Effect.mapError(request.setup.beforeStart(forked(held.conversationId as ConversationId)), refused),
					toFork(request.swarmId, request.jobKey, held),
				);
	return Effect.gen(function* () {
		const held = yield* heldBy(request.swarmId, request.jobKey);
		if (Option.isSome(held)) return yield* found(held.value);
		const source = yield* Harness.conversation(sourceConversationId);
		if (Option.isNone(source)) return yield* gone(request, "source", "The conversation does not exist");
		return yield* source.value
			.fork({
				at: request.at as EntryId,
				// The coordinator owns its forks: Pi's abort of the task reaches their work.
				ownership: { kind: "task", taskId: request.coordinatorTaskId as TaskId },
				...(Option.isSome(request.agent) ? { agent: request.agent.value } : {}),
				// The key is claimed and the product has set the fork up, or the fork does not exist.
				init: (tx, conversationId) =>
					Effect.andThen(claim(tx, request, conversationId), request.setup.created(tx, forked(conversationId))),
			})
			.pipe(
				Effect.flatMap((made) => found({ conversationId: made.id, destroyed: false })),
				Effect.catchTags({
					// Another call claimed the key between the look above and this commit: its fork is the fork.
					SwarmForkClaimed: found,
					ForkSetupFailed: (failure) => Effect.fail(refused(failure)),
				}),
			);
	});
}

/** Claims the job key for the fork being created, inside its creating commit; fails it when the key is held. */
function claim(tx: Tx.Tx, request: ForkRequest, conversationId: ConversationId) {
	return Effect.gen(function* () {
		const forks = yield* tx.doc(Forks, request.swarmId, null);
		const current = yield* forks.get;
		const held = Option.fromUndefinedOr(Object.hasOwn(current, request.jobKey) ? current[request.jobKey] : undefined);
		if (Option.isSome(held)) return yield* new Claimed(held.value);
		yield* forks.set({ ...current, [request.jobKey]: { conversationId, destroyed: false } });
	});
}

/**
 * Pi 1.6.0 cannot delete or retire a conversation, so destroying a fork is: abort its work, background work too,
 * measure what it wrote (`written`), and mark it destroyed with that number, after which this driver never finds,
 * runs or lists it again. Its entries stay in the storage: nothing is freed. A second call answers the number the
 * first one stored; a fork the swarm never had, and one whose conversation is lost, answer none.
 */
function destroy(target: Fork): Effect.Effect<Destroyed, Doc.Failure, Harness.Harness> {
	return Effect.gen(function* () {
		const held = yield* heldBy(target.swarmId, target.jobKey);
		if (Option.isNone(held)) return { bytesWritten: Option.none() };
		if (held.value.destroyed) return { bytesWritten: Option.fromUndefinedOr(held.value.bytesWritten) };
		const conversation = yield* Harness.conversation(held.value.conversationId as ConversationId);
		// After the abort, so the number is final: nothing of the fork appends an entry any more.
		const bytesWritten = yield* Option.match(conversation, {
			onNone: () => Effect.succeedNone,
			onSome: (found) => Effect.andThen(found.abort({ background: true }), Effect.asSome(written(found))),
		});
		const marked: Held = {
			conversationId: held.value.conversationId,
			destroyed: true,
			...(Option.isSome(bytesWritten) ? { bytesWritten: bytesWritten.value } : {}),
		};
		yield* Harness.commit((tx) =>
			Effect.flatMap(tx.doc(Forks, target.swarmId, null), (forks) =>
				forks.update((current) => ({ ...current, [target.jobKey]: marked })),
			),
		);
		return { bytesWritten };
	});
}

/**
 * What a fork wrote, as far as Pi lets it be measured: the bytes of the UTF-8 JSON of every entry the fork's
 * conversation appended after its fork point, each entry as Pi's record of it (its id, kind, data and model
 * messages), summed.
 *
 * It is not the storage the fork took: documents, indexes, tasks, submissions and the storage's own framing are not
 * counted, and an entry's stored form need not be its JSON. It is one read of the fork's entries.
 */
function written(fork: Conversation.Conversation): Effect.Effect<number, Doc.Failure, Harness.Harness> {
	return Effect.gen(function* () {
		const parent = yield* fork.parent;
		const after = Option.match(parent, { onNone: () => 0, onSome: (origin) => origin.at });
		// Entry ids are integers, and Pi's brand on them is compile-time only: the id after the fork point.
		const own = fork.entries({ order: "ascending", minEntryId: (after + 1) as EntryId });
		return yield* Stream.runFold(
			own,
			() => 0,
			(bytes, entry) => bytes + UTF8.encode(JSON.stringify(entry)).length,
		);
	});
}

const UTF8 = new TextEncoder();

/** The conversation of a fork that exists and was not destroyed. */
function conversationOf(
	target: Fork,
): Effect.Effect<Conversation.Conversation, ForkGone | Doc.Failure, Harness.Harness> {
	return Effect.gen(function* () {
		const held = yield* heldBy(target.swarmId, target.jobKey);
		if (Option.isNone(held)) return yield* gone(target, "fork", "The swarm has no fork for the job");
		if (held.value.destroyed) return yield* gone(target, "fork", "It was destroyed");
		const conversation = yield* Harness.conversation(held.value.conversationId as ConversationId);
		if (Option.isNone(conversation)) return yield* gone(target, "fork", "Its conversation does not exist");
		return conversation.value;
	});
}

/** What the job key holds: one committed read, whatever the number of conversations. */
function heldBy(swarmId: string, jobKey: string): Effect.Effect<Option.Option<Held>, Doc.Failure, Harness.Harness> {
	return Effect.map(Harness.snapshot(Forks, swarmId), (forks) =>
		Option.flatMap(forks, (all) => Option.fromUndefinedOr(Object.hasOwn(all, jobKey) ? all[jobKey] : undefined)),
	);
}

function toFork(swarmId: string, jobKey: string, held: Held): Fork {
	return { swarmId, jobKey, forkId: String(held.conversationId) };
}

function gone(of: { readonly swarmId: string; readonly jobKey: string }, what: "source" | "fork", reason: string) {
	return new ForkGone({ what, swarmId: of.swarmId, jobKey: of.jobKey, reason });
}

/** The port's operations of one kind. */
type Operation = ForkRetryLater["operation"];

/**
 * A failed call into the harness is "retry later": the harness is closing or has failed, and a harness opened on the
 * storage later can do the same call.
 */
function orLater<A>(operation: Operation, effect: Effect.Effect<A, Doc.Failure, Harness.Harness>) {
	return Effect.mapError(effect, (error) => new ForkRetryLater({ operation, reason: error.message }));
}

/** As `orLater`, for an operation that may also find the fork or the source gone. */
function orGone<A>(operation: Operation, effect: Effect.Effect<A, ForkGone | Doc.Failure, Harness.Harness>) {
	return Effect.mapError(effect, (error) =>
		error._tag === "ForkGone" ? error : new ForkRetryLater({ operation, reason: error.message }),
	);
}
