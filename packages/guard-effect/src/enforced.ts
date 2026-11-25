// Which registries a guard built: what tells a conversation that runs under a guard from one that only names it.

import type { Service } from "./guard.ts";

// Beside the service and held weakly: the service stays plain data, so one made by hand built nothing, and a guard
// nobody holds frees what it kept of its registries.
const built = new WeakMap<Service, Set<object>>();

/** Records the guard's own extension as a registry `guard` just built holds it. Only `Guard.registry` calls this. */
export function bind(guard: Service, extension: object): void {
	const extensions = built.get(guard) ?? new Set<object>();
	built.set(guard, extensions.add(extension));
}

/** Whether `guard` built a registry at all: without one it has no hook, and nothing enforces what it stores. */
export function any(guard: Service): boolean {
	return built.has(guard);
}

/**
 * Whether `extension` is the guard's own in a registry `guard` built. The object is compared, never the name: an
 * extension called `guard` in another registry, or installed later in its place, is not the guard's.
 */
export function owns(guard: Service, extension: object | undefined): boolean {
	return extension !== undefined && built.get(guard)?.has(extension) === true;
}
