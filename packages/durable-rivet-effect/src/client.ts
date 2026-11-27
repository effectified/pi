// The caller's side of an actor that holds a harness: get or create one by key, call its actions, wait until it is
// idle, fork it and destroy it, as Effects with typed errors.

import type { StrictOmit } from "@effectified/pi-ai";
import {
	Array as Arr,
	Clock,
	Config,
	Context,
	Effect,
	Layer,
	Option,
	Predicate,
	Redacted,
	Result,
	Schedule,
	Schema,
	String as Str,
} from "effect";
import { dual } from "effect/Function";
import type { Registry, RegistryActors } from "rivetkit";
import { type ClientConfigInput, type ClientRaw, createClient, RivetError } from "rivetkit/client";
import type * as Action from "./action.ts";
import { Answer } from "./answer.ts";
import {
	ActionFailed,
	ActorDefect,
	ActorGone,
	CallError,
	EngineUnavailable,
	ForkKeyHeld,
	ForkTooDeep,
	HostError,
	NotIdle,
} from "./errors.ts";
import type { Lineage } from "./fork.ts";
import { ActorId, type ActorKey } from "./ids.ts";
import * as Protocol from "./protocol.ts";
import * as Refusal from "./refusal.ts";

/**
 * Rivet's client, for what this module does not wrap. The service value is rivetkit's own object; the functions of
 * this module are the Effect way to use it.
 */
export class RivetClient extends Context.Service<RivetClient, ClientRaw>()(
	"@effectified/pi-durable-rivet/client/RivetClient",
) {}

/**
 * Options of `layer`: rivetkit's `createClient` options (`endpoint`, `namespace`, `poolName` and the rest), passed on
 * unchanged, but for the engine's token, which is a secret: `Redacted`, or an Effect that fetches one.
 */
export interface ClientOptions<R = never> extends StrictOmit<ClientConfigInput, "token" | "getToken"> {
	/** The engine's token, sent with every request and shown in no log or error. */
	readonly token?: Redacted.Redacted<string>;
	/** Fetches the token when rivetkit needs one, in place of `token`: `forceRefresh` after the engine refused it. */
	readonly getToken?: (options: {
		readonly forceRefresh: boolean;
	}) => Effect.Effect<Redacted.Redacted<string>, never, R>;
}

/**
 * A client of the engine at `options.endpoint`, disposed with the scope.
 *
 * rivetkit looks the engine up before the first request and tries again without end while it cannot be reached, so a
 * call waits then and does not fail: bound it with `Effect.timeout`. With `disableMetadataLookup: true` a request to
 * an engine that cannot be reached fails at once with a retryable `EngineUnavailable`.
 */
export function layer<R = never>(options: ClientOptions<R>): Layer.Layer<RivetClient, never, R> {
	return Layer.effect(RivetClient, connect(options));
}

/** Rivet's client with `options`, disposed with the scope; `getToken` runs on the services of the caller's context. */
const connect = Effect.fnUntraced(function* <R>(options: ClientOptions<R>) {
	const { token, getToken, ...rest } = options;
	const context = yield* Effect.context<R>();
	const run = Effect.runPromiseWith(context);
	// The token leaves `Redacted` here, where rivetkit sends it.
	const secrets: Pick<ClientConfigInput, "token" | "getToken"> = {
		...(token === undefined ? {} : { token: Redacted.value(token) }),
		...(getToken === undefined ? {} : { getToken: (asked) => run(Effect.map(getToken(asked), Redacted.value)) }),
	};
	return yield* Effect.acquireRelease(
		Effect.sync((): ClientRaw => createClient<Registry<RegistryActors>>({ ...rest, ...secrets })),
		(client) => Effect.promise(() => client.dispose()),
	);
});

/**
 * A client of the engine the environment names, read as `Config` through the `ConfigProvider`: `RIVET_ENDPOINT`,
 * `RIVET_TOKEN` (a secret) and `RIVET_NAMESPACE`, each optional, the variables rivetkit reads itself. `options` are
 * the rest of `layer`'s.
 */
