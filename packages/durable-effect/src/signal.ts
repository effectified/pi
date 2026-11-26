// Signals in Effect: a typed value delivered to a live task from outside, its type an Effect Schema.

import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import {
	defineSignal,
	type HookApi,
	type SignalKey,
	type SignalState,
	type SignalToken,
} from "@earendil-works/pi-durable";
import { decodeUnknown, encode, SchemaConversionError, SchemaDecodeError, toJsonSchema } from "@effectified/pi-schema";
import { Effect, Option, Predicate, type Schema } from "effect";
import { call } from "./call.ts";
import type { DurableError } from "./errors.ts";

export { SubmissionSettled } from "./submission-settled.ts";

/** A signal kind made by `make`: values of `schema`'s type, delivered under keys. */
export interface Signal<S extends Schema.Constraint> {
	readonly name: string;
	readonly version: number;
	readonly schema: S;
	/** One wait for this signal under `key`: what `Gate.park` sleeps on. */
	readonly key: (key: string) => Key;
	/**
	 * Pi's token of the signal, built on first use and kept: Pi stores the JSON form of a value and checks it against
	 * the JSON Schema of `schema`. Fails when Pi rejects the definition or the schema has no JSON Schema.
	 */
	readonly token: Effect.Effect<SignalToken<unknown>, SchemaConversionError>;
	/** A value as the JSON Pi stores; fails with `SchemaDecodeError` when it does not match `schema`. */
	readonly encode: (value: S["Type"]) => Effect.Effect<unknown, Failure, S["EncodingServices"]>;
	/**
	 * Stored JSON as a value; fails with `SchemaDecodeError` when it does not match `schema`. It needs the schema only,
	 * not Pi's token, so a definition Pi rejects does not fail it.
	 */
	readonly decode: (json: unknown) => Effect.Effect<S["Type"], SchemaDecodeError, S["DecodingServices"]>;
}

/** One wait for a signal: the signal and the key its value is delivered under. */
export interface Key {
	readonly signal: { readonly token: Effect.Effect<SignalToken<unknown>, SchemaConversionError> };
	readonly key: string;
}

/** What using a signal fails with besides Pi's own failures: a definition Pi rejects, or a value outside the schema. */
export type Failure = SchemaConversionError | SchemaDecodeError;

/** A key's state: the value delivered under it, or `expired` because the deadline of its sleep came first. */
export type State<A> = SignalState<A>;

/** A Pi api that reads signals of its task: a hook's, a tool call's, a task's runtime. */
export type Reader = Pick<HookApi, "readSignal">;

/**
 * Defines a signal kind, as Pi's `defineSignal`: `name` is unique like a task kind and has no "/", `version` is a
 * positive integer. Nothing is checked here: the first use builds Pi's token and fails if Pi rejects the definition.
 */
export function make<S extends Schema.Constraint>(name: string, version: number, schema: S): Signal<S> {
	// Compiling the schema is the cost of a definition: paid once, at first use, and never again for this signal.
	const compiled = Effect.runSync(Effect.cached(compile(name, version, schema)));
	const decoder = Effect.runSync(Effect.cached(Effect.sync(() => decodeUnknown(schema))));
	const token = Effect.map(compiled, (built) => built.token);
	const signal: Signal<S> = {
		name,
		version,
		schema,
		key: (key) => ({ signal, key }),
		token,
		encode: (value) => Effect.flatMap(compiled, (built) => built.encode(value)),
		decode: (json) => Effect.flatMap(decoder, (decode) => decode(json)),
	};
	return signal;
}

/** Pi's key of one wait. An empty key is a defect: Pi's `key()` throws for it. */
export function toPiKey({ signal, key }: Key): Effect.Effect<SignalKey<unknown>, SchemaConversionError> {
	return Effect.map(signal.token, (token) => token.key(key));
}

/**
 * The committed state of `key` in the task `reader` belongs to, its value decoded: none while nothing came. It never
 * waits. `parent` is the context of the Pi invocation the read is made from.
 */
