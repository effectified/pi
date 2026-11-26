// pi-ai's diagnostics of an assistant message, stamped with the time of `Clock`.

import {
	type AssistantMessageDiagnostic,
	type JsonObject,
	createAssistantMessageDiagnostic as piCreateAssistantMessageDiagnostic,
} from "@earendil-works/pi-ai";
import { Clock, Effect } from "effect";

/**
 * A diagnostic of `type` for `error` (pi-ai's `createAssistantMessageDiagnostic`: the error's name, message, stack
 * and code, and `details`), stamped now by `Clock`. Add it to a message with pi-ai's
 * `appendAssistantMessageDiagnostic`.
 */
export function createAssistantMessageDiagnostic(
	type: string,
	error: unknown,
	details?: JsonObject,
): Effect.Effect<AssistantMessageDiagnostic> {
	return Effect.map(Clock.currentTimeMillis, (timestamp) => ({
		...piCreateAssistantMessageDiagnostic(type, error, details),
		timestamp,
	}));
}