export function layerConfig(
	options: StrictOmit<ClientOptions, "endpoint" | "token" | "namespace"> = {},
): Layer.Layer<RivetClient, Config.ConfigError> {
	return Layer.unwrap(
		Effect.gen(function* () {
			const endpoint = yield* Config.option(Config.String("RIVET_ENDPOINT"));
			const token = yield* Config.option(Config.Redacted("RIVET_TOKEN"));
			const namespace = yield* Config.option(Config.String("RIVET_NAMESPACE"));
			return layer({
				...options,
				...Option.match(endpoint, { onNone: () => ({}), onSome: (value) => ({ endpoint: value }) }),
				...Option.match(token, { onNone: () => ({}), onSome: (value) => ({ token: value }) }),
				...Option.match(namespace, { onNone: () => ({}), onSome: (value) => ({ namespace: value }) }),
			});
		}),
	);
}

/** An actor's key, as Rivet takes it: one string, or several. */
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
	readonly actorId: ActorId;
	readonly key: ActorKey;
}

/** `ActionFailed` with its `error` typed: the action's own failure, decoded with its error schema. */
export type ActionFailure<E> = ActionFailed & { readonly error: E };

/** The actor of `definition` under `key`, created empty when there is none. */
export const getOrCreate: <D extends Target>(
	definition: D,
	key: Key,
) => Effect.Effect<Handle<D>, EngineUnavailable, RivetClient> = Effect.fn("Client.getOrCreate")(function* <
	D extends Target,
>(definition: D, key: Key) {
	const keys = keyOf(key);
	const actorId = yield* engine((client, signal) => client.getOrCreate(definition.name, keys, { signal }).resolve());
	return { definition, actorId: ActorId.make(actorId), key: keys };
});

/** The actor of `definition` under `key`, if there is one. It never creates one. */
export const find: <D extends Target>(
	definition: D,
	key: Key,
) => Effect.Effect<Option.Option<Handle<D>>, EngineUnavailable, RivetClient> = Effect.fn("Client.find")(function* <
	D extends Target,
>(definition: D, key: Key) {
	const keys = keyOf(key);
	const found = yield* engine((client, signal) => client.get(definition.name, keys, { signal }).resolve()).pipe(
		Effect.asSome,
		Effect.catchIf(isCode(NOT_FOUND), () => Effect.succeedNone),
	);
	return Option.map(found, (actorId) => ({ definition, actorId: ActorId.make(actorId), key: keys }));
});

/**
 * Calls the action `action` of the actor with `input`, both typed by the action's schemas. It fails with
 * `ActionFailed` carrying the action's own decoded error, with `ActorDefect` when the call failed inside the actor
 * otherwise, with `ActorGone` when the actor does not exist, and with `EngineUnavailable`. Data-first only: the
 * handle's definition types the action's name and input.
 *
 * Interrupting the caller aborts the request. It cannot stop the action: once Rivet delivered the call, the handler
 * runs to its end inside the actor, and so does the Pi work it started.
 */
export const call: <D extends Target, Name extends keyof D["actions"] & string>(
	handle: Handle<D>,
	action: Name,
	input: Action.Input<D["actions"][Name]>,
) => Effect.Effect<
	Action.Output<D["actions"][Name]>,
	ActionFailure<Action.Failure<D["actions"][Name]>> | CallError,
	RivetClient
> = Effect.fn("Client.call")(function* <D extends Target, Name extends keyof D["actions"] & string>(
	handle: Handle<D>,
	action: Name,
	input: Action.Input<D["actions"][Name]>,
) {
	// The record of actions is typed by the definition, so the name finds an action.
	return yield* invoke(handle, action, handle.definition.actions[action] as D["actions"][Name], input);
});

