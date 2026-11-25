// Documents in Effect: typed JSON state stored beside the transcript, changed in commits, its value an Effect Schema.

import type { Context as ChordContext } from "@earendil-works/chord/context";
import type { Draft, Op } from "@earendil-works/chord/delta";
import type { JsonValue } from "@earendil-works/chord/json";
import {
	type CheckpointInfo,
	type ConversationId,
	type DocumentObserver,
	type DocumentReader,
	type DocumentSemantics,
	defineDoc,
	defineDocFamily,
	type EntryId,
	type JsonObject,
	type Tx as PiTx,
	type TaskId,
	type WatchHandle,
} from "@earendil-works/pi-durable";
import { decodeUnknown, encode, type Issue, SchemaDecodeError } from "@gunta/pi-schema-effect";
import { Effect, type Option, Predicate, type Schema, Stream } from "effect";
import { call, step } from "./call.ts";
import type { DurableError } from "./errors.ts";
import * as Watch from "./watch.ts";

/**
 * A schema a document's value may have: one that encodes and decodes without services, because Pi asks for the
 * initial value synchronously. The JSON form of the value must be an object.
 */
export type ValueSchema = Schema.ConstraintCodec<unknown, unknown, never, never>;

/** What a singleton and a family definition share. The rest is Pi's: `scope`, and `history` and `fork`. */
export interface Shared<S extends ValueSchema> {
	/** The stored kind: part of the stored data, so never rename it. */
	readonly kind: string;
	/** A positive integer: the version of the stored shape. */
	readonly version: number;
	/** The value: encoded to JSON when written, decoded when read. */
	readonly schema: S;
	/** A value stored by an older `version`, as stored, to the current value; without it Pi refuses older data. */
	readonly migrate?: (stored: JsonObject, fromVersion: number) => S["Type"];
	/** Required, as in Pi: true stores this change as a complete base instead of a delta, which bounds replay. */
	readonly checkpointWhen: (stored: Readonly<JsonObject>, ops: ReadonlyArray<Op>, info: CheckpointInfo) => boolean;
}

/** The definition of a singleton document. `initial` is the value of a document that does not exist yet. */
export type Definition<S extends ValueSchema, M extends DocumentSemantics> = Shared<S> &
	M & { readonly initial: () => S["Type"] };

/** The definition of a document family: one document per key, created from the seed given at its first use. */
export type FamilyDefinition<S extends ValueSchema, M extends DocumentSemantics, Seed extends JsonValue> = Shared<S> &
	M & { readonly initial: (seed: Seed) => S["Type"] };

/** `latest` or `rewindable` for a conversation document, nothing for the other scopes. */
export type History<M> = M extends { readonly history: infer H } ? H : undefined;

/** What every document made by this module carries. */
interface Made<S extends ValueSchema, Scope, Kept> {
	readonly kind: string;
	readonly version: number;
	readonly schema: S;
	/** Whose state it is: the session's, one conversation's, or one task's. */
	readonly scope: Scope;
	/** Whether older values of a conversation document can be read (`snapshotAsOf`). */
	readonly history: Kept;
	/** Pi's token of the definition, for Pi's own calls; its type says nothing about the scope. */
	readonly token: Token;
	/** A value as the JSON object Pi stores; fails with `SchemaDecodeError` when it does not match `schema`. */
	readonly encode: (value: S["Type"]) => Effect.Effect<JsonObject, SchemaDecodeError>;
	/** Stored JSON as a value; fails with `SchemaDecodeError` when it does not match `schema`. */
	readonly decode: (stored: unknown) => Effect.Effect<S["Type"], SchemaDecodeError>;
}

/** A singleton document made by `make`. */
export interface Doc<S extends ValueSchema, Scope extends DocumentSemantics["scope"], Kept>
	extends Made<S, Scope, Kept> {
	readonly family: false;
}

/** A document family made by `family`. */
export interface Family<S extends ValueSchema, Scope extends DocumentSemantics["scope"], Kept, Seed extends JsonValue>
	extends Made<S, Scope, Kept> {
	readonly family: true;
	/** The definition's `initial`: the value of a member created from `seed`. */
	readonly initial: (seed: Seed) => S["Type"];
}

