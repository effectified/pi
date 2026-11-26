// pi-coding-agent's clipboard in Effect: copying text to the system clipboard (or the terminal's, over OSC 52).

import { copyToClipboard as piCopyToClipboard } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { type CodingAgentFailure, fromPi } from "./errors.ts";

/** Copies `text` to the clipboard, as Pi's `/copy` does. */
export function copyToClipboard(text: string): Effect.Effect<void, CodingAgentFailure> {
	return Effect.tryPromise({ try: () => piCopyToClipboard(text), catch: fromPi });
}
