// Typed entries in Effect: a transcript entry kind of your own whose data is an Effect Schema.

import {
	defineEntry,
	type EntryDraft,
	type EntryId,
	type EntryRecord,
	type Entry as PiEntry,
} from "@earendil-works/pi-durable";
import type { StrictOmit } from "@effectified/pi-ai";
import type { JsonValue } from "@effectified/pi-chord/json";
import { decodeUnknown, encode, type SchemaDecodeError } from "@effectified/pi-schema";
import { Effect, Option, type Schema } from "effect";
import * as Ids from "./id.ts";

/** An entry kind made by `make`: entries of kind `kind` whose `data` has `schema`'s type. */
export interface Entry<S extends Schema.Constraint> {
	readonly kind: string;
	readonly schema: S;
	/** Pi's token of the kind, for Pi's own calls; it types `data` as the stored JSON. */
	readonly token: PiEntry<JsonValue>;
	/** What Pi appends for `draft`: its data as the JSON form of `schema`, the rest unchanged. */
	readonly draft: (
		draft: Draft<S["Type"]>,
	) => Effect.Effect<
		StrictOmit<EntryDraft, "kind"> & { readonly data: JsonValue },
		SchemaDecodeError,
		S["EncodingServices"]
	>;
	/**
	 * A stored entry as an entry of this kind, its data decoded: none when it has another kind. Works on any record: one
	 * of `Conversation.entries`, of a hook's `api.entry`, of a commit.
	 */
	readonly read: (
		record: EntryRecord,
	) => Effect.Effect<Option.Option<Typed<S["Type"]>>, SchemaDecodeError, S["DecodingServices"]>;
}

/** A stored entry whose `data` is a decoded value. */
export type Typed<A> = StrictOmit<EntryRecord, "data"> & { readonly data: A };

/** What a commit appends as a typed entry: the data, and Pi's other draft fields (`model`, `head`, `edits`). */
export type Draft<A> = StrictOmit<EntryDraft, "kind" | "data"> & { readonly data: A };

/**
 * The schema of an entry id, for a document, a task state or a wire that keeps one: the number Pi stores, typed with
 * Pi's brand.
 */
export const Id = Ids.entry;

/**
 * The smallest entry id after `id`: the bound of a read that starts after it (`minEntryId`). Pi numbers entries with
 * increasing integers and brands them in its types only; its own `idFromNumber` is not exported.
 */
export function after(id: EntryId): EntryId {
	// A plain cast, not one through `unknown`: it fails to compile if Pi's ids stop being numbers.
	return (id + 1) as EntryId;
}

/**
 * Defines an entry kind, as Pi's `defineEntry`: `kind` is stored, so never rename it, and must not start with `pi.`.
 * Data is encoded to JSON when appended and decoded when read, both through `schema`.
 */
export function make<S extends Schema.Constraint>(kind: string, schema: S): Entry<S> {
	const token = defineEntry<JsonValue>(kind);
	const toJson = encode(schema);
	const fromJson = decodeUnknown(schema);
	return {
		kind,
		schema,
		token,
		draft: ({ data, ...rest }) =>
			// A decode boundary: Effect types the JSON it encodes to read-only, Chord types the same values mutable.
			Effect.map(toJson(data), (json) => ({ ...rest, data: json as JsonValue })),
		read: (record) =>
			token.is(record)
				? Effect.map(fromJson(record.data), (data) => Option.some({ ...record, data }))
				: Effect.succeedNone,
	};
}

/** `found` as an entry of `entry`'s kind: none when nothing was found, or it has another kind. */
export function typed<S extends Schema.Constraint, E, R>(
	entry: Entry<S>,
	found: Effect.Effect<Option.Option<EntryRecord>, E, R>,
): Effect.Effect<Option.Option<Typed<S["Type"]>>, E | SchemaDecodeError, R | S["DecodingServices"]> {
	return Effect.flatMap(
		found,
		Option.match({ onNone: () => Effect.succeedNone, onSome: (record) => entry.read(record) }),
	);
}
