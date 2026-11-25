// What subagent-effect writes of Pi Durable's types by hand, checked against Pi's own types. Type-only: nothing here
// runs. `ChildAgent` stays written field by field for the words each field has for a declaration; `exactly` sets
// every field of Pi's change (`Required<Agent.Change>`), so a field Pi adds fails there too.

import type { AgentChange } from "@earendil-works/pi-durable";
import type { Assert, Conform, Covers } from "../../../effect/conformance.ts";
import type { Subagent } from "../src/index.ts";

/** The lists of tools and extensions: a declaration gives exactly these, never an edit of the parent's. */
type Lists = "tools" | "extensions" | "modelTools";

/** Every field of Pi's agent change can be declared for a child: a field Pi adds fails here until it can. */
export type ChildAgentCovers = Assert<Covers<AgentChange, Subagent.ChildAgent>>;

/** Every declared field but the lists is Pi's own type of it, without `null` (a field left out is cleared). */
export type ChildAgentFields = Assert<
	Conform<
		Required<Omit<Subagent.ChildAgent, Lists>>,
		{ readonly [K in Exclude<keyof AgentChange, Lists>]-?: NonNullable<AgentChange[K]> }
	>
>;
