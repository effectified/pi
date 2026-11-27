// The Rivet fork driver: a swarm's forks are actor forks of the actor that holds the primed harness, each a
// copy-on-write copy of its storage with a harness of its own.

import type { ConversationId } from "@effectified/pi-durable";
import {
	type ActorDefect,
	type ActorGone,
	ActorId,
	type ActorInfo,
	type ActorSql,
	Client,
	type EngineUnavailable,
	type ForkKeyHeld,
	type ForkTooDeep,
	type NotIdle,
	Self,
} from "@effectified/pi-durable-rivet";
import { Array as Arr, type Context, Effect, Layer, Match, Option, Schema } from "effect";
import {
	type Destroyed,
	type Fork,
	ForkDriver,
	type ForkDriverService,
	ForkFailure,
	ForkGone,
	type ForkRequest,
	ForkRetryLater,
	Millis,
	Notice,
} from "../driver.ts";
import { ForkId, JobKey, SwarmId } from "../ids.ts";
import { actions } from "./actions.ts";
import * as Assignment from "./assignment.ts";
import type { JobRefused } from "./job.ts";
import * as Records from "./records.ts";

/** Options of `layer`. */
export const Options = Schema.Struct({
	/**
	 * How often the coordinator asks a fork whether its job has settled, in milliseconds, 0 or more. Default 1000.
	 * Between two questions the coordinator sleeps, and the source actor may sleep with it: the Rivet host wakes it at
	 * the time.
	 */
	pollMillis: Schema.optionalKey(Millis),
});

/** Options of `layer`. */
export type Options = typeof Options.Type;

/** What the driver needs of the actor it runs in: the engine's client, the actor's identity and its database. */
export type Needs = Client.RivetClient | ActorInfo | ActorSql;

/**
 * The `ForkDriver` for the actor that holds the primed harness: build it in that actor's `layer`, over the host's
 * `Self.client`, Rivet's client of the engine the actor runs on. The actor's definition must have `actions` among its
 * actions and `forkHygiene` in its fork hygiene, and its `layer` must provide the product's `ForkSetup`, since every
 * fork is an actor of the same definition and runs the setup itself.
 *
 * - **fork**: an actor fork of this actor under the key `forkKey(own key, swarm id, job key)`, found again by that
 *   key. The intent is recorded in the actor's database before the engine is asked. "Retry later", marked
 *   `sourceBusy`, while this actor has an input, a model request or a tool call in flight: the coordinator waits
 *   that out, however long it takes. The request's `setup` is left: the fork actor runs its own.
 * - **run**: the fork's `swarmRun` action, which answers at durable acceptance. The answer is always `Poll`: nothing
 *   is called back, so nothing can be lost, and the coordinator sleeps between two questions. Its `place` is the
 *   job conversation in the fork actor, and that actor.
 * - **job**, **cancel**: the fork's `swarmJob` and `swarmCancel` actions.
 * - **destroy**: `Client.destroy`. `bytesWritten` is the size of the fork's database when it was destroyed less the
 *   size of this actor's database when the fork was first asked for, never below zero; none when either is unknown.
 * - **list**: the recorded forks that were not destroyed. One whose fork call never returned is looked up by its key.
 *
 * A call the engine does not answer in 30 seconds, an engine that cannot be reached and a failure inside an actor
 * are "retry later"; an actor that is gone, a key another actor holds and a refusal without a retry hint are "gone".
 * In an actor fork in which `forkHygiene` did not run, every operation is refused: the record it would work from is
 * its source's. Options off their schema, such as a negative `pollMillis`, fail the build with the `SchemaError`
 * before anything is read or asked: a fork must never accept a job whose answer the driver cannot give.
 */
export function layer(options: Options = {}): Layer.Layer<ForkDriver, Schema.SchemaError, Needs> {
	return Layer.effect(
		ForkDriver,
		Effect.gen(function* () {
			const { pollMillis = DEFAULT_POLL_MILLIS } = yield* decodeOptions(options);
			// The record's tables, at each wake: a database that cannot be written now is a harness that did not open.
			yield* Effect.orDie(Records.migrate);
			const self = yield* Self.handle(actions);
			const context = yield* Effect.context<Needs>();
			return make(self, context, pollMillis);
		}),
	);
}

// The options are the caller's code, typed as numbers: the schema holds what the types cannot say.
const decodeOptions = Schema.decodeUnknownEffect(Options);

const DEFAULT_POLL_MILLIS = 1000;

// rivetkit's client waits without end for an engine it cannot reach: a call that takes longer is asked again.
const CALL_TIMEOUT_MILLIS = 30_000;

/** The actor the driver runs in, as a caller of the fork actions: every fork is an actor of its definition. */
type Own = Client.Handle<Client.Target<string, typeof actions>>;

