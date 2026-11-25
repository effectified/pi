// Test helper: what a host process and the test say to each other: each thing the product's ports are asked, as one
// tagged value that crosses as JSON, and the call that sends it.

import type { Settlement } from "@gunta/pi-budget-effect";
import type { Records } from "@gunta/pi-recorder-effect";

/** What a host process asks the outside, or tells it. `host` is the process, `actor` the Rivet actor. */
export type Ask = { readonly host: string } & (
	| { readonly kind: "ready" }
	| { readonly kind: "woke"; readonly actor: string; readonly wake: string }
	| { readonly kind: "beat"; readonly actor: string; readonly wake: string }
	| { readonly kind: "closed"; readonly actor: string; readonly wake: string }
	| {
			readonly kind: "reserve";
			readonly actor: string;
			readonly model: string;
			readonly session: string | null;
			readonly conversation: number | null;
	  }
	| { readonly kind: "settle"; readonly actor: string; readonly token: string; readonly settlement: Settlement }
	| { readonly kind: "records"; readonly actor: string; readonly batch: ReadonlyArray<Records.Record> }
	| {
			readonly kind: "outcome";
			readonly actor: string;
			readonly id: string;
			readonly thread: string;
			readonly says: string;
			readonly settledMicros: bigint | null;
	  }
	| {
			readonly kind: "model";
			readonly lab: string;
			readonly session: string | null;
			/** The newest user message, and how many tool results the request carries. */
			readonly prompt: string;
			readonly toolResults: ReadonlyArray<string>;
	  }
	| { readonly kind: "tool"; readonly actor: string; readonly tool: string; readonly note: string }
);

/** What the scripted model says: a tool call or an answer. */
export type Turn =
	| { readonly kind: "call"; readonly tool: string; readonly note: string }
	| { readonly kind: "answer"; readonly text: string };

/** Sends one ask and gives the outside's reply. An outside that holds the ask answers when the test lets it. */
export async function ask(url: string, body: Ask, signal?: AbortSignal): Promise<unknown> {
	const response = await fetch(url, {
		method: "POST",
		body: encode(body),
		...(signal === undefined ? {} : { signal }),
	});
	return decode(await response.text());
}

/** JSON with bigints, which a settlement and an outcome hold. */
export function encode(value: unknown): string {
	return JSON.stringify(value, (_key, held: unknown) =>
		typeof held === "bigint" ? { $bigint: held.toString() } : held,
	);
}

/** What `encode` wrote. */
export function decode(text: string): unknown {
	return JSON.parse(text, (_key, held: unknown) =>
		// Wire input: the one object `encode` makes of a bigint.
		typeof held === "object" && held !== null && "$bigint" in held ? BigInt(String(held.$bigint)) : held,
	);
}
