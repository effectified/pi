// The caller's side of an actor that holds a harness: get or create one by key, call its actions, wait until it is
// idle, fork it and destroy it, as Effects with typed errors.

import { Clock, Context, Effect, Layer, Option, Predicate, Result, Schedule, Schema } from "effect";
import type { Registry, RegistryActors } from "rivetkit";
import { type ClientConfigInput, type ClientRaw, createClient, RivetError } from "rivetkit/client";
import type * as Action from "./action.ts";
import { Answer } from "./answer.ts";
import {
	ActionFailed,
	ActorDefect,
	ActorGone,
	type CallError,
	EngineUnavailable,
	ForkKeyHeld,
	ForkTooDeep,
	NotIdle,
} from "./errors.ts";
import type { Lineage } from "./fork.ts";
import * as Protocol from "./protocol.ts";
import * as Refusal from "./refusal.ts";

/**
 * Rivet's client, for what this module does not wrap. The service value is rivetkit's own object; the functions of
 * this module are the Effect way to use it.
 */
export class RivetClient extends Context.Service<RivetClient, ClientRaw>()(
	"@effectified/pi-durable-rivet/RivetClient",
) {}

/**
 * A client of the engine at `options.endpoint`, disposed with the scope. `options` are rivetkit's `createClient`
 * options, passed on unchanged: `endpoint`, `token`, `namespace` and the rest.
 *
 * rivetkit looks the engine up before the first request and tries again without end while it cannot be reached, so a
 * call waits then and does not fail: bound it with `Effect.timeout`. With `disableMetadataLookup: true` a request to
 * an engine that cannot be reached fails at once with a retryable `EngineUnavailable`.
 */
export function layer(options: ClientConfigInput): Layer.Layer<RivetClient> {
	return Layer.effect(
		RivetClient,
		Effect.acquireRelease(
			Effect.sync((): ClientRaw => createClient<Registry<RegistryActors>>(options)),
			(client) => Effect.promise(() => client.dispose()),
		),
	);
}

/** An actor's key, as Rivet takes it. */
export type Key = string | ReadonlyArray<string>;

/**
 * What this module needs of an actor's definition: the name it is registered under, and the actions to call. An
 * `Actor.Definition` is one. Inside an actor, where the actor's own definition is not a value, `Self.definition`
 * gives one.
 */
export interface Target<Name extends string = string, A = Readonly<Record<string, Action.Any>>> {
	readonly name: Name;
	readonly actions: A;
}

/**
 * One actor, named by its id: a call through a handle reaches that actor or fails with `ActorGone`, and never makes a
 * new one under the same key.
 */
export interface Handle<D extends Target = Target> {
	readonly definition: D;
	readonly actorId: string;
	readonly key: ReadonlyArray<string>;
}

/** `ActionFailed` with its `error` typed: the action's own failure, decoded with its error schema. */
export type ActionFailure<E> = ActionFailed & { readonly error: E };

/** The actor of `definition` under `key`, created empty when there is none. */
export function getOrCreate<D extends Target>(
	definition: D,
	key: Key,
): Effect.Effect<Handle<D>, EngineUnavailable, RivetClient> {
	return Effect.map(
		engine((client, signal) => client.getOrCreate(definition.name, keyOf(key), { signal }).resolve()),
		(actorId) => ({ definition, actorId, key: keyOf(key) }),
	);
}

/** The actor of `definition` under `key`, if there is one. It never creates one. */
export function find<D extends Target>(
	definition: D,
	key: Key,
): Effect.Effect<Option.Option<Handle<D>>, EngineUnavailable, RivetClient> {
	return engine((client, signal) => client.get(definition.name, keyOf(key), { signal }).resolve()).pipe(
		Effect.map((actorId) => Option.some({ definition, actorId, key: keyOf(key) })),
		Effect.catchIf(isCode(NOT_FOUND), () => Effect.succeedNone),
	);
}

/**
 * Calls the action `action` of the actor with `input`, both typed by the action's schemas. It fails with
 * `ActionFailed` carrying the action's own decoded error, with `ActorDefect` when the call failed inside the actor
 * otherwise, with `ActorGone` when the actor does not exist, and with `EngineUnavailable`.
 *
 * Interrupting the caller aborts the request. It cannot stop the action: once Rivet delivered the call, the handler
 * runs to its end inside the actor, and so does the Pi work it started.
 */
export function call<D extends Target, Name extends keyof D["actions"] & string>(
	handle: Handle<D>,
	action: Name,
	input: Action.Input<D["actions"][Name]>,
): Effect.Effect<
	Action.Output<D["actions"][Name]>,
	ActionFailure<Action.Failure<D["actions"][Name]>> | CallError,
	RivetClient
