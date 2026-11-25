// Why the budget did not send a request: the typed refusals, and how one crosses Pi as the text of an error.

import { Effect, Option, Schema } from "effect";
import { LeaseFenced } from "./lease.ts";
import { PriceMissing } from "./price-table.ts";

/**
 * A conversation with a cap of its own has settled at least that much, so its request was not sent. The rest of the
 * harness goes on: the lease is not fenced.
 */
export class ShareExhausted extends Schema.TaggedError<ShareExhausted>()("ShareExhausted", {
	conversation: Schema.Number,
	/** The conversation's cap, in micro units. */
	cap: Schema.BigInt,
	/**
	 * What the conversation's requests had settled when this one was refused, in micro units: what counts against the
	 * cap. In a copied storage that is what was settled before the copy and since.
	 */
	settled: Schema.BigInt,
}) {
	override get message(): string {
		return `Conversation ${this.conversation} has settled ${this.settled} of its cap of ${this.cap} micro units`;
	}
}

/** Why a request was not sent. */
export const Refusal = Schema.Union([LeaseFenced, PriceMissing, ShareExhausted]);

/** Why a request was not sent: the lease is fenced, the model has no price, or the conversation's cap is reached. */
export type Refusal = typeof Refusal.Type;

/**
 * The refusal a failed run or an unanswered submission of Pi was stopped by, read from its `detail` (the text of
 * `pi.live`'s `runFailure` and of the settled submission, both stored); none when the detail is not a refusal of
 * this package.
 */
export function refusalOf(detail: unknown): Effect.Effect<Option.Option<Refusal>> {
	return Effect.sync(() =>
		// Stored input: Pi types a detail as any JSON value, and only a text can hold a refusal.
		typeof detail === "string"
			? Option.flatMap(Option.fromNullishOr(detail.match(PAYLOAD)?.[1]), (hex) => decodePayload(fromHex(hex)))
			: Option.none(),
	);
}

/**
 * The error text a refused request ends with in pi-ai: a fixed sentence for the kind of refusal, then the refusal
 * itself as JSON in hexadecimal. Pi decides from an error's text whether to send the request again, and whether to
 * compact and send it again, so no word of a product's label or of a model's id may be read in it: hexadecimal
 * digits between brackets match none of pi-ai's patterns.
 */
export function refusalText(refusal: Refusal): string {
	return `${SENTENCE[refusal._tag]} [budget:${toHex(encodePayload(refusal))}]`;
}

const SENTENCE: Readonly<Record<Refusal["_tag"], string>> = {
	LeaseFenced: "Budget: the lease is fenced, so the request was not sent.",
	PriceMissing: "Budget: the model has no price, so the request was not sent.",
	ShareExhausted: "Budget: the conversation has used up its share, so the request was not sent.",
};

/** Matches the payload anywhere in a text: Pi may put words of its own before an error's text. */
const PAYLOAD = /\[budget:((?:[0-9a-f]{2})+)\]/;

const Payload = Schema.fromJsonString(Schema.toCodecJson(Refusal));

const encodePayload = Schema.encodeSync(Payload);

/** Stored text: anything that is not a refusal of this version decodes to none. */
const decodePayload = Schema.decodeUnknownOption(Payload);

function toHex(text: string): string {
	let hex = "";
	for (const byte of new TextEncoder().encode(text)) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

function fromHex(hex: string): string {
	const bytes = new Uint8Array(hex.length / 2);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	return new TextDecoder().decode(bytes);
}
