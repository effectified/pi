// Bun's `bun:ffi` module as far as bun.ts uses it, typed here because the repository installs no Bun types.

/** The part of `bun:ffi` used: `dlopen` opens a shared library and binds the named C functions. */
export interface BunFfi {
	/** Argument and return types are given by Bun's names for them (`ptr`, `i32`). */
	dlopen(
		name: string,
		symbols: Readonly<Record<string, { readonly args: ReadonlyArray<string>; readonly returns: string }>>,
	): {
		readonly symbols: Readonly<Record<string, (...args: ReadonlyArray<unknown>) => unknown>>;
		close(): void;
	};
}

/**
 * Bun's `bun:ffi` module, or undefined on another runtime. It is read through `process.getBuiltinModule` and not
 * imported: upstream's `check-runtime-deps`, which this fork may not edit, knows the built-in modules of Node and of
 * Workers and takes `bun:ffi` for an undeclared package.
 */
export function bunFfi(): BunFfi | undefined {
	// A cast at the runtime's untyped boundary: Node's types know only Node's own built-in modules.
	return process.getBuiltinModule("bun:ffi") as BunFfi | undefined;
}