> {
	// The record of actions is typed by the definition, so the name finds an action.
	return invoke(handle, action, handle.definition.actions[action] as D["actions"][Name], input);
}

/** The live work of the actor's harness: how many tasks and submissions, and when Pi next needs the actor. */
export function status(handle: Handle): Effect.Effect<Protocol.Status, CallError, RivetClient> {
	return Effect.catchTag(invoke(handle, Protocol.STATUS, Protocol.status, null), "ActionFailed", Effect.die);
}

/**
 * Whether the harness has no live task and no unsettled submission. A parked call and a sleeping task are live work:
 * a harness that waits for an approval is not idle.
 */
export function isIdle(handle: Handle): Effect.Effect<boolean, CallError, RivetClient> {
	return Effect.map(status(handle), idle);
}

/** Options of `waitForIdle`. */
export interface WaitOptions {
	/**
	 * When to ask again while the harness is not idle. Default: after 100 milliseconds, then twice as long each time,
	 * up to 5 seconds, without end. A schedule that ends fails the wait with `NotIdle`.
	 */
	readonly schedule?: Schedule.Schedule<unknown>;
}

/**
 * Succeeds once the harness is idle (see `isIdle`). Rivet has no way to wait inside an actor without holding it awake,
 * so this asks, and asks again on `schedule`. While Pi has nothing that can run and its earliest sleep is ahead, the
 * next question waits for that time instead, so a parked harness is not woken, and kept awake, by the questions:
 * a signal that ends the park earlier is noticed at that time, not before.
 */
export function waitForIdle(
	handle: Handle,
	options?: WaitOptions,
): Effect.Effect<void, NotIdle | CallError, RivetClient> {
	const ask = Effect.gen(function* () {
		const now = yield* status(handle);
		if (idle(now)) return;
		if (!now.active && now.at !== null) yield* Effect.sleep(Math.max(0, now.at - (yield* Clock.currentTimeMillis)));
		return yield* notIdle(handle, now);
	});
	return Effect.retry(ask, {
		schedule: options?.schedule ?? DEFAULT_POLL,
		while: (error) => error._tag === "NotIdle",
	});
}

const DEFAULT_POLL = Schedule.min([Schedule.exponential("100 millis"), Schedule.spaced("5 seconds")]);

/** Where the actor came from: the forks behind it, and the input its own fork was made with. */
export function lineage(handle: Handle): Effect.Effect<Lineage, CallError, RivetClient> {
	return Effect.catchTag(invoke(handle, Protocol.LINEAGE, Protocol.lineage, null), "ActionFailed", Effect.die);
}

/** Options of `fork`. */
export interface ForkOptions {
	/** The key of the new actor: the idempotency key of the fork. */
	readonly key: Key;
	/** Given to the fork's hygiene and kept as its `Fork.lineage` input. */
	readonly input?: Schema.Json;
	/**
	 * How often to ask again while the engine refuses forks (`actor.fork_unavailable`, during an engine upgrade), after
	 * rivetkit's own five attempts. Default: five more, from 200 milliseconds, twice as long each time.
	 */
	readonly retry?: Schedule.Schedule<unknown>;
}

/**
 * Forks the actor `source` into a new actor under `options.key`, and gives its handle. The fork starts on a copy of
 * the source's storage, with nothing scheduled, and runs the definition's fork hygiene before its first call.
 *
 * - **Idempotent by key.** A key that already names a fork of `source` gives that fork, whatever the source does now:
 *   a retried fork never makes a second copy. A key another actor holds fails with `ForkKeyHeld`.
 * - **Only with nothing in flight.** It asks the source first and fails with `NotIdle` while the harness has an
 *   unsettled submission, or a live task that is not a background task of the product (`Status.background`): no
 *   input, model request or tool call is copied in flight. A background task of the product, such as a swarm's
 *   coordinator, does not refuse the fork, so a task can fork its own actor; the copy holds that task live, and the
 *   product's fork hygiene ends or adopts it. The question and the fork are two requests: nothing must start work in
 *   the source between them, or the copy inherits it.
 * - **Only so deep.** A source with as many forks behind it as the engine allows fails with `ForkTooDeep`.
 * - Interrupting the caller aborts the request; a fork the engine already accepted is still made, and the same key
 *   finds it.
 */