/** The live work of the actor's harness: how many tasks and submissions, and when Pi next needs the actor. */
export const status: (handle: Handle) => Effect.Effect<Protocol.Status, CallError, RivetClient> = Effect.fn(
	"Client.status",
)(function* (handle: Handle) {
	// The status action has no error of its own.
	return yield* Effect.catchTag(invoke(handle, Protocol.STATUS, Protocol.status, null), "ActionFailed", Effect.die);
});

/**
 * Whether the harness has no live task and no unsettled submission. A parked call and a sleeping task are live work:
 * a harness that waits for an approval is not idle.
 */
export const isIdle: (handle: Handle) => Effect.Effect<boolean, CallError, RivetClient> = Effect.fn("Client.isIdle")(
	function* (handle: Handle) {
		const now = yield* status(handle);
		return idle(now);
	},
);

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
 * a signal that ends the park earlier is noticed at that time, not before. Data-first, or data-last in a pipe:
 * `handle.pipe(Client.waitForIdle({ schedule }))`.
 */
export const waitForIdle: {
	(options?: WaitOptions): (handle: Handle) => Effect.Effect<void, NotIdle | CallError, RivetClient>;
	(handle: Handle, options?: WaitOptions): Effect.Effect<void, NotIdle | CallError, RivetClient>;
} = dual(
	// A handle has an actor id; the options never do.
	(args) => Predicate.hasProperty(args[0], "actorId"),
	Effect.fn("Client.waitForIdle")(function* (handle: Handle, options?: WaitOptions) {
		const ask = Effect.gen(function* () {
			const now = yield* status(handle);
			if (idle(now)) return;
			if (!now.active && now.at !== null) {
				const clock = yield* Clock.currentTimeMillis;
				yield* Effect.sleep(Math.max(0, now.at - clock));
			}
			return yield* notIdle(handle, now);
		});
		return yield* Effect.retry(ask, {
			schedule: options?.schedule ?? DEFAULT_POLL,
			while: HostError.guards.NotIdle,
		});
	}),
);

const DEFAULT_POLL = Schedule.min([Schedule.exponential("100 millis"), Schedule.spaced("5 seconds")]);

/** Where the actor came from: the forks behind it, and the input its own fork was made with. */
export const lineage: (handle: Handle) => Effect.Effect<Lineage, CallError, RivetClient> = Effect.fn("Client.lineage")(
	function* (handle: Handle) {
		// The lineage action has no error of its own.
		return yield* Effect.catchTag(
			invoke(handle, Protocol.LINEAGE, Protocol.lineage, null),
			"ActionFailed",
			Effect.die,
		);
	},
);

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
 * Data-first, or data-last in a pipe: `source.pipe(Client.fork({ key }))`.
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
export const fork: {
	(
		options: ForkOptions,
	): <D extends Target>(
		source: Handle<D>,
	) => Effect.Effect<Handle<D>, NotIdle | ForkKeyHeld | ForkTooDeep | CallError, RivetClient>;
	<D extends Target>(
		source: Handle<D>,
		options: ForkOptions,
	): Effect.Effect<Handle<D>, NotIdle | ForkKeyHeld | ForkTooDeep | CallError, RivetClient>;
} = dual(
	2,
	Effect.fn("Client.fork")(function* <D extends Target>(source: Handle<D>, options: ForkOptions) {
		const key = keyOf(options.key);
		const before = yield* forkUnder(source, key);
		if (Option.isSome(before)) return before.value;
		const created = yield* Effect.result(copy(source, key, options));
		if (Result.isSuccess(created)) return created.success;
		if (!isCode(DUPLICATE_KEY)(created.failure)) return yield* created.failure;
		// Another caller forked under the same key meanwhile: its fork is the one this call was asked for.
		const raced = yield* forkUnder(source, key);
		return Option.isSome(raced) ? raced.value : yield* created.failure;
	}),
);

/** The fork of `source` that holds `key`, if there is one; `ForkKeyHeld` when another actor holds it. */
const forkUnder = Effect.fnUntraced(function* <D extends Target>(source: Handle<D>, key: ActorKey) {
	const held = yield* find(source.definition, key);
	if (Option.isNone(held)) return Option.none<Handle<D>>();
	const { chain } = yield* lineage(held.value);
	if (Option.exists(Arr.last(chain), (link) => link.actorId === source.actorId)) return held;
	return yield* ForkKeyHeld.make({ actor: source.definition.name, key, heldBy: held.value.actorId });
});

