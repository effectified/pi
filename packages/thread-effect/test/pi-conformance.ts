// What thread-effect writes of Pi Durable's types by hand, checked against Pi's own types. Type-only: nothing here
// runs. The agent change of a swarm's forks is the facade's `Agent.ByName`, which the facade checks.

import type { AgentChange } from "@earendil-works/pi-durable";
import type { Assert, Conform } from "../../../effect/conformance.ts";
import type { Threads } from "../src/index.ts";

/** The fields of a thread's agent that `Work` sets. */
type Fields = "model" | "instructions" | "maxTurns";

/**
 * What a thread's work sets of its agent is Pi's own type of each field, without `null`: a field Pi renames or retypes
 * fails here. (The bounds Pi's `configure` adds, such as turns of 1 or more, `admit` checks through `Agent.ByName`.)
 */
export type WorkAgentFields = Assert<
	Conform<Required<Pick<Threads.Work, Fields>>, { readonly [K in Fields]-?: NonNullable<AgentChange[K]> }>
>;