/** Any document or family, whatever its schema and scope. */
export interface Any {
	readonly kind: string;
	readonly schema: ValueSchema;
	readonly scope: DocumentSemantics["scope"];
	readonly history: unknown;
	readonly family: boolean;
	readonly token: Token;
	readonly encode: (value: never) => Effect.Effect<JsonObject, SchemaDecodeError>;
	readonly decode: (stored: unknown) => Effect.Effect<unknown, SchemaDecodeError>;
}

/** A conversation document or family that keeps its history: what `snapshotAsOf` reads. */
export type Rewindable = Any & { readonly scope: "conversation"; readonly history: "rewindable" };

/** The value type of a document. */
export type Value<D extends Any> = D["schema"]["Type"];

/**
 * Where one document of `D` lives, as Pi's calls take it: nothing for a session document, the conversation's id or the
 * task's id for the others, and then the key for a family.
 */
export type Address<D> = D extends { readonly scope: infer Scope; readonly family: infer F }
	? [
			...(Scope extends "session"
				? []
				: Scope extends "conversation"
					? [conversationId: ConversationId]
					: [taskId: TaskId]),
			...(F extends true ? [key: string] : []),
		]
	: never;

/** What a commit opens a document with: its address, and for a family the seed a missing member is created from. */
export type Opening<D> = D extends { readonly family: true; readonly initial: (seed: infer Seed) => unknown }
	? [...Address<D>, seed: Seed]
	: Address<D>;

/** Pi's token of a document or a family with the scope erased: this package types the address itself (`Address`). */
export interface Token {
	readonly definition: { readonly kind: string; readonly version: number };
}

/** What reading or writing a document fails with: a failed Pi call, or a value outside the schema. */
export type Failure = DurableError | SchemaDecodeError;

/**
 * Defines a singleton document, as Pi's `defineDoc`. The value is stored as the JSON form of `schema`, which must be
 * an object. `initial` and `migrate` give values, which are encoded on the spot: one the schema cannot encode fails
 * the commit that needed it with `UnexpectedError`.
 */
export function make<S extends ValueSchema, const M extends DocumentSemantics>(
	definition: Definition<S, M>,
): Doc<S, M["scope"], History<M>> {
	const { schema, initial, migrate, ...stored } = definition;
	const codec = compile(definition.kind, schema);
	const token = defineDoc({
		...stored,
		initial: () => codec.encodeSync(initial()),
		...(migrate === undefined ? {} : { migrate: migrated(migrate, codec) }),
		// Pi's overloads pick the token's type by scope, which a generic `M` cannot select: any scope is defined alike,
		// and `Address` types the scope where Pi's token would.
	} as Parameters<typeof defineDoc<JsonObject>>[0]);
	// The same erasure, read back: the document carries the scope and the history Pi's token type would.
	return { ...common(definition, token, codec), family: false } as Doc<S, M["scope"], History<M>>;
}

/**
 * Defines a document family, as Pi's `defineDocFamily`: one document per key, each created by `initial(seed)` at its
 * first use in a commit. Otherwise as `make`.
 */
export function family<S extends ValueSchema, const M extends DocumentSemantics, Seed extends JsonValue = null>(
	definition: FamilyDefinition<S, M, Seed>,
): Family<S, M["scope"], History<M>, Seed> {
	const { schema, initial, migrate, ...stored } = definition;
	const codec = compile(definition.kind, schema);
	const token = defineDocFamily({
		...stored,
		family: true,
		initial: (seed: Seed) => codec.encodeSync(initial(seed)),
		...(migrate === undefined ? {} : { migrate: migrated(migrate, codec) }),
		// As in `make`: Pi's overloads pick by scope.
	} as Parameters<typeof defineDocFamily<JsonObject, Seed>>[0]);
	return { ...common(definition, token, codec), family: true, initial } as Family<S, M["scope"], History<M>, Seed>;
}

