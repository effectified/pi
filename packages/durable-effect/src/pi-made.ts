// What Pi makes itself (its built-in tools, tool search, code mode, image fitting) in this package's form, so a
// registry installs it beside extensions of this package.

import type {
	HookRegistration,
	Extension as PiExtension,
	PromptSection,
	ToolRegistration,
	Wrap,
} from "@earendil-works/pi-durable";
import { Array as Arr, Effect } from "effect";
import type { Extension } from "./extension.ts";
import { ToolName } from "./tool-name.ts";

/** One of Pi's own tools: its name, and what builds its registration, which may need the services `R`. */
export interface PiTool<R = never> {
	readonly name: ToolName;
	readonly registration: Effect.Effect<ToolRegistration, never, R>;
}

/** Pi's own hook, section or wrapper: what builds it. */
interface Registered<A> {
	readonly registration: Effect.Effect<A, never>;
}

/** One of Pi's own sections, with its key. */
interface PiSection extends Registered<PromptSection> {
	readonly key: string;
}

/** An extension Pi made, in this package's form: what it holds needs no service. */
export interface PiMade extends Extension<
	ReadonlyArray<PiTool>,
	ReadonlyArray<Registered<HookRegistration>>,
	readonly [],
	ReadonlyArray<PiSection>,
	ReadonlyArray<Registered<Wrap>>
> {}

/** `tool` as one of this package's: Pi's name, branded where it enters. */
export function tool(registration: ToolRegistration): PiTool {
	return { name: ToolName.make(registration.name), registration: Effect.succeed(registration) };
}

/**
 * `extension`, made by Pi, as one of this package's: its name, namespace, tools, hooks, sections and wrappers, each as
 * Pi made it. The extensions Pi makes have no tasks.
 */
export function extension(made: PiExtension): PiMade {
	return {
		name: made.name,
		...(made.namespace === undefined ? {} : { namespace: made.namespace }),
		tools: Arr.map(made.tools ?? [], tool),
		hooks: Arr.map(made.hooks ?? [], (hook) => ({ registration: Effect.succeed(hook) })),
		sections: Arr.map(made.sections ?? [], (section) => ({
			key: section.key,
			registration: Effect.succeed(section),
		})),
		wraps: Arr.map(made.wraps ?? [], (wrap) => ({ registration: Effect.succeed(wrap) })),
	};
}
