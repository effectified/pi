// The name of a tool of a Pi Durable registry, branded so that an extension's name or any other string is never taken
// for one.

import { Schema } from "effect";

/**
 * The name of a tool: what a conversation's agent enables and offers it by (`Agent.Change.tools`), what a nested call
 * and a wrapper name it by. Pi's names are plain strings; the brand is applied where one enters this package:
 * `Tool.make` and Pi's tools of `/tools` brand their own, `ToolName.make("read")` brands a literal, and decoding
 * `Agent.ByName` brands a stored one. Pi checks a name where a tool is registered.
 */
export const ToolName = Schema.String.pipe(Schema.brand("@effectified/pi-durable/ToolName"));

/** The name of a tool. */
export type ToolName = typeof ToolName.Type;
