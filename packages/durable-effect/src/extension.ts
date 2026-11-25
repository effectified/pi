// Extensions: named bundles of what a registry installs: tools, hooks and tasks.

import type * as Hook from "./hook.ts";
import type * as Task from "./task.ts";
import type * as Tool from "./tool.ts";

/** A named bundle of tools, hooks and tasks. A plain object; `make` only types it. */
export interface Extension<
	Tools extends ReadonlyArray<Tool.Any> = ReadonlyArray<Tool.Any>,
	Hooks extends ReadonlyArray<Hook.Any> = ReadonlyArray<Hook.Any>,
	Tasks extends ReadonlyArray<Task.Any> = ReadonlyArray<Task.Any>,
> {
	/** The name conversations select the extension by, and Pi stores. */
	readonly name: string;
	readonly tools?: Tools;
	/** Asked in this order, after the hooks of the extensions installed before this one. */
	readonly hooks?: Hooks;
	/** Found by name for every task of their kind, whichever conversations select this extension. */
	readonly tasks?: Tasks;
}

/** The services the tools, hooks and tasks of an extension, or of each extension of a union, need to run. */
export type Services<E> =
	| (E extends { readonly tools?: infer Tools }
			? Tools extends ReadonlyArray<infer T>
				? Tool.Services<T>
				: never
			: never)
	| (E extends { readonly hooks?: infer Hooks }
			? Hooks extends ReadonlyArray<infer H>
				? Hook.Services<H>
				: never
			: never)
	| (E extends { readonly tasks?: infer Tasks }
			? Tasks extends ReadonlyArray<infer T>
				? Task.Services<T>
				: never
			: never);

/**
 * Types an extension, as Pi's `defineExtension` does, keeping each tool's, each hook's and each task's own type.
 * `NoInfer`: they are read from the argument only, so an extension without tools, hooks or tasks made inside an array
 * of extensions still needs nothing.
 */
export function make<
	const Tools extends ReadonlyArray<Tool.Any> = readonly [],
	const Hooks extends ReadonlyArray<Hook.Any> = readonly [],
	const Tasks extends ReadonlyArray<Task.Any> = readonly [],
>(extension: Extension<Tools, Hooks, Tasks>): Extension<NoInfer<Tools>, NoInfer<Hooks>, NoInfer<Tasks>> {
	return extension;
}