/** Committed document reads: what a harness, a hook's api and a tool's api share. They never create a document. */
export interface Reader {
	/** The committed value of the document at this address, decoded; none while it does not exist. */
	readonly snapshot: <D extends Any>(
		doc: D,
		...address: Address<D>
	) => Effect.Effect<Option.Option<Value<D>>, Failure>;
	/**
	 * The value a rewindable conversation document had when the entry `at`, visible from that conversation, was
	 * committed; none when it did not exist then.
	 */
	readonly snapshotAsOf: <D extends Rewindable>(
		doc: D,
		...address: [...Address<D>, at: EntryId]
	) => Effect.Effect<Option.Option<Value<D>>, Failure>;
}

/** The Effect form of Pi's document reads; `parent` as for `call`. */
export function reader(pi: DocumentReader, parent?: ChordContext): Reader {
	// Pi's reads are overloaded by the token's scope, which `Address` checks at this package's call sites instead.
	const reads = pi as unknown as Reads;
	const decoded = <D extends Any>(
		doc: D,
		read: (context: ChordContext) => Promise<Readonly<JsonObject> | undefined>,
	) =>
		Effect.flatMap(call(read, parent), (stored) =>
			stored === undefined ? Effect.succeedNone : Effect.asSome(coded(doc).decode(stored)),
		);
	return {
		snapshot: (doc, ...address) => decoded(doc, (context) => reads.snapshot(doc.token, ...address, context)),
		snapshotAsOf: (doc, ...address) => decoded(doc, (context) => reads.snapshotAsOf(doc.token, ...address, context)),
	};
}

/** One document open in a commit: its value as the commit holds it, written with the commit or not at all. */
export interface Open<A> {
	/** The value now, with what this commit changed so far, decoded from a copy. */
	readonly get: Effect.Effect<A, SchemaDecodeError>;
	/**
	 * Replaces the value. It is encoded, and each top-level field that differs is written whole; fields the encoded
	 * value lacks are deleted. For a smaller stored change, such as one item appended to a long list, edit `draft`.
	 */
	readonly set: (value: A) => Effect.Effect<void, SchemaDecodeError>;
	/** `set` of what `change` makes of the current value. */
	readonly update: (change: (value: A) => A) => Effect.Effect<void, SchemaDecodeError>;
	/**
	 * Pi's draft of the stored JSON: assignments and array methods on it are recorded as they are made, and nothing
	 * checks them against the schema. Pi revokes it when the commit body ends, so it must not leave the body.
	 */
	readonly draft: Draft<JsonObject>;
}

/**
 * Opens a document in Pi's transaction, creating it when it does not exist (Pi's `tx.doc()`): the first open of an
 * address in a commit decides, later ones give the same document.
 */
export function open<D extends Any>(
	tx: PiTx,
	doc: D,
	...opening: Opening<D>
): Effect.Effect<Open<Value<D>>, DurableError> {
	const { encode: toStored, decode: fromStored } = coded(doc);
	return Effect.map(
		// Pi's writes are overloaded by the token's scope, which `Opening` checks at this package's call sites instead.
		step(() => (tx as unknown as Writes).doc(doc.token, ...opening)),
		(draft): Open<Value<D>> => {
			// A copy: values read through the draft are revoked with it, and a decoded value may keep what it read. The
			// draft is a Proxy, which `structuredClone` refuses on Node and Bun (`DataCloneError`); it holds only JSON.
			const get = Effect.suspend(() => fromStored(JSON.parse(JSON.stringify(draft))));
			const set = (value: Value<D>) => Effect.map(toStored(value), (next) => replace(draft, next));
			return { get, set, update: (change) => Effect.flatMap(get, (value) => set(change(value))), draft };
		},
	);
}

/** Retires the document at this address in Pi's transaction, if it exists (Pi's `tx.retireDoc()`). */
export function retire<D extends Any>(tx: PiTx, doc: D, ...address: Address<D>): Effect.Effect<void, DurableError> {
	// As in `open`: `Address` checks what Pi's overloads would.
	return step(() => (tx as unknown as Writes).retireDoc(doc.token, ...address));
}

/**
 * Pi's `watchDoc` as a Stream of decoded values: see `Watch.stream`. It never creates the document, and has no
 * element when the address holds none.
 */