export function fork<D extends Target>(
	source: Handle<D>,
	options: ForkOptions,
): Effect.Effect<Handle<D>, NotIdle | ForkKeyHeld | ForkTooDeep | CallError, RivetClient> {
	const key = keyOf(options.key);
	const existing = Effect.flatMap(
		find(source.definition, key),
		Option.match({
			onNone: () => Effect.succeedNone,
			onSome: (held) =>
				Effect.flatMap(lineage(held), ({ chain }) =>
					chain.at(-1)?.actorId === source.actorId
						? Effect.succeedSome(held)
						: Effect.fail(new ForkKeyHeld({ actor: source.definition.name, key, heldBy: held.actorId })),
				),
		}),
	);
	const create: Effect.Effect<Handle<D>, NotIdle | ForkTooDeep | CallError, RivetClient> = Effect.gen(function* () {
		const now = yield* status(source);
		if (!forkable(now)) return yield* notIdle(source, now);
		const request = engine((client, signal) =>
			client
				.fork(source.definition.name, source.actorId, { key, input: options.input, signal })
				.then((forked) => forked.resolve()),
		);
		const actorId = yield* Effect.retry(request, {
			schedule: options.retry ?? DEFAULT_FORK_RETRY,
			while: (error) => error.code === FORK_UNAVAILABLE,
		});
		return { definition: source.definition, actorId, key };
	}).pipe(
		Effect.catchIf(isCode(NOT_FOUND), () => Effect.fail(gone(source))),
		Effect.catchIf(isCode(TOO_DEEP), ({ message: reason }) =>
			Effect.fail(new ForkTooDeep({ actor: source.definition.name, actorId: source.actorId, reason })),
		),
	);
	return Effect.gen(function* () {
		const before = yield* existing;
		if (Option.isSome(before)) return before.value;
		const created = yield* Effect.result(create);
		if (Result.isSuccess(created)) return created.success;
		if (!isCode(DUPLICATE_KEY)(created.failure)) return yield* created.failure;
		// Another caller forked under the same key meanwhile: its fork is the one this call was asked for.
		const raced = yield* existing;
		return Option.isSome(raced) ? raced.value : yield* created.failure;
	});
}

const DEFAULT_FORK_RETRY = Schedule.max([Schedule.exponential("200 millis"), Schedule.recurs(5)]);

/** What `destroy` answers. */
export interface Destroyed {
	/** False when there was no such actor any more: destroying twice is not an error. */
	readonly existed: boolean;
	/**
	 * The size of the actor's SQLite database when it was destroyed, its page count times its page size. Rivet 3.1.1
	 * reports no bytes written per actor, so this is the nearest an actor can say of itself; none when it could not
	 * be read, or the actor was gone.
	 */
	readonly databaseBytes: Option.Option<number>;
}

/** Destroys the actor and its storage. Idempotent: an actor that is gone already answers `existed: false`. */
export function destroy(handle: Handle): Effect.Effect<Destroyed, EngineUnavailable | ActorDefect, RivetClient> {
	return invoke(handle, Protocol.DESTROY, Protocol.destroy, null).pipe(
		Effect.map(({ databaseBytes }) => ({ existed: true, databaseBytes })),
		Effect.catchTag("ActorGone", () => Effect.succeed({ existed: false, databaseBytes: Option.none<number>() })),
		Effect.catchTag("ActionFailed", Effect.die),
	);
}

/** One action call: the input encoded, the request sent to the actor by its id, and the answer decoded. */
function invoke<A extends Action.Boundary<Action.Wire, Action.Wire, Action.Wire>>(
	handle: Handle,
	action: string,
	boundary: A,
	input: Action.Input<A>,
): Effect.Effect<Action.Output<A>, ActionFailure<Action.Failure<A>> | CallError, RivetClient> {
	const mismatch = (side: string) => (error: Schema.SchemaError) =>
		new ActorDefect({ action, message: `The ${side} does not match its schema: ${error.message}` });
	return Effect.gen(function* () {
		const client = yield* RivetClient;
		// An input the caller's own schema rejects is the caller's defect, not a failure of the call.
		const encoded = yield* Effect.orDie(boundary.encodeInput(input));
		const reply = yield* askedAgain(
			Effect.tryPromise({
				try: (signal) =>
					client
						.getForId(handle.definition.name, handle.actorId)
						.action({ name: action, args: [encoded], signal }),
				catch: (cause) => fromRivet(handle, action, cause),
			}),
		);
		// A trust boundary: the reply comes from the actor, whose code may be another version than the caller's.
		const answer = yield* Effect.mapError(decodeAnswer(reply), mismatch("answer"));
		switch (answer._tag) {
			case "success":
				// A decode boundary: the value was decoded with the action's own output schema.
				return (yield* Effect.mapError(
					boundary.decodeOutput(answer.value),
					mismatch("output"),
				)) as Action.Output<A>;
			case "failure": {
				const error = yield* Effect.mapError(boundary.decodeError(answer.error), mismatch("error"));
				// A decode boundary: the error was decoded with the action's own error schema.
				return yield* new ActionFailed({ action, error }) as ActionFailure<Action.Failure<A>>;
			}
			case "defect":
				return yield* new ActorDefect({ action, message: answer.message });
		}
	});
}

