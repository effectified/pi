// The subagent extension: the tools and the run task over a product's declarations, as one thing a registry installs.

import { Extension } from "@effectified/pi-durable";
import { Effect } from "effect";
import * as Declared from "./declared.ts";
import * as Run from "./run.ts";
import * as Tools from "./tools.ts";

/** What a product declares: the subagents a parent may start, and the limits on starting them. */
export type Config = Declared.Config;

/** The extension's name: what a conversation that selects extensions by name lists to get the tools. */
export const EXTENSION = "subagent";

/** The names of the tools: `foreground` waits for the child, `background` starts one, `status` reads one. */
export const TOOLS = Tools.NAMES;

/** The kind of the task that drives a child, as Pi's task graph shows it: one live task per child at work. */
export const TASK = Run.NAME;

/** The kind of the entry a background child's result is placed as in its parent, for a UI that shows it. */
export const REPORT = Run.REPORT;

/**
 * The extension for `config`: install it with `Registry.layer`, after a guard's. A conversation gets the tools as it
 * gets any tool, by its agent's `tools`; a child gets them only when its declaration lists them, within `maxDepth`.
 * The registry then requires the product's `ChildSetup`, and fails to build when two declarations share a name or a
 * declared result has no JSON Schema.
 */
export function extension(config: Config) {
	// Compiling the result schemas is the cost of a declaration: paid once, when the registry is built.
	const declared = Effect.runSync(Effect.cached(Declared.make(config)));
	const run = Run.make(declared);
	return Extension.make({ name: EXTENSION, tools: Tools.make(config, declared, run), tasks: [run] });
}
