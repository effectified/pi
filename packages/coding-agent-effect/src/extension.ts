// A Pi extension written in Effect: tools, commands, shortcuts, flags and event handlers as Effects that use services,
// turned into the inline extension (or the extension factory) a Pi host loads like any other.

import type {
	ExtensionAPI,
	ExtensionFactory,
	InlineExtension,
	ExtensionContext as PiContext,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type * as Command from "./command.ts";
import { ExtensionApi, fromPiApi, type Shortcut } from "./extension-api.ts";
import {
	ExtensionContext,
	fromPiContext,
	fromPiProjectTrustContext,
	ProjectTrustContext,
} from "./extension-context.ts";
import type { Services as HandlerServices, Handlers } from "./handlers.ts";
import { type Run, runner } from "./runner.ts";
import type * as Tool from "./tool.ts";

/** A CLI flag the extension declares: Pi's `registerFlag` options and the flag's name. */
export type Flag = Parameters<ExtensionAPI["registerFlag"]>[1] & { readonly name: string };

/** What an extension registers when Pi loads it. */
export interface Definition {
	readonly tools?: ReadonlyArray<Tool.Any<unknown>>;
	readonly commands?: ReadonlyArray<Command.Any<unknown>>;
	readonly shortcuts?: ReadonlyArray<Shortcut<unknown>>;
	readonly flags?: ReadonlyArray<Flag>;
	/** The handlers of the session's events, asked in the order the extensions were loaded. */
	readonly on?: Handlers;
	/** Runs when Pi loads the extension, after the rest is registered: for what depends on flags or settings. */
	readonly setup?: Effect.Effect<void, unknown, unknown>;
	/** Leaves the extension out of Pi's startup list. */
	readonly hidden?: boolean;
	/** Leaves the extension out when another registers a tool, command or flag of its names (Pi's `replaceable`). */
	readonly replaceable?: boolean;
}

/** Pi's inline extension in its named form, the one `make` gives. */
export type Inline = Exclude<InlineExtension, ExtensionFactory>;

/** An extension made by `make`. */
export interface Extension<R> {
	readonly name: string;
	/** Pi's inline extension; its Effects run with the services of the context this Effect runs in. */
	readonly inline: Effect.Effect<Inline, never, R>;
}

/** The services an extension of `D` needs: those of its tools, commands, shortcuts, handlers and setup. */
export type Services<D extends Definition> = Exclude<
	| (D["tools"] extends ReadonlyArray<infer T> ? (T extends Tool.Any<infer R> ? R : never) : never)
	| (D["commands"] extends ReadonlyArray<infer C> ? (C extends Command.Any<infer R> ? R : never) : never)
	| (D["shortcuts"] extends ReadonlyArray<infer S> ? (S extends Shortcut<infer R> ? R : never) : never)
	| HandlerServices<NonNullable<D["on"]>>
	| (D["setup"] extends Effect.Effect<infer _A, infer _E, infer R> ? R : never),
	ExtensionApi | ExtensionContext
>;

/**
 * Defines the extension `name`. When Pi loads it, its tools, commands, shortcuts, flags and handlers are registered,
 * then `setup` runs. Every Effect of the extension has `ExtensionApi` (the API of this load: Pi loads an extension
 * again on reload) and the services of the context `inline` runs in.
 */
export function make<const D extends Definition>(name: string, definition: D): Extension<Services<D>> {
	return {
		name,
		inline: Effect.map(Effect.context<Services<D>>(), (context): Inline => {
			const run = runner(context);
			return {
				name,
				// `load` needs exactly the services `Services<D>` collects from the definition's Effects, which TypeScript
				// cannot follow through its loops.
				factory: (pi) => run(load(definition, pi) as Effect.Effect<void, unknown, Services<D>>),
				...(definition.hidden === undefined ? {} : { hidden: definition.hidden }),
				...(definition.replaceable === undefined ? {} : { replaceable: definition.replaceable }),
			};
		}),
	};
}

/**
 * Pi's extension factory of `extension`, for a file a Pi host loads (`export default Extension.factory(extension)`).
 * The extension needs no service besides those Pi gives; one that does provides them to its Effects itself.
 */
export function factory(extension: Extension<never>): ExtensionFactory {
	return Effect.runSync(extension.inline).factory;
}

/** Registers what `definition` declares on Pi's API of this load, then runs its setup. */
function load(definition: Definition, pi: ExtensionAPI): Effect.Effect<void, unknown, unknown> {
	const api = fromPiApi(pi);
	return Effect.gen(function* () {
		for (const tool of definition.tools ?? []) yield* api.registerTool(tool);
		for (const command of definition.commands ?? []) yield* api.registerCommand(command);
		for (const shortcut of definition.shortcuts ?? []) yield* api.registerShortcut(shortcut);
		for (const { name, ...flag } of definition.flags ?? []) yield* api.registerFlag(name, flag);
		subscribe(definition.on ?? {}, pi, runner(yield* Effect.context<unknown>()));
		if (definition.setup !== undefined) yield* definition.setup;
	}).pipe(Effect.provideService(ExtensionApi, api));
}

/** Pi's `on` for an event chosen at run time, which its overloads, one per event, cannot take. */
type On = (type: string, handler: (event: never, ctx: PiContext) => Promise<unknown>) => () => void;

/** Subscribes each handler of `handlers` on Pi's API, its Effect run with `run` and the context of the event. */
function subscribe(handlers: Handlers, pi: ExtensionAPI, run: Run<unknown>): void {
	const { project_trust: trust, ...rest } = handlers;
	if (trust !== undefined) {
		pi.on("project_trust", (event, ctx) =>
			run(Effect.provideService(trust(event), ProjectTrustContext, fromPiProjectTrustContext(ctx))),
		);
	}
	// The handler of each key gets the event of that key (`Handlers`); `test/pi-conformance.ts` checks that Pi's `on`
	// takes each one with its event and its answer.
	const on = pi.on as On;
	for (const [type, handler] of Object.entries(rest)) {
		if (handler === undefined) continue;
		const handle = handler as (event: never) => Effect.Effect<unknown, unknown, unknown>;
		on(type, (event, ctx) => run(Effect.provideService(handle(event), ExtensionContext, fromPiContext(ctx))));
	}
}
