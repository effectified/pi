// The signal a decision travels in.

import { Signal } from "@gunta/pi-durable-effect";
import { Decision } from "./decision.ts";

/** A decision, delivered to the tool call's task under the request's id. */
export const Decided: Signal.Signal<typeof Decision> = Signal.make("approvals.decision", 1, Decision);
