// Durable tasks in Effect: input, state and result as Schemas, each phase an Effect, built into a Pi Durable task.

import {
	defineTask,
	type Task as PiTask,
	type SettledTask,
	type TaskOutcome,
	type TaskRecord,
	type TaskState,
} from "@earendil-works/pi-durable";
import type { StrictOmit } from "@effectified/pi-ai";
import type { Context as ChordContext } from "@effectified/pi-chord/context";
import type { JsonValue } from "@effectified/pi-chord/json";
import { decodeUnknown, encode, type SchemaDecodeError } from "@effectified/pi-schema";
import { Effect, type Schema } from "effect";
import * as Ids from "./id.ts";
import { type Invoke, invoker } from "./invocation.ts";
import * as TaskApi from "./task-api.ts";
import type * as Step from "./task-step.ts";

export {
	aborted,
	type Committed,
	committed,
	complete,
	type End,
	fail,
	type Next,
	next,
	type Outcome,
	type Sleep,
	type Step,
	sleep,
	sleepUntil,
	type Unchanged,
	unchanged,
	type Wait,
	wait,
} from "./task-step.ts";

/** What a handler may use besides its task: commits, memos, signals, documents, other tasks, conversations. */
export type Api<I, S, A> = TaskApi.Api<I, S, A>;

/** The task a handler runs for: its input and its state, decoded. */
export type Running<I, S> = TaskApi.Running<I, S>;

/** What the body of `api.commitReturning` returns: the task's step, and a value for the phase to go on with. */
export type Returning<S, A, B> = TaskApi.Returning<S, A, B>;

/**
 * A schema a task's input or result may have: one that encodes and decodes without services, because Pi asks for the
 * first state synchronously. Pi stores the JSON form.
 */
export type ValueSchema = Schema.ConstraintCodec<unknown, unknown, never, never>;

/**
 * A schema a task's state may have: a value with a `phase`, usually a union of one struct per phase, each with a
 * literal `phase`. The `phase` must encode to itself: Pi reads it from the stored JSON to pick the handler.
 */
export type StateSchema = Schema.ConstraintCodec<{ readonly phase: string }, unknown, never, never>;

/**
 * One handler per phase of the state `S`: each gets the task narrowed to its phase, and returns the task's step. A
 * handler may fail with anything, since no failure leaves the task (Pi ends it `faulted`), and may need any service.
 */
export type Phases<I, S extends { readonly phase: string }, A> = {
	readonly [K in S["phase"]]: (
		task: Running<I, Extract<S, { readonly phase: K }>>,
		api: Api<I, S, A>,
	) => Effect.Effect<Step.Step<S, A> | Step.Committed, unknown, unknown>;
};

/** The services the handlers of a phase map need: the union over its phases. */
export type PhaseServices<Ph> = {
	readonly [K in keyof Ph]: Ph[K] extends (...args: never) => Effect.Effect<unknown, unknown, infer R> ? R : never;
}[keyof Ph];

/** What `make` takes. `Ph` is the phase map as written, so each handler keeps its own requirements. */
export interface Options<
	I extends ValueSchema,
	S extends StateSchema,
	A extends ValueSchema,
	Ph extends Phases<I["Type"], S["Type"], A["Type"]>,
	R,
> {
	/** The task's kind, which Pi stores and finds the definition by: unique in a registry, never renamed. */
	readonly name: string;
	/** A positive integer: the version of the stored input and state. */
	readonly version: number;
	/** What a task is created with: encoded when it is created, decoded for every handler. */
	readonly input: I;
	/** The checkpoint: everything the task needs to go on, stored at every step and decoded for every handler. */
	readonly state: S;
	/** What the task completes with: encoded when it ends, decoded by the typed reads. */
	readonly result: A;
	/** The state a new task starts at. It returns at once, inside the commit that creates the task. */
	readonly initial: (input: I["Type"]) => S["Type"];
	/**
	 * Runs one phase and succeeds with the task's step: `next`, `sleep`, `wait`, or an outcome, which this package
	 * commits; or what `api.commit` gave, when the phase stored its step together with other writes. Interrupted when
	 * Pi aborts the task or the harness closes. A failure or a defect ends the task `faulted`.
	 */
	readonly phases: Ph;
	/**
	 * Runs instead of the phases once the task is marked for abort and the work it owns has ended, and decides the
	 * outcome, usually `aborted`. It cannot sleep, wait or create owned work. A failure ends the task `faulted`.
	 */
	readonly abort: (
		task: Running<I["Type"], S["Type"]>,
		api: Api<I["Type"], S["Type"], A["Type"]>,
	) => Effect.Effect<Step.End<A["Type"]> | Step.Committed, unknown, R>;
	/**
	 * Pi's `migrate`: the input and the state a task of an older `version` stored, as stored, to the current values.
	 * Without it Pi leaves such a task blocked. It returns at once, when Pi takes the task up.
	 */
	readonly migrate?: (
		input: JsonValue,
		state: JsonValue,
		fromVersion: number,
	) => { readonly input: I["Type"]; readonly state: S["Type"] };
}

