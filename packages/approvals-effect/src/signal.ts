// The signal a decision travels in.

import { Signal } from "@effectified/pi-durable";
import { Decision } from "./decision.ts";

/** A decision, delivered to the tool call's task under the request's id. */
export const Decided: Signal.Signal<typeof Decision> = Signal.make("approvals.decision", 1, Decision);