export function read<S extends Schema.Constraint>(
	reader: Reader,
	signal: Signal<S>,
	key: string,
	parent?: Context,
): Effect.Effect<Option.Option<State<S["Type"]>>, DurableError | Failure, S["DecodingServices"]> {
	return Effect.gen(function* () {
		const token = yield* signal.token;
		const state = yield* call((context) => reader.readSignal(token, key, context), parent);
		if (state === undefined) return Option.none();
		if (state.kind === "expired") return Option.some(state);
		return Option.some({ kind: "value", value: yield* signal.decode(state.value) });
	});
}

/** What `stateIn` reads of a task's stored record: its memos, which a task that ended no longer has. */
export interface Stored {
	readonly memos?: Readonly<Record<string, JsonValue>>;
}

/**
 * The state of `key` in a task's stored record, read from outside the task: the record of `Harness.getTask`,
 * `Harness.inspect` or `tx.task`. None while nothing came, and for a task that ended, whose memos Pi drops. Pi has
 * no call for this outside the task's own `readSignal`: it reads the memo Pi keeps a key's state in,
 * `pi.signal.<signal name>/<key>` (Pi's specification, 5.7). That name and the memo's shape are a convention of
 * Pi's stored data, not an API. A value stored under another version of the signal fails with `SchemaDecodeError`,
 * its only failure: it decodes with the schema and never builds Pi's token.
 */
export function stateIn<S extends Schema.Constraint>(
	record: Stored,
	signal: Signal<S>,
	key: string,
): Effect.Effect<Option.Option<State<S["Type"]>>, SchemaDecodeError, S["DecodingServices"]> {
	const name = `pi.signal.${signal.name}/${key}`;
	// Own memos only: a name such as `toString` must not find an inherited property.
	if (record.memos === undefined || !Object.hasOwn(record.memos, name)) return Effect.succeedNone;
	// Stored data is a trust boundary: the memo is read as what Pi 1.6.0 writes, and anything else is refused.
	const stored: unknown = record.memos[name];
	if (Predicate.hasProperty(stored, "expired") && stored.expired === true) {
		return Effect.succeedSome({ kind: "expired" });
	}
	if (!Predicate.hasProperty(stored, "version") || !Predicate.hasProperty(stored, "value")) {
		return Effect.fail(unreadable(name, "it is not a signal memo of Pi Durable 1.6.0"));
	}
	if (stored.version !== signal.version) {
		return Effect.fail(unreadable(name, `it holds version ${String(stored.version)}, not ${signal.version}`));
	}
	return Effect.map(signal.decode(stored.value), (value) => Option.some({ kind: "value", value }));
}

function unreadable(memo: string, why: string): SchemaDecodeError {
	return new SchemaDecodeError({ issues: [{ path: "", message: `Memo ${memo} cannot be read: ${why}` }] });
}

/** What a signal needs of Pi and of its schema to write, built together so one failure covers the definition. */
interface Compiled<S extends Schema.Constraint> {
	readonly token: SignalToken<unknown>;
	readonly encode: (value: S["Type"]) => Effect.Effect<unknown, SchemaDecodeError, S["EncodingServices"]>;
}

function compile<S extends Schema.Constraint>(
	name: string,
	version: number,
	schema: S,
): Effect.Effect<Compiled<S>, SchemaConversionError> {
	const failed = (reason: string) => new SchemaConversionError({ reason: `Signal ${name}: ${reason}` });
	return Effect.try({
		try: () => toJsonSchema(schema),
		catch: (cause) => failed(Predicate.isError(cause) ? cause.message : String(cause)),
	}).pipe(
		// Pi takes an object, never a boolean schema.
		Effect.filterOrFail(Predicate.isObject, () => failed("the JSON Schema of the value is not an object")),
		Effect.flatMap((jsonSchema) =>
			Effect.try({
				try: (): Compiled<S> => ({
					token: defineSignal({ name, version, schema: jsonSchema }),
					encode: encode(schema),
				}),
				// Pi's messages name the signal themselves.
				catch: (cause) =>
					new SchemaConversionError({ reason: Predicate.isError(cause) ? cause.message : String(cause) }),
			}),
		),
	);
}