export function watch<D extends Any>(
	pi: DocumentObserver,
	doc: D,
	...address: Address<D>
): Stream.Stream<Watch.Change<Value<D>>, Failure> {
	return Stream.mapEffect(
		// As in `reader`: `Address` checks what Pi's overloads would.
		Watch.stream((context) => (pi as unknown as Watches).watchDoc(doc.token, ...address, context)),
		(change) => Effect.map(coded(doc).decode(change.value), (value) => ({ ...change, value })),
	);
}

/** Pi's overloaded document reads, by what every overload has in common: the token, the address, the context. */
interface Reads {
	snapshot(token: Token, ...rest: ReadonlyArray<unknown>): Promise<Readonly<JsonObject> | undefined>;
	snapshotAsOf(token: Token, ...rest: ReadonlyArray<unknown>): Promise<Readonly<JsonObject> | undefined>;
}

/** Pi's overloaded document watch, in the same way. */
interface Watches {
	watchDoc(token: Token, ...rest: ReadonlyArray<unknown>): Promise<WatchHandle<Readonly<JsonObject>> | undefined>;
}

/** Pi's overloaded document writes of a transaction, in the same way. */
interface Writes {
	doc(token: Token, ...opening: ReadonlyArray<unknown>): Promise<Draft<JsonObject>>;
	retireDoc(token: Token, ...address: ReadonlyArray<unknown>): Promise<void>;
}

/** A document's codec with its value type. */
interface Coded<A> {
	readonly encode: (value: A) => Effect.Effect<JsonObject, SchemaDecodeError>;
	readonly decode: (stored: unknown) => Effect.Effect<A, SchemaDecodeError>;
}

/**
 * `doc`'s codec, typed by the value of `D`. TypeScript resolves the members of a generic `D` against `Any`, where the
 * value is unknown; a document's codec is its schema's by construction (`make`, `family`).
 */
function coded<D extends Any>(doc: D): Coded<Value<D>> {
	return doc as unknown as Coded<Value<D>>;
}

/** A schema's codec for stored documents: as Effects for reads and writes, synchronous for Pi's `initial`. */
interface Codec<S extends ValueSchema> extends Coded<S["Type"]> {
	readonly encodeSync: (value: S["Type"]) => JsonObject;
}

function compile<S extends ValueSchema>(kind: string, schema: S): Codec<S> {
	const toJson = encode(schema);
	const notAnObject: Issue = { path: "", message: `The value of document ${kind} must encode to a JSON object` };
	const toObject = (value: S["Type"]) =>
		Effect.filterOrFail(
			toJson(value),
			(json): json is JsonObject => Predicate.isObject(json) && !Array.isArray(json),
			() => new SchemaDecodeError({ issues: [notAnObject] }),
		);
	// Pi's `initial` and `migrate` return at once, so a failure can only leave as the error Pi rejects the commit with.
	return { encode: toObject, encodeSync: (value) => Effect.runSync(toObject(value)), decode: decodeUnknown(schema) };
}

function migrated<S extends ValueSchema>(
	migrate: (stored: JsonObject, fromVersion: number) => S["Type"],
	codec: Codec<S>,
): (stored: JsonObject, fromVersion: number) => JsonObject {
	return (stored, fromVersion) => codec.encodeSync(migrate(stored, fromVersion));
}

function common<S extends ValueSchema>(
	definition: Shared<S> & DocumentSemantics,
	token: Token,
	codec: Codec<S>,
): Made<S, DocumentSemantics["scope"], unknown> {
	return {
		kind: definition.kind,
		version: definition.version,
		schema: definition.schema,
		scope: definition.scope,
		history: definition.history,
		token,
		encode: codec.encode,
		decode: codec.decode,
	};
}

/** Makes the draft hold `next`. Pi records no change for a field assigned an equal value. */
function replace(draft: Draft<JsonObject>, next: JsonObject): void {
	for (const key of Object.keys(draft)) if (!Object.hasOwn(next, key)) delete draft[key];
	Object.assign(draft, next);
}
