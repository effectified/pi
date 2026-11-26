// pi-ai's time-ordered ids (UUIDv7), with the time from `Clock`.

import { uuidv7 as piUuidv7 } from "@earendil-works/pi-ai";
import { Clock, Effect } from "effect";

/**
 * A new UUIDv7 stamped with the time of `Clock` (pi-ai's `uuidv7` with that timestamp), so `TestClock` sets the time
 * part. The rest is pi-ai's: a sequence shared by the process keeps ids of one millisecond unique and in order, and
 * its first value is random.
 */
export const uuidv7: Effect.Effect<string> = Effect.map(Clock.currentTimeMillis, (timestamp) => piUuidv7(timestamp));
