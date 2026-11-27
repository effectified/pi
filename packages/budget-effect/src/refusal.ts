// Why the budget did not send a request: the typed refusals, and how one crosses Pi as the text of an error.

import { Conversation } from "@effectified/pi-durable";
import { Effect, Option, Predicate, Result, Schema, String as Str } from "effect";
import { Hex } from "effect/encoding";
import { LeaseFenced } from "./lease.ts";
import { Micros, PriceMissing } from "./price-table.ts";

/**
 * A conversation with a cap of its own has settled at least that much, so its request was not sent. The rest of the
 * harness goes on: the lease is not fenced.
 */
export class ShareExhausted extends Schema.TaggedError<ShareExhausted, { readonly brand: unique symbol }>()(
	"ShareExhausted",
	{
		conversation: Conversation.Id,
		/** The conversation's cap, in micro units: any amount `setCap` was given, below zero included. */
		cap: Schema.BigInt,
		/**
		 * What the conversation's requests had settled when this one was refused, in micro units: what counts against
		 * the cap. In a copied storage that is what was settled before the copy and since.
		 */
		settled: Micros,
	},
) {
	override get message(): string {
		return `Conversation ${this.conversation} has settled ${this.settled} of its cap of ${this.cap} micro units`;
	}
}

/**
 * Why a request was not sent: the lease is fenced, the model has no price, or the conversation's cap is reached.
 * `Refusal.match` picks a handler per tag and `Refusal.guards` tests for one.
 */
export const Refusal = Schema.Union([LeaseFenced, PriceMissing, ShareExhausted]).pipe(Schema.toTaggedUnion("_tag"));

/** Why a request was not sent: the lease is fenced, the model has no price, or the conversation's cap is reached. */
export type Refusal = typeof Refusal.Type;

/**
 * The refusal a failed run or an unanswered submission of Pi was stopped by, read from its `detail` (the text of
 * `pi.live`'s `runFailure` and of the settled submission, both stored); none when the detail is not a refusal of
 * this package.
 */
export const refusalOf: (detail: unknown) => Effect.Effect<Option.Option<Refusal>> = Effect.fn("Refusal.refusalOf")(
	function* (detail) {
		// Stored input: Pi types a detail as any JSON value, and only a text can hold a refusal.
		if (!Predicate.isString(detail)) return Option.none();
		const payload = Option.flatMap(Str.match(PAYLOAD)(detail), (found) =>
			Option.flatMap(Option.fromNullishOr(found[1]), (hex) => Result.getSuccess(Hex.decodeString(hex))),
		);
		if (Option.isNone(payload)) return Option.none();
		// Stored text: anything that is not a refusal of this version is none.
		return yield* Effect.option(decodePayload(payload.value));
	},
);

/**
 * The error text a refused request ends with in pi-ai: a fixed sentence for the kind of refusal, then the refusal
 * itself as JSON in hexadecimal. Pi decides from an error's text whether to send the request again, and whether to
 * compact and send it again, so no word of a product's label or of a model's id may be read in it: hexadecimal
 * digits between brackets match none of pi-ai's patterns.
 */
export const refusalText = Effect.fn("Refusal.refusalText")(function* (refusal: Refusal) {
	// A refusal is one of this package's own classes, which always encode: a failure here is a broken invariant.
	const payload = yield* Effect.orDie(encodePayload(refusal));
	return `${sentence(refusal)} [budget:${Hex.encode(payload)}]`;
});

function sentence(refusal: Refusal): string {
	return Refusal.match(refusal, {
		LeaseFenced: () => "Budget: the lease is fenced, so the request was not sent.",
		PriceMissing: () => "Budget: the model has no price, so the request was not sent.",
		ShareExhausted: () => "Budget: the conversation has used up its share, so the request was not sent.",
	});
}

/** Matches the payload anywhere in a text: Pi may put words of its own before an error's text. */
const PAYLOAD = /\[budget:((?:[0-9a-f]{2})+)\]/;

const Payload = Schema.fromJsonString(Schema.toCodecJson(Refusal));

const encodePayload = Schema.encodeEffect(Payload);

const decodePayload = Schema.decodeUnknownEffect(Payload);
