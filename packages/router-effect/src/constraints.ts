// What a request tells the router about itself: the classification of its content, the regions that may serve it, and
// the labels a route must carry.

import type { JsonObject } from "@effectified/pi-ai";
import { Effect, Schema } from "effect";
import { InvalidConstraints } from "./errors.ts";

/**
 * A label a product puts on a route and a request asks for, such as `zero-data-retention`: any text that is not empty
 * and has no white space. The router gives a label no meaning: a route carries it or does not.
 */
export const Label = Schema.String.check(Schema.isPattern(/^\S+$/));

/** A label a product puts on a route and a request asks for. */
export type Label = typeof Label.Type;

/**
 * The constraints of one request, the defaults of an alias, or what a `ConstraintSource` says of a conversation.
 * `classification` is one of the table's labels; a request without one is treated as the highest label. `regions` are
 * the regions that may serve the request; a request without them may be served from any region. `requires` are the
 * labels a route must carry, every one of them; a request without them asks for none.
 */
export const Constraints = Schema.Struct({
	classification: Schema.optional(Schema.String),
	regions: Schema.optional(Schema.Array(Schema.String)),
	requires: Schema.optional(Schema.Array(Label)),
});

/** The constraints of one request, the defaults of an alias, or what a `ConstraintSource` says of a conversation. */
export type Constraints = typeof Constraints.Type;

/** The key of pi-ai's request `metadata` under which a request carries its constraints to the router. */
export const METADATA_KEY = "pi-router";

/**
 * `constraints` as pi-ai request metadata, for the `metadata` option of a pi-ai request or of a Pi Durable
 * conversation's stream settings. Spread it into metadata that has other keys.
 */
export function constraintsToMetadata(constraints: Constraints): JsonObject {
	return {
		[METADATA_KEY]: {
			...(constraints.classification === undefined ? {} : { classification: constraints.classification }),
			...(constraints.regions === undefined ? {} : { regions: constraints.regions }),
			...(constraints.requires === undefined ? {} : { requires: constraints.requires }),
		},
	};
}

const decodeConstraints = Schema.decodeUnknownEffect(Constraints);

/**
 * The constraints a pi-ai request to `alias` carries in its `metadata`: `undefined` when it carries none. Wire
 * input: fails with `InvalidConstraints` when the value under `METADATA_KEY` is not the shape of `Constraints`.
 */
export function constraintsFromMetadata(
	alias: string,
	metadata: Record<string, unknown> | undefined,
): Effect.Effect<Constraints | undefined, InvalidConstraints> {
	const value = metadata?.[METADATA_KEY];
	if (value === undefined) return Effect.succeed(undefined);
	return Effect.mapError(
		decodeConstraints(value),
		(error) => new InvalidConstraints({ alias, reason: `metadata["${METADATA_KEY}"]: ${error.message}` }),
	);
}