/** A new fork of `source` under `key`, once the source has nothing in flight. */
const copy = Effect.fnUntraced(
	function* <D extends Target>(source: Handle<D>, key: ActorKey, options: ForkOptions) {
		const now = yield* status(source);
		if (!forkable(now)) return yield* notIdle(source, now);
		const request = engine((client, signal) =>
			client
				.fork(source.definition.name, source.actorId, { key: [...key], input: options.input, signal })
				.then((forked) => forked.resolve()),
		);
		const actorId = yield* Effect.retry(request, {
			schedule: options.retry ?? DEFAULT_FORK_RETRY,
			while: (error) => error.code === FORK_UNAVAILABLE,
		});
		return { definition: source.definition, actorId: ActorId.make(actorId), key };
	},
	(effect, source) =>
		effect.pipe(
			Effect.catchIf(isCode(NOT_FOUND), () => Effect.fail(gone(source))),
			Effect.catchIf(isCode(TOO_DEEP), ({ message: reason }) =>
				Effect.fail(ForkTooDeep.make({ actor: source.definition.name, actorId: source.actorId, reason })),
			),
		),
);

const DEFAULT_FORK_RETRY = Schedule.max([Schedule.exponential("200 millis"), Schedule.recurs(5)]);

/** What `destroy` answers. */
export const Destroyed = Schema.Struct({
	/** False when there was no such actor any more: destroying twice is not an error. */
	existed: Schema.Boolean,
	/**
	 * The size of the actor's SQLite database when it was destroyed, its page count times its page size. Rivet 3.1.1
	 * reports no bytes written per actor, so this is the nearest an actor can say of itself; none when it could not
	 * be read, or the actor was gone.
	 */
	databaseBytes: Protocol.Destroyed.fields.databaseBytes,
});

/** What `destroy` answers. */
export type Destroyed = typeof Destroyed.Type;

/** Destroys the actor and its storage. Idempotent: an actor that is gone already answers `existed: false`. */
export const destroy: (handle: Handle) => Effect.Effect<Destroyed, EngineUnavailable | ActorDefect, RivetClient> =
	Effect.fn("Client.destroy")(function* (handle: Handle) {
		return yield* invoke(handle, Protocol.DESTROY, Protocol.destroy, null).pipe(
			Effect.map(({ databaseBytes }): Destroyed => ({ existed: true, databaseBytes })),
			Effect.catchTags({
				ActorGone: () => Effect.succeed<Destroyed>({ existed: false, databaseBytes: Option.none() }),
				// The destroy action has no error of its own.
				ActionFailed: Effect.die,
			}),
		);
	});

