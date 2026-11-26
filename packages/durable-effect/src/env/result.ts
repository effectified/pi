// Pi's `Result`, which an environment's operations return, as an Effect.

import type { Result } from "@earendil-works/pi-durable/env";
import { Effect } from "effect";

/**
 * The value of an `ok` result, or the error of an `err` result as the failure (Pi's `getOrThrow`, which throws it).
 * Map Pi's error to a tagged one with `Effect.mapError`.
 */
export function fromResult<A, E>(result: Result<A, E>): Effect.Effect<A, E> {
	return result.ok ? Effect.succeed(result.value) : Effect.fail(result.error);
}
