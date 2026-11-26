// `@effectified/pi-durable/tool-search`: Pi's `tool_search` tool, which loads deferred tools into a conversation, as a
// tool and an extension of this package.

import { createToolSearchExtension, createToolSearchTool } from "@earendil-works/pi-durable/tool-search";
import { extension as fromPi, type PiMade, type PiTool, tool as piTool } from "./pi-made.ts";

export type { ToolSearchToolDetails } from "@earendil-works/pi-durable/tool-search";
// The tool's name and how many tools one search returns by default.
export { DEFAULT_TOOL_SEARCH_LIMIT, TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";
export type { PiMade, PiTool } from "./pi-made.ts";

/** Pi's `tool_search`: the model finds deferred tools by keyword and loads them for the rest of the run. */
export const tool: PiTool = piTool(createToolSearchTool());

/** Pi's `tool-search` extension: the tool, with what Pi gives it besides. */
export const extension: PiMade = fromPi(createToolSearchExtension());