/** One action call: the input encoded, the request sent to the actor by its id, and the answer decoded. */
const invoke = Effect.fnUntraced(function* <A extends Action.Boundary<Action.Wire, Action.Wire, Action.Wire>>(
	handle: Handle,
	action: string,
	boundary: A,
	input: Action.Input<A>,
): Effect.fn.Return<Action.Output<A>, ActionFailure<Action.Failure<A>> | CallError, RivetClient> {
	yield* Effect.annotateCurrentSpan({ actor: handle.definition.name, actorId: handle.actorId, action });
	const mismatch = (side: string) => (error: Schema.SchemaError) =>
		ActorDefect.make({ action, message: `The ${side} does not match its schema: ${error.message}` });
	const client = yield* RivetClient;
	// An input the caller's own schema rejects is the caller's defect, not a failure of the call.
	const encoded = yield* Effect.orDie(boundary.encodeInput(input));
	const reply = yield* askedAgain(
		Effect.tryPromise({
			try: (signal) =>
				client.getForId(handle.definition.name, handle.actorId).action({ name: action, args: [encoded], signal }),
			catch: (cause) => fromRivet(handle, action, cause),
		}),
	);
	// A trust boundary: the reply comes from the actor, whose code may be another version than the caller's.
	const answer = yield* Effect.mapError(decodeAnswer(reply), mismatch("answer"));
	return yield* Answer.match(answer, {
		success: ({ value }) =>
			// A decode boundary: the value was decoded with the action's own output schema.
			Effect.mapError(boundary.decodeOutput(value), mismatch("output")) as Effect.Effect<
				Action.Output<A>,
				ActorDefect
			>,
		failure: ({ error }) =>
			Effect.flatMap(Effect.mapError(boundary.decodeError(error), mismatch("error")), (decoded) =>
				// A decode boundary: the error was decoded with the action's own error schema.
				Effect.fail(ActionFailed.make({ action, error: decoded }) as ActionFailure<Action.Failure<A>>),
			),
		defect: ({ message }) => Effect.fail(ActorDefect.make({ action, message })),
	});
});

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
function askedAgain<A, E extends CallError, R>(request: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
	return Effect.retry(request, HINTED);
}

/** The retry hint of a refusal that says the request was not served; none for every other failure. */
function hintOf(error: CallError): Option.Option<number> {
	return CallError.guards.EngineUnavailable(error) && !Str.startsWith("actor.")(error.code)
		? Option.fromUndefinedOr(error.retryAfterMillis)
		: Option.none();
}

const HINTED = Refusal.honouringHint(hintOf);

const NOT_FOUND = "actor.not_found";

const DUPLICATE_KEY = "actor.duplicate_key";

const TOO_DEEP = "actor.fork_too_deep";

const FORK_UNAVAILABLE = "actor.fork_unavailable";

/** What a rejected action call failed with. A trust boundary: `cause` is whatever rivetkit rejected with. */
function fromRivet(handle: Handle, action: string, cause: unknown): CallError {
	if (!(cause instanceof RivetError)) return unavailable(cause);
	if (cause.group === "actor" && (cause.code === "not_found" || Str.startsWith("destroyed")(cause.code))) {
		return gone(handle);
	}
	// The actor answered an error of Rivet's own, such as its action timeout.
	if (cause.group === "actor" && Option.isNone(Refusal.retryAfterMillis(cause))) {
		return ActorDefect.make({ action, message: `${cause.group}.${cause.code}: ${cause.message}` });
	}
	return unavailable(cause);
}

/**
 * What a request the engine did not serve failed with. Anything but a `RivetError` is a transport failure, which is
 * worth trying again; so is a refusal the engine gave a retry hint for, and a refused fork. A trust boundary, as
 * `fromRivet` is.
 */
function unavailable(cause: unknown): EngineUnavailable {
	if (!(cause instanceof RivetError)) {
		const message = Predicate.isError(cause) ? cause.message : String(cause);
		return EngineUnavailable.make({ code: "transport", message, retryable: true });
	}
	const code = `${cause.group}.${cause.code}`;
	const retryAfterMillis = Refusal.retryAfterMillis(cause);
	return EngineUnavailable.make({
		code,
		message: cause.message,
		retryable: Option.isSome(retryAfterMillis) || code === FORK_UNAVAILABLE,
		...Option.match(retryAfterMillis, { onNone: () => ({}), onSome: (millis) => ({ retryAfterMillis: millis }) }),
	});
}

/** Whether a failure is the engine's refusal with this `group.code`. */
function isCode(code: string): (error: HostError) => boolean {
	return (error) => HostError.guards.EngineUnavailable(error) && error.code === code;
}

function gone(handle: Handle): ActorGone {
	return ActorGone.make({ actor: handle.definition.name, actorId: handle.actorId });
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
	return NotIdle.make({ actorId: handle.actorId, tasks: status.tasks, submissions: status.submissions });
}

/** Rivet takes a key as a new array of strings. */
function keyOf(key: Key): Array<string> {
	return Predicate.isString(key) ? [key] : [...key];
}
