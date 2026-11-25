// pi-ai's stop reasons: which of them end a response that answered.

import type { StopReason } from "@earendil-works/pi-ai";

/**
 * Whether a model response with this stop reason answered: Pi Durable's own rule, which runs the tools of a `toolUse`
 * response and takes a `stop`, `length` or `toolUse` response as the answer, and stores every other one as a failed
 * attempt (`error`, `aborted`, a `pending` partial, a `deferred` response still to be fetched). Typed by pi-ai's
 * `StopReason`, so a stop reason pi-ai adds fails to compile here until it is decided.
 */
export const ANSWERED = {
	stop: true,
	length: true,
	toolUse: true,
	error: false,
	aborted: false,
	pending: false,
	deferred: false,
} as const satisfies Record<StopReason, boolean>;