const decodeAnswer = Schema.decodeUnknownEffect(Answer);

/** One request to the engine that runs no action. */
function engine<A>(
	request: (client: ClientRaw, signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, EngineUnavailable, RivetClient> {
	return RivetClient.use((client) =>
		askedAgain(Effect.tryPromise({ try: (signal) => request(client, signal), catch: unavailable })),
	);
}

/**
 * `request`, sent again after the hinted time while the engine refuses it with a retry hint, at most
 * `Refusal.RETRIES` more times; the last refusal goes to the caller. Such a refusal says that the request was not
 * served: Rivet's storage answers it while an actor's volume changes hands (`depot.overloaded`, in a fork or around
 * a sleep). A hinted refusal of the actor's own (`actor.*`) is not sent again: it may come after an action began.
 */
function askedAgain<A, E, R>(request: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
	return Effect.retry(request, HINTED);
}

const HINTED = Refusal.honouringHint(hintOf);

/** The retry hint of a refusal that says the request was not served; undefined for every other failure. */
function hintOf(error: unknown): number | undefined {
	return error instanceof EngineUnavailable && !error.code.startsWith("actor.") ? error.retryAfterMillis : undefined;
}

const NOT_FOUND = "actor.not_found";

const DUPLICATE_KEY = "actor.duplicate_key";

const TOO_DEEP = "actor.fork_too_deep";

const FORK_UNAVAILABLE = "actor.fork_unavailable";

/** What a rejected action call failed with. */
function fromRivet(handle: Handle, action: string, cause: unknown): CallError {
	if (!(cause instanceof RivetError)) return unavailable(cause);
	if (cause.group === "actor" && (cause.code === "not_found" || cause.code.startsWith("destroyed"))) {
		return gone(handle);
	}
	// The actor answered an error of Rivet's own, such as its action timeout.
	if (cause.group === "actor" && Refusal.retryAfterMillis(cause) === undefined) {
		return new ActorDefect({ action, message: `${cause.group}.${cause.code}: ${cause.message}` });
	}
	return unavailable(cause);
}

/**
 * What a request the engine did not serve failed with. Anything but a `RivetError` is a transport failure, which is
 * worth trying again; so is a refusal the engine gave a retry hint for, and a refused fork.
 */
function unavailable(cause: unknown): EngineUnavailable {
	if (!(cause instanceof RivetError)) {
		const message = Predicate.isError(cause) ? cause.message : String(cause);
		return new EngineUnavailable({ code: "transport", message, retryable: true });
	}
	const code = `${cause.group}.${cause.code}`;
	const retryAfterMillis = Refusal.retryAfterMillis(cause);
	return new EngineUnavailable({
		code,
		message: cause.message,
		retryable: retryAfterMillis !== undefined || code === FORK_UNAVAILABLE,
		...(retryAfterMillis === undefined ? {} : { retryAfterMillis }),
	});
}

/** Whether a failure is the engine's refusal with this `group.code`. */
function isCode(code: string): (error: { readonly _tag: string }) => error is EngineUnavailable {
	return (error): error is EngineUnavailable => error instanceof EngineUnavailable && error.code === code;
}

function gone(handle: Handle): ActorGone {
	return new ActorGone({ actor: handle.definition.name, actorId: handle.actorId });
}

function idle(status: Protocol.Status): boolean {
	return status.tasks === 0 && status.submissions === 0;
}

/**
 * Whether a fork would copy nothing in flight: no unsettled submission, and no live task but background tasks of the
 * product. Pi's generations and tool calls are never background, and its background compaction is not counted as
 * one, so every model request, tool call and input refuses the fork.
 */
function forkable(status: Protocol.Status): boolean {
	return status.submissions === 0 && status.tasks === status.background;
}

function notIdle(handle: Handle, status: Protocol.Status): NotIdle {
	return new NotIdle({ actorId: handle.actorId, tasks: status.tasks, submissions: status.submissions });
}

/** Rivet takes a key as a new array of strings. */
function keyOf(key: Key): string[] {
	return typeof key === "string" ? [key] : [...key];
}
