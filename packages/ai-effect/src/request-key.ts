// The key of a request of a conversation: what it asks at one point, the same each time that request is sent.

import type { Context as PiContext, StreamOptions } from "@earendil-works/pi-ai";
import { Array as Arr, Effect, Formatter, Order, Predicate, pipe, Record, Schema, String as Str } from "effect";

/** The key of a request: 64 lower-case hexadecimal digits, the SHA-256 of the request's canonical JSON. */
export const RequestKey = Schema.String.pipe(Schema.brand("RequestKey"));

/** The key of a request. */
export type RequestKey = typeof RequestKey.Type;

/** The provider session a request belongs to: pi-ai's `sessionId`. */
type Session = NonNullable<StreamOptions["sessionId"]>;

/**
 * The key of a request with a provider session: the SHA-256, in 64 lower-case hexadecimal digits, of the canonical
 * JSON of the session and the whole context (system prompt, messages, tools).
 *
 * - **The same for every send of one request.** Pi builds a request's context from its conversation's committed
 *   entries, without the answers that failed or were cut off. So a request sent again after a crash, by this process
 *   or a later one, has the key of the send that was cut off, and so has Pi's retry after a provider error.
 * - **Another for every other request.** A new request of a conversation carries something more: an input, a tool
 *   result, an answer, a summary. Another conversation has another session; a fork gets a fresh one.
 * - **Not unique to one actor.** A copy of a storage (a Rivet actor fork) keeps its source's sessions: a request that
 *   was in flight when the copy was made is sent by both under one key.
 * - **What it costs.** A walk of the whole context and a hash, for every request with a session.
 *
 * It is one function for every plugin that names a request: the router's route events and the budget's reservations
 * carry the same key because both ask here.
 */
export const requestKey = Effect.fn("RequestKey.requestKey")(function* (
	session: Session,
	context: PiContext,
): Effect.fn.Return<RequestKey> {
	const text = canonical({ session, context });
	const hash = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
	return RequestKey.make(Arr.join(Arr.map(Arr.fromIterable(new Uint8Array(hash)), hexByte), ""));
});

function hexByte(byte: number): string {
	return pipe(byte.toString(16), Str.padStart(2, "0"));
}

/**
 * `value` as JSON with the keys of every object sorted, as RFC 8785 orders them, so the key does not depend on the
 * order in which a process built an object. What JSON leaves out it leaves out: an `undefined` property, and symbol
 * keys such as those of a tool's parameter schema. A key and a primitive are written as `JSON.stringify` writes them.
 */
function canonical(value: unknown): string {
	if (Arr.isArray(value)) return `[${Arr.join(Arr.map(value, canonical), ",")}]`;
	if (!Predicate.isObject(value)) return Formatter.formatJson(value);
	const record: Record.ReadonlyRecord<string, unknown> = value;
	const keys: ReadonlyArray<string> = Arr.sort(Record.keys(record), Order.String);
	const members = Arr.flatMap(keys, (key) => {
		const member = record[key];
		return member === undefined ? [] : [`${Formatter.formatJson(key)}:${canonical(member)}`];
	});
	return `{${Arr.join(members, ",")}}`;
}
