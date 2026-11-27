// The name of a subagent, branded so that a task text, a handle or any other string is never taken for one.

import { Schema } from "effect";

/**
 * The name of a declared subagent: what the parent's model passes to the tools, the key a declaration is found by,
 * and what a child's records keep. Names are plain strings where they enter: `Subagent.make` brands a declaration's,
 * and the tools' parameters and a child's stored records brand theirs when they are decoded.
 */
export const Name = Schema.String.pipe(Schema.brand("@effectified/pi-subagent/SubagentName"));

/** The name of a declared subagent. */
export type Name = typeof Name.Type;