/** Pi's task object of a task of this package: input, checkpoint and result as stored JSON. */
export interface Token extends PiTask<JsonValue, Step.Checkpoint, JsonValue, object> {}

/** What creating a task and reading its result need of it: its Pi token and its codecs. */
export interface Kind<in I, out A> {
	readonly name: string;
	/**
	 * Pi's token of the kind, for Pi's own calls that create a task or name one (`createTask`, `hookTask`): they read
	 * its name, version and first state. Its handlers are not the task's: a task runs under the definition a registry
	 * holds, which `Registry.layer` installs.
	 */
	readonly token: Token;
	/** An input as the JSON Pi stores; fails with `SchemaDecodeError` when it does not match the schema. */
	readonly encodeInput: (input: I) => Effect.Effect<JsonValue, SchemaDecodeError>;
	/** A stored outcome with its result decoded; fails with `SchemaDecodeError` when it does not match the schema. */
	readonly outcome: (stored: TaskOutcome<unknown>) => Effect.Effect<TaskOutcome<A>, SchemaDecodeError>;
}

/** A task made by `make`: its kind, its schemas, and what installs it. `R` is what its handlers need. */
export interface Task<I extends ValueSchema, S extends StateSchema, A extends ValueSchema, R>
	extends Kind<I["Type"], A["Type"]> {
	readonly version: number;
	readonly input: I;
	readonly state: S;
	readonly result: A;
	/** Builds the Pi task; its handlers run with the context this Effect is run in (`Registry.layer` runs it). */
	readonly registration: Effect.Effect<Token, never, R>;
}

/** Any task, whatever its schemas and requirements: what an extension holds and a registry installs. */
export interface Any {
	readonly name: string;
	readonly registration: Effect.Effect<Token, never, unknown>;
}

/** The services a task's handlers, or those of each task of a union, need to run. */
export type Services<T> = T extends { readonly registration: Effect.Effect<infer _A, infer _E, infer R> } ? R : never;

/** A task's terminal record with the result of its outcome decoded: Pi's `SettledTask`, its state of result `A`. */
export type Settled<A> = StrictOmit<SettledTask<unknown>, "state"> & { readonly state: SettledTask<A>["state"] };

/**
 * The schema of a task id, for a state, a document or a wire that keeps one: the number Pi stores, typed with Pi's
 * brand.
 */
export const Id = Ids.task;

/**
 * Whether a task in this status has ended: its outcome is decided, so it runs no more code, a signal no longer reaches
 * it, and its memos are gone. `completing` has ended although work it owns may still be live (Pi's `waitForTask` waits
 * for `terminal`, when that work ended too). The one place that reads Pi's statuses so: a status Pi adds fails to
 * compile here until it is decided.
 */
export function ended(status: TaskState<unknown, unknown>["status"]): boolean {
	return ENDED[status];
}

/** The statuses of a task state that holds an outcome: Pi's own split of the live states from the ended ones. */
type EndedStatus = Extract<TaskState<unknown, unknown>, { readonly outcome: unknown }>["status"];

// Typed by Pi's states: every status is here, and true exactly when Pi's state of that status holds an outcome.
const ENDED = {
	pending: false,
	running: false,
	waiting: false,
	sleeping: false,
	completing: true,
	terminal: true,
} as const satisfies Record<EndedStatus, true> &
	Record<Exclude<TaskState<unknown, unknown>["status"], EndedStatus>, false>;

