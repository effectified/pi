// The registry a harness resolves extensions from, as a service built from Effect extensions.

import { createRegistry, defineExtension, type Registry as PiRegistry } from "@earendil-works/pi-durable";
import type { SchemaConversionError } from "@effectified/pi-schema";
import { Context, Effect, Layer } from "effect";
import type * as Extension from "./extension.ts";

/**
 * The Pi Durable registry of this program. The service value is Pi's own object, so Pi extensions can be installed
 * in it too, also while a harness runs.
 */
export class Registry extends Context.Service<Registry, PiRegistry>()("@effectified/pi-durable/Registry") {}

/**
 * A fresh registry with `extensions` installed, in order. The Layer requires what the handlers of the tools, hooks
 * and tasks need and captures it when it is built: every handler runs with that context, so a registry whose tools,
 * hooks or task phases need a service does not build without it. Fails when a tool's parameters have no JSON Schema.
 */
export function layer<const Extensions extends ReadonlyArray<Extension.Extension>>(
	extensions: Extensions,
): Layer.Layer<Registry, SchemaConversionError, Extension.Services<Extensions[number]>> {
	const build = Effect.gen(function* () {
		const registry = createRegistry();
		for (const extension of extensions) {
			const tools = yield* Effect.forEach(extension.tools ?? [], (tool) => tool.registration);
			const hooks = yield* Effect.forEach(extension.hooks ?? [], (hook) => hook.registration);
			const tasks = yield* Effect.forEach(extension.tasks ?? [], (task) => task.registration);
			registry.install(defineExtension({ name: extension.name, tools, hooks, tasks }));
		}
		return registry;
	});
	return Layer.effect(
		Registry,
		// TypeScript cannot carry each registration's requirement through the arrays, where it is `unknown`: by
		// construction they need the union of what the tools, hooks and tasks need, which is `Extension.Services`.
		build as Effect.Effect<PiRegistry, SchemaConversionError, Extension.Services<Extensions[number]>>,
	);
}
