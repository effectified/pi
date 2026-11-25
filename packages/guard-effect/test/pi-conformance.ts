// What guard-effect reads of Pi Durable's stored shapes by hand, checked against Pi's own types. Type-only: nothing
// here runs. The backstop's members are decided where they are written (`MEMBERS` in `backstop.ts`).

import type { AgentState } from "@earendil-works/pi-durable";
import type { Assert, Conform } from "../../../effect/conformance.ts";

/**
 * `Conversations.grantIn` with `mode: "narrow"` reads a stored agent's tools in exactly these forms: a list enables
 * exactly those, an edit enables all but its `remove`. A form or an edit key Pi adds fails here until it is read.
 */
export type StoredToolsRead = Assert<
	Conform<NonNullable<AgentState["tools"]>, ReadonlyArray<string> | { readonly remove: ReadonlyArray<string> }>
>;
