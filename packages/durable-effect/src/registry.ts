// The registry a harness resolves extensions from, as a service built from Effect extensions.

import {
	createRegistry,
	defineExtension,
	type HookRegistration,
	type Extension as PiExtension,
	type Registry as PiRegistry,
	type PromptSection,
	type RegistryReader,
	type RegistrySnapshot,
	registryReader,
	type ToolRegistration,
	type Wrap,
} from "@earendil-works/pi-durable";
import type { RegistryValue } from "@effectified/pi-chord";
import { ChordContext } from "@effectified/pi-chord/context";
import type { SchemaConversionError } from "@effectified/pi-schema";
import { Context, Effect, Layer, type Scope } from "effect";
import type * as Extension from "./extension.ts";
import type * as Task from "./task.ts";

/**
 * The Pi Durable registry of this program. The service value is Pi's own object, so Pi extensions can be installed
 * in it too, also while a harness runs.
 */
export class Registry extends Context.Service<Registry, PiRegistry>()("@effectified/pi-durable/registry") {}

/**
 * A fresh registry with `extensions` installed, in order. The Layer requires what the handlers of the tools, hooks,
 * tasks, sections and wrappers need and captures it when it is built: every handler runs with that context, so a
 * registry whose handlers need a service does not build without it. Fails when a tool's parameters have no JSON
 * Schema.
 */
export function layer<const Extensions extends ReadonlyArray<Extension.Extension>>(
	extensions: Extensions,
): Layer.Layer<Registry, SchemaConversionError, Extension.Services<Extensions[number]>> {
	return Layer.effect(Registry, installed<Extension.Services<Extensions[number]>>(extensions));
}

/** What an extension holds, each member's registration needing `R`. */
interface Members<R> {
	readonly name: string;
	readonly namespace?: Extension.Extension["namespace"];
	readonly tools?: ReadonlyArray<{ readonly registration: Effect.Effect<ToolRegistration, SchemaConversionError, R> }>;
	readonly hooks?: ReadonlyArray<{ readonly registration: Effect.Effect<HookRegistration, never, R> }>;
	readonly tasks?: ReadonlyArray<{ readonly registration: Effect.Effect<Task.Token, never, R> }>;
	readonly sections?: ReadonlyArray<{ readonly registration: Effect.Effect<PromptSection, never, R> }>;
	readonly wraps?: ReadonlyArray<{ readonly registration: Effect.Effect<Wrap, never, R> }>;
}

/** A fresh Pi registry with `extensions` installed in order, every member registered with the services `R`. */
const installed = Effect.fn("Registry.install")(function* <R>(extensions: ReadonlyArray<Extension.Extension>) {
	const registry = createRegistry();
	// TypeScript reads each member of a generic tuple through its constraint, where a registration needs `unknown`: by
	// construction the members need the union `Extension.Services` reads from the tuple, which is `R`.
	const members = extensions as ReadonlyArray<Members<R>>;
	yield* Effect.forEach(members, (extension) => Effect.map(piExtension(extension), (made) => registry.install(made)), {
		concurrency: 1,
		discard: true,
	});
	return registry;
});

/** Pi's extension for `extension`: its name and namespace, and every member registered, in order. */
function piExtension<R>(extension: Members<R>): Effect.Effect<PiExtension, SchemaConversionError, R> {
	return Effect.map(
		Effect.all(
			{
				tools: Effect.forEach(extension.tools ?? [], (tool) => tool.registration, { concurrency: 1 }),
				hooks: Effect.forEach(extension.hooks ?? [], (hook) => hook.registration, { concurrency: 1 }),
				tasks: Effect.forEach(extension.tasks ?? [], (task) => task.registration, { concurrency: 1 }),
				sections: Effect.forEach(extension.sections ?? [], (section) => section.registration, { concurrency: 1 }),
				wraps: Effect.forEach(extension.wraps ?? [], (wrap) => wrap.registration, { concurrency: 1 }),
			},
			{ concurrency: 1 },
		),
		(members) =>
			defineExtension({
				name: extension.name,
				...(extension.namespace === undefined ? {} : { namespace: extension.namespace }),
				...members,
			}),
	);
}

/**
 * Pi's `registryReader`: the registry a harness reads over a Chord registry value whose composition is a registry
 * snapshot (`Host.registry` of `@effectified/pi-chord`), for `Harness.layerOn`. It reads the current composition (the
 * last good one while Chord's `compose` fails) and wakes the harness at each new one, until the scope closes.
 * Untraced: the Chord context it reads under takes the fiber's span, and lives for the scope, past a span of its own.
 */
export const reader: <Tool extends ToolRegistration = ToolRegistration>(
	value: RegistryValue<RegistrySnapshot<Tool>>,
) => Effect.Effect<RegistryReader<Tool>, never, Scope.Scope> = Effect.fnUntraced(function* <
	Tool extends ToolRegistration,
>(value: RegistryValue<RegistrySnapshot<Tool>>) {
	const context = yield* ChordContext.scoped();
	return registryReader(value, context);
});
