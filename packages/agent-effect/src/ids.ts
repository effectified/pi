// The names of tools and the ids of their calls, branded so that a tool's name is never passed for a call's id. The
// call id is pi-ai's, so @effectified/pi-ai owns its brand; it is re-exported here for the tools of this package.

import { Schema } from "effect";

export { ToolCallId } from "@effectified/pi-ai";

/**
 * The name of a tool: what the model calls it by, unique among the tools of an agent, a loop or a sandbox. Pi's names
 * are plain strings; `Tool.make` brands the one it is given (`Lookup.name`), and `ToolName.make("lookup")` brands one
 * a caller holds.
 */
export const ToolName = Schema.String.pipe(Schema.brand("ToolName"));

/** The name of a tool. */
export type ToolName = typeof ToolName.Type;
