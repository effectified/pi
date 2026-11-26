// Whether the terminal speaks the Kitty keyboard protocol: the process-wide flag pi-tui's key decoding reads.

import {
	isKittyProtocolActive as piIsKittyProtocolActive,
	setKittyProtocolActive as piSetKittyProtocolActive,
} from "@earendil-works/pi-tui";
import { Effect } from "effect";

/** Whether the Kitty keyboard protocol is on, as the running terminal found when it started. */
export const isKittyProtocolActive: Effect.Effect<boolean> = Effect.sync(piIsKittyProtocolActive);

/**
 * Sets the flag pi-tui's key decoding reads. pi-tui's terminal sets it when the terminal confirms the protocol and
 * clears it when it stops; set it only for a terminal of your own.
 */
export function setKittyProtocolActive(active: boolean): Effect.Effect<void> {
	return Effect.sync(() => piSetKittyProtocolActive(active));
}