/** The port's operations for the actor `self`, run on its services `context`. */
function make(self: Own, context: Context.Context<Needs>, pollMillis: number): ForkDriverService {
	const { definition } = self;
	const keyOf = (swarmId: SwarmId, jobKey: JobKey) => Assignment.forkKey(self.key, swarmId, jobKey);
	const handleOf = (fork: Fork): Own => ({
		definition,
		actorId: ActorId.make(fork.forkId),
		key: keyOf(fork.swarmId, fork.jobKey),
	});
	/**
	 * One operation: refused in a fork whose hygiene did not run, on this actor's services, bounded in time, and
	 * failing as the port says, by `failure`.
	 */
	const bounded = <A, E extends ForkFailure>(
		operation: Operation,
		failure: (error: Failure) => E,
		effect: Effect.Effect<A, Failure, Needs>,
	): Effect.Effect<A, E | ForkRetryLater> =>
		Effect.andThen(Records.requireClean, effect).pipe(
			Effect.mapError(failure),
			Effect.provideContext(context),
			Effect.timeoutOrElse({
				duration: CALL_TIMEOUT_MILLIS,
				orElse: () =>
					Effect.fail(ForkRetryLater.make({ operation, reason: `No answer in ${CALL_TIMEOUT_MILLIS} ms` })),
			}),
		);

	/** Finds the recorded fork of the job, or records the intent and asks the engine for it. */
	const fork = Effect.fn("Swarm.Rivet.fork")(function* (request: ForkRequest) {
		const held = yield* Records.find(request.swarmId, request.jobKey);
		const known = yield* Option.match(held, {
			// No record: the intent is written before the engine is asked, so a call that never returns is found.
			onNone: () => Effect.as(Records.intend(request.swarmId, request.jobKey), Option.none<Fork>()),
			onSome: (record) =>
				Records.Held.match(record, {
					Destroyed: () => Effect.fail(WasDestroyed.make({})),
					Made: ({ actorId }) => Effect.succeedSome(toFork(request, actorId)),
					// The call of an earlier attempt never returned: the same key finds its fork, or makes it now.
					Intended: () => Effect.succeedNone,
				}),
		});
		if (Option.isSome(known)) return known.value;
		const made = yield* Client.fork(self, {
			key: keyOf(request.swarmId, request.jobKey),
			input: Assignment.of(request),
		});
		yield* Records.made(request.swarmId, request.jobKey, made.actorId);
		return toFork(request, made.actorId);
	});

	/** The actor of a fork whose call never returned, if the engine made it: it is this actor's fork under the key. */
	const adopt = Effect.fn("Swarm.Rivet.adopt")(function* (swarmId: SwarmId, jobKey: JobKey) {
		const found = yield* Client.find(definition, keyOf(swarmId, jobKey));
		if (Option.isNone(found)) return Option.none<Fork>();
		const lineage = yield* Client.lineage(found.value).pipe(
			Effect.asSome,
			Effect.catchTag("ActorGone", () => Effect.succeedNone),
		);
		// Another actor's fork under this key, or an actor destroyed meanwhile, is not a fork of this swarm.
		const forkedHere = Option.exists(lineage, ({ chain }) =>
			Option.exists(Arr.last(chain), (link) => link.actorId === self.actorId),
		);
		if (!forkedHere) return Option.none<Fork>();
		yield* Records.made(swarmId, jobKey, found.value.actorId);
		return Option.some(toFork({ swarmId, jobKey }, found.value.actorId));
	});

	/** Destroys the fork's actor and records it destroyed, with the growth of its database over its source's. */
	const destroy = Effect.fn("Swarm.Rivet.destroy")(function* (
		target: Fork,
	): Effect.fn.Return<Destroyed, Failure, Needs> {
		const recorded = yield* Records.find(target.swarmId, target.jobKey);
		const held = Option.getOrElse(recorded, () => UNRECORDED);
		// Destroyed already: the bytes the first call learnt are the answer again.
		if (held._tag === "Destroyed") return { bytesWritten: held.bytesWritten };
		const destroyed = yield* Client.destroy(handleOf(target));
		const bytesWritten = Option.zipWith(destroyed.databaseBytes, held.baseBytes, (size, before) =>
			Math.max(0, size - before),
		);
		yield* Records.destroyed(target.swarmId, target.jobKey, bytesWritten);
		return { bytesWritten };
	});

	/**
	 * The recorded forks; the ones whose call never returned are looked up by their keys, one at a time. The port's
	 * `list` does not know the swarm's cap, and intents pile up past it: one per job whose fork call a crash cut off,
	 * also in a swarm of cap one. Each lookup is two calls of the engine and a write of the record.
	 */
	const list = Effect.fn("Swarm.Rivet.list")(function* (swarmId: SwarmId) {
		const live = yield* Records.live(swarmId);
		const forks = yield* Effect.forEach(
			live,
			({ jobKey, held }) =>
				Records.LiveHeld.match(held, {
					Made: ({ actorId }) => Effect.succeedSome(toFork({ swarmId, jobKey }, actorId)),
					Intended: () => adopt(swarmId, jobKey),
				}),
			{ concurrency: 1 },
		);
		return Arr.getSomes(forks);
	});

	return {
		fork: (request) => bounded("fork", portFailure("fork", request, "source"), fork(request)),
		run: (request) =>
			bounded(
				"run",
				portFailure("run", request.fork, "fork"),
				Effect.map(
					Client.call(handleOf(request.fork), "swarmRun", {
						swarmId: request.fork.swarmId,
						jobKey: request.fork.jobKey,
						requestId: request.requestId,
						prompt: request.prompt,
					}),
					// Nothing is called back: the coordinator asks. The job runs in the fork actor, in the conversation it made.
					({ conversationId }) => notice(request.fork, conversationId, pollMillis),
				),
			),
		job: (target, requestId) =>
			bounded("job", portFailure("job", target, "fork"), Client.call(handleOf(target), "swarmJob", { requestId })),
		cancel: (target) =>
			bounded(
				"cancel",
				retryLater("cancel"),
				// A fork that is gone is cancelled already.
				Effect.catchTag(
					Effect.asVoid(Client.call(handleOf(target), "swarmCancel", null)),
					"ActorGone",
					() => Effect.void,
				),
			),
		destroy: (target) => bounded("destroy", retryLater("destroy"), destroy(target)),
		list: (swarmId) => bounded("list", retryLater("list"), list(swarmId)),
	};
}