/**
 * Defines a task, as Pi's `defineTask`: a small state machine whose state is stored at every step, so a harness
 * opened later continues it at the last stored one. Pi runs a phase again from its top when a crash or a close came
 * before its step was stored. A handler that fails, and one whose input, state or step does not match its schema,
 * reaches Pi as a throwing handler: the task ends `faulted`, at once and for good.
 */
export function make<
	I extends ValueSchema,
	S extends StateSchema,
	A extends ValueSchema,
	Ph extends Phases<I["Type"], S["Type"], A["Type"]>,
	R,
>(
	options: Options<I, S, A, Ph, R> & {
		// A handler for a phase the state does not have is a mistake that `Ph` alone, which may have more keys, lets pass.
		readonly phases: { readonly [K in Exclude<keyof Ph, S["Type"]["phase"]>]: never };
	},
): Task<I, S, A, R | PhaseServices<Ph>> {
	const codec = compile(options);
	const decodeResult = decodeUnknown(options.result);
	const refuse = unbound(options.name);
	return {
		name: options.name,
		version: options.version,
		input: options.input,
		state: options.state,
		result: options.result,
		token: definition(options, codec, () => refuse),
		encodeInput: codec.encodeInput,
		outcome: (outcome) => decodeOutcome(outcome, decodeResult),
		registration: Effect.map(Effect.context<R | PhaseServices<Ph>>(), (context) => {
			const invoke = invoker(context);
			return definition(options, codec, (handler) => bound(invoke, handler, codec));
		}),
	};
}

/** A task's terminal record, as `Harness.waitForTask` gives it, with its result decoded. */
export function settled<A>(
	task: Kind<never, A>,
	record: SettledTask<unknown>,
): Effect.Effect<Settled<A>, SchemaDecodeError> {
	// The state as Pi stored it, its outcome decoded: a field Pi adds to a terminal state is kept.
	return Effect.map(task.outcome(record.state.outcome), (outcome) => ({
		...record,
		state: { ...record.state, outcome },
	}));
}

/** A task's record, as `Harness.getTask` gives it, with the result of an outcome it holds decoded. */
export function record<A>(
	task: Kind<never, A>,
	found: TaskRecord<JsonValue, JsonValue, unknown>,
): Effect.Effect<TaskRecord<JsonValue, JsonValue, A>, SchemaDecodeError> {
	const state = found.state;
	switch (state.status) {
		case "pending":
		case "running":
		case "waiting":
		case "sleeping":
			// No outcome yet, so nothing of the result's type: the record is one of any result.
			return Effect.succeed(found as TaskRecord<JsonValue, JsonValue, never>);
		case "completing":
		case "terminal":
			return Effect.map(
				task.outcome(state.outcome),
				// TypeScript does not narrow a record by the status of its state: one that holds an outcome has no memos.
				(outcome) => ({ ...found, state: { ...state, outcome } }) as TaskRecord<JsonValue, JsonValue, A>,
			);
	}
}

/** A task's codecs: the JSON Pi stores to and from the values the handlers get. */
interface Compiled<I, S, A> extends TaskApi.Codec<I, S, A> {
	readonly encodeInput: (input: I) => Effect.Effect<JsonValue, SchemaDecodeError>;
}

function compile<I extends ValueSchema, S extends StateSchema, A extends ValueSchema>(options: {
	readonly input: I;
	readonly state: S;
	readonly result: A;
}): Compiled<I["Type"], S["Type"], A["Type"]> {
	const encodeInput = encode(options.input);
	const encodeState = encode(options.state);
	const encodeResult = encode(options.result);
	return {
		encodeInput: (input) => Effect.map(encodeInput(input), stored),
		input: decodeUnknown(options.input),
		checkpoint: decodeUnknown(options.state),
		// The JSON form of a state is an object that keeps its `phase` (`StateSchema`), which the types cannot say.
		state: (state) => Effect.map(encodeState(state), (json) => json as Step.Checkpoint),
		result: (result) => Effect.map(encodeResult(result), stored),
	};
}

/** A handler of this package, of a phase or of an abort, for any state of the task. */
type Handler<I, S, A, R> = (
	task: Running<I, S>,
	api: Api<I, S, A>,
) => Effect.Effect<Step.Step<S, A> | Step.Committed, unknown, R>;

