// The registry a harness resolves extensions from, as a service built from Effect extensions.

import {
	createRegistry,
	defineExtension,
	type Registry as PiRegistry,
	type RegistryReader,
	type RegistrySnapshot,
	registryReader,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { RegistryValue } from "@effectified/pi-chord";
import { ChordContext } from "@effectified/pi-chord/context";
import type { SchemaConversionError } from "@effectified/pi-schema";
import { Context, Effect, Layer, type Scope } from "effect";
import type * as Extension from "./extension.ts";

/**
 * The Pi Durable registry of this program. The service value is Pi's own object, so Pi extensions can be installed
 * in it too, also while a harness runs.
 */
export class Registry extends Context.Service<Registry, PiRegistry>()("@effectified/pi-durable/Registry") {}

/**
 * A fresh registry with `extensions` installed, in order. The Layer requires what the handlers of the tools, hooks,
 * tasks, sections and wrappers need and captures it when it is built: every handler runs with that context, so a
 * registry whose handlers need a service does not build without it. Fails when a tool's parameters have no JSON
 * Schema.
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
			const sections = yield* Effect.forEach(extension.sections ?? [], (section) => section.registration);
			const wraps = yield* Effect.forEach(extension.wraps ?? [], (wrap) => wrap.registration);
			registry.install(
				defineExtension({
					name: extension.name,
					...(extension.namespace === undefined ? {} : { namespace: extension.namespace }),
					tools,
					hooks,
					tasks,
					sections,
					wraps,
				}),
			);
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

/**
 * Pi's `registryReader`: the registry a harness reads over a Chord registry value whose composition is a registry
 * snapshot (`Host.registry` of `@effectified/pi-chord`), for `Harness.layerOn`. It reads the current composition (the
 * last good one while Chord's `compose` fails) and wakes the harness at each new one, until the scope closes.
 */
export function reader<Tool extends ToolRegistration = ToolRegistration>(
	value: RegistryValue<RegistrySnapshot<Tool>>,
): Effect.Effect<RegistryReader<Tool>, never, Scope.Scope> {
	return Effect.map(ChordContext.scoped(), (context) => registryReader(value, context));
}