/** What `run` answers: poll the fork, which runs the job in its conversation `conversationId`. */
function notice(fork: Fork, conversationId: ConversationId, pollMillis: number): Notice {
	return Notice.cases.Poll.make({ afterMillis: pollMillis, place: { conversationId, actorId: fork.forkId } });
}

/** The job's fork was destroyed through this driver: its key never gives a fork again. */
class WasDestroyed extends Schema.TaggedError<WasDestroyed, { readonly brand: unique symbol }>()(
	"SwarmForkDestroyed",
	{},
) {}

/** The port's operations of one kind. */
type Operation = ForkRetryLater["operation"];

/** What a call of the host, of a fork's action or of the record fails with, before the port's two failures. */
type Failure =
	| NotIdle
	| ForkKeyHeld
	| ForkTooDeep
	| ActorGone
	| EngineUnavailable
	| ActorDefect
	| Client.ActionFailure<JobRefused>
	| Records.RecordFailure
	| Records.Unclean
	| WasDestroyed;

/** The job a failure is about. */
interface Subject {
	readonly swarmId: SwarmId;
	readonly jobKey: JobKey;
}

/**
 * A failure as the port's "retry later" or "gone". `missing` is what an actor that does not exist, or that the engine
 * refuses for good, stands for in this operation: the source being forked, or the fork being called.
 */
function portFailure(operation: Operation, subject: Subject, missing: "source" | "fork") {
	return (error: Failure): ForkFailure =>
		Match.valueTags(error, {
			// The source has work in flight: nothing is wrong with the engine, and the coordinator waits it out.
			NotIdle: (busy) => ForkRetryLater.make({ operation, reason: busy.message, sourceBusy: true }),
			ActorDefect: (defect) => ForkRetryLater.make({ operation, reason: defect.message }),
			SwarmRecordFailure: (failure) => ForkRetryLater.make({ operation, reason: failure.reason }),
			SwarmForkDestroyed: () => gone(subject, "fork", "It was destroyed"),
			// This actor, which would be the source of every fork it makes, can never be one.
			SwarmForkUnclean: (unclean) => gone(subject, "source", unclean.message),
			ForkKeyHeld: (held) => gone(subject, "fork", held.message),
			ForkTooDeep: (deep) => gone(subject, "depth", deep.message),
			ActorGone: (actor) => gone(subject, missing, actor.message),
			ActionFailed: (failed) => gone(subject, failed.error.what, failed.error.reason),
			EngineUnavailable: (engine): ForkFailure => {
				const reason = `${engine.code}: ${engine.message}`;
				if (!engine.retryable) return gone(subject, missing, reason);
				const hint = engine.retryAfterMillis === undefined ? {} : { afterMillis: engine.retryAfterMillis };
				return ForkRetryLater.make({ operation, reason, ...hint });
			},
		});
}

// Only the reason of a "gone" is kept by `retryLater`, so the job it would name does not matter.
const NO_SUBJECT: Subject = { swarmId: SwarmId.make(""), jobKey: JobKey.make("") };

/**
 * A failure of an operation the port lets fail with "retry later" only, whatever it is: the coordinator bounds its
 * attempts, and leaves a fork it could not destroy.
 */
function retryLater(operation: Operation) {
	const classify = portFailure(operation, NO_SUBJECT, "fork");
	return (error: Failure): ForkRetryLater =>
		ForkFailure.match(classify(error), {
			ForkGone: (gone) => ForkRetryLater.make({ operation, reason: gone.reason }),
			ForkRetryLater: (later) => later,
		});
}

/** A fork this actor has no record of, such as one a copy of the actor was told to destroy: no size to subtract. */
const UNRECORDED: Records.Held = Records.Held.cases.Intended.make({ baseBytes: Option.none() });

function toFork(subject: Subject, actorId: ActorId): Fork {
	return { swarmId: subject.swarmId, jobKey: subject.jobKey, forkId: ForkId.make(actorId) };
}

function gone(subject: Subject, what: ForkGone["what"], reason: string): ForkGone {
	return ForkGone.make({ what, swarmId: subject.swarmId, jobKey: subject.jobKey, reason });
}
