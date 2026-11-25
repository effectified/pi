// The key of a request of a conversation: what it asks at one point, the same each time that request is sent.

import type { Context as PiContext } from "@earendil-works/pi-ai";
import { Effect } from "effect";

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
export function requestKey(session: string, context: PiContext): Effect.Effect<string> {
	const text = canonical({ session, context });
	return Effect.map(
		Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
		(hash) => Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(""),
	);
}

/**
 * `value` as JSON with the keys of every object sorted, as RFC 8785 orders them, so the key does not depend on the
 * order in which a process built an object. What JSON leaves out it leaves out: an `undefined` property, and symbol
 * keys such as those of a tool's parameter schema.
 */
function canonical(value: unknown): string {
	if (isList(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "null";
	const members: Array<string> = [];
	for (const key of Object.keys(value).sort()) {
		const member: unknown = Reflect.get(value, key);
		if (member !== undefined) members.push(`${JSON.stringify(key)}:${canonical(member)}`);
	}
	return `{${members.join(",")}}`;
}

// `Array.isArray` narrows `unknown` to `any[]`.
const isList: (value: unknown) => value is ReadonlyArray<unknown> = Array.isArray;
