// Extensions: named bundles of what a registry installs: tools, hooks, tasks, prompt sections and wrappers.

import type { ToolNamespace } from "@earendil-works/pi-durable";
import type * as Hook from "./hook.ts";
import type * as Section from "./section.ts";
import type * as Task from "./task.ts";
import type * as Tool from "./tool.ts";
import type * as Wrap from "./wrap.ts";

/** A named bundle of tools, hooks, tasks, prompt sections and wrappers. A plain object; `make` only types it. */
export interface Extension<
	Tools extends ReadonlyArray<Tool.Any> = ReadonlyArray<Tool.Any>,
	Hooks extends ReadonlyArray<Hook.Any> = ReadonlyArray<Hook.Any>,
	Tasks extends ReadonlyArray<Task.Any> = ReadonlyArray<Task.Any>,
	Sections extends ReadonlyArray<Section.Any> = ReadonlyArray<Section.Any>,
	Wraps extends ReadonlyArray<Wrap.Any> = ReadonlyArray<Wrap.Any>,
> {
	/** The name conversations select the extension by, and Pi stores. */
	readonly name: string;
	/**
	 * The code-mode namespace of the extension's tools, passed on unchanged: the `codemode` section lists it while the
	 * extension is selected.
	 */
	readonly namespace?: ToolNamespace;
	readonly tools?: Tools;
	/** Asked in this order, after the hooks of the extensions installed before this one. */
	readonly hooks?: Hooks;
	/** Found by name for every task of their kind, whichever conversations select this extension. */
	readonly tasks?: Tasks;
	/** Rendered in this order into the system prompt of a conversation that selects the extension (`Section.make`). */
	readonly sections?: Sections;
	/** Applied in this order where the extension is selected (`Tool.wrap`, `Section.wrap`). */
	readonly wraps?: Wraps;
}

/** The elements of the optional array field `K` of `E`. */
type Items<E, K extends string> = E extends { readonly [F in K]?: infer Field }
	? Field extends ReadonlyArray<infer Item>
		? Item
		: never
	: never;

/** The services the tools, hooks, tasks, sections and wrappers of an extension, or of each of a union, need to run. */
export type Services<E> =
	| Tool.Services<Items<E, "tools">>
	| Hook.Services<Items<E, "hooks">>
	| Task.Services<Items<E, "tasks">>
	| Section.Services<Items<E, "sections">>
	| Wrap.Services<Items<E, "wraps">>;

/**
 * Types an extension, as Pi's `defineExtension` does, keeping each tool's, hook's, task's, section's and wrapper's own
 * type. `NoInfer`: they are read from the argument only, so an extension made inside an array of extensions without
 * some of them still needs nothing for those.
 */
export function make<
	const Tools extends ReadonlyArray<Tool.Any> = readonly [],
	const Hooks extends ReadonlyArray<Hook.Any> = readonly [],
	const Tasks extends ReadonlyArray<Task.Any> = readonly [],
	const Sections extends ReadonlyArray<Section.Any> = readonly [],
	const Wraps extends ReadonlyArray<Wrap.Any> = readonly [],
>(
	extension: Extension<Tools, Hooks, Tasks, Sections, Wraps>,
): Extension<NoInfer<Tools>, NoInfer<Hooks>, NoInfer<Tasks>, NoInfer<Sections>, NoInfer<Wraps>> {
	return extension;
}
