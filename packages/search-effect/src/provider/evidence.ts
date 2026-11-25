// Evidence of one provider call: what was asked, what came back byte for byte, from whom and when. It is plain
// data with a JSON form, so a product can store it beside what it concluded from the call.

import { type Effect, Schema } from "effect";

/** The request as the provider received it, without its headers: they carry the credentials. */
export const ProviderRequest = Schema.Struct({
	method: Schema.String,
	url: Schema.String,
	body: Schema.Json,
});

/** The request as the provider received it, without credentials. */
export type ProviderRequest = typeof ProviderRequest.Type;

/** One provider call, kept whole. */
export const Evidence = Schema.Struct({
	/** The provider's name, such as `exa`. */
	provider: Schema.String,
	request: ProviderRequest,
	/** When the response had arrived, on Effect's `Clock`. */
	retrievedAt: Schema.DateTimeUtc,
	/** The response body exactly as the provider sent it: JSON text, never parsed and written again. */
	raw: Schema.String,
});

/** One provider call, kept whole. */
export type Evidence = typeof Evidence.Type;

const EvidenceJson = Schema.toCodecJson(Evidence);

/** The JSON form of `evidence`: `retrievedAt` as an ISO 8601 string, the rest as it is. */
export function toJson(evidence: Evidence): Effect.Effect<Schema.Json, Schema.SchemaError> {
	return Schema.encodeEffect(EvidenceJson)({
		provider: evidence.provider,
		request: evidence.request,
		retrievedAt: evidence.retrievedAt,
		raw: evidence.raw,
	});
}

/** The evidence in `json`, such as a stored tool result's details; fails when `json` is something else. */
export function fromJson(json: unknown): Effect.Effect<Evidence, Schema.SchemaError> {
	return Schema.decodeUnknownEffect(EvidenceJson)(json);
}