/** A handler as Pi calls it. */
type PiHandler = (task: TaskApi.Record, runtime: TaskApi.Runtime, context: ChordContext) => Promise<void>;

/** Pi's task for `options`, with each handler as `bind` makes it. */
function definition<
	I extends ValueSchema,
	S extends StateSchema,
	A extends ValueSchema,
	Ph extends Phases<I["Type"], S["Type"], A["Type"]>,
	R,
>(
	options: Options<I, S, A, Ph, R>,
	codec: Compiled<I["Type"], S["Type"], A["Type"]>,
	bind: (handler: Handler<I["Type"], S["Type"], A["Type"], R | PhaseServices<Ph>>) => PiHandler,
): Token {
	// Pi picks the handler by the stored `phase`, so each gets the state of its own phase, and each needs some of the
	// services of `PhaseServices`: the map's type says both per key, which a walk over its entries loses.
	const phases = options.phases as unknown as Readonly<
		Record<string, Handler<I["Type"], S["Type"], A["Type"], PhaseServices<Ph>>>
	>;
	const migrate = options.migrate;
	// Pi's `initial` and `migrate` return at once, so a value outside its schema can only leave as the error Pi rejects
	// the creating commit with, or blocks the task for.
	const checkpoint = (state: S["Type"]) => Effect.runSync(codec.state(state));
	return defineTask<JsonValue, Step.Checkpoint, JsonValue>({
		name: options.name,
		version: options.version,
		initial: (input) => checkpoint(options.initial(Effect.runSync(codec.input(input)))),
		phases: Object.fromEntries(Object.entries(phases).map(([phase, handler]) => [phase, bind(handler)])),
		abort: bind(options.abort),
		...(migrate === undefined
			? {}
			: {
					migrate: (input: JsonValue, state: JsonValue, fromVersion: number) => {
						const migrated = migrate(input, state, fromVersion);
						return {
							input: Effect.runSync(codec.encodeInput(migrated.input)),
							checkpoint: checkpoint(migrated.state),
						};
					},
				}),
	});
}

/**
 * `handler` as Pi calls it, run with `invoke`'s context. Pi aborts an invocation through its context: that interrupts
 * the handler's fiber, and the rejection that follows is what Pi expects of an aborted handler. A step the handler
 * returns is committed here; a failure rejects, which is how a throwing handler reaches Pi.
 */
function bound<I, S, A, R>(invoke: Invoke<R>, handler: Handler<I, S, A, R>, codec: TaskApi.Codec<I, S, A>): PiHandler {
	return (current, runtime, context) => {
		const api = TaskApi.fromPi(runtime, codec);
		return invoke(
			TaskApi.running(current, codec).pipe(
				Effect.flatMap((task) => handler(task, api)),
				Effect.flatMap((step) =>
					step._tag === "Committed" ? Effect.void : Effect.asVoid(api.commit(() => Effect.succeed(step))),
				),
			),
			context,
		);
	};
}

/** The handler of a creation token: it has no context to run with, so a task Pi runs under it faults, saying why. */
function unbound(name: string): PiHandler {
	return () =>
		Promise.reject(new Error(`Task ${name} was installed from its token: install it with Registry.layer instead`));
}

/** `outcome` with its result decoded, when it has one. */
function decodeOutcome<A>(
	outcome: TaskOutcome<unknown>,
	decode: (result: unknown) => Effect.Effect<A, SchemaDecodeError>,
): Effect.Effect<TaskOutcome<A>, SchemaDecodeError> {
	switch (outcome.status) {
		case "completed":
			return Effect.map(decode(outcome.result), (result) => ({ status: "completed", result }));
		case "failed":
		case "aborted": {
			const { result, ...rest } = outcome;
			return result === undefined
				? Effect.succeed(rest)
				: Effect.map(decode(result), (decoded) => ({ ...rest, result: decoded }));
		}
		case "orphaned":
		case "faulted":
			return Effect.succeed(outcome);
	}
}

/** JSON as Pi takes it. A decode boundary: Effect types JSON read-only, Chord types the same values mutable. */
function stored(json: Schema.Json): JsonValue {
	return json as JsonValue;
}
