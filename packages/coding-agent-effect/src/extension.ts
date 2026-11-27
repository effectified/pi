// A Pi extension written in Effect: tools, commands, shortcuts, flags and event handlers as Effects that use services,
// turned into the inline extension (or the extension factory) a Pi host loads like any other.

import type {
	ExtensionAPI,
	ExtensionFactory,
	InlineExtension,
	ExtensionContext as PiContext,
} from "@earendil-works/pi-coding-agent";
import { Effect, Record } from "effect";
import type * as Command from "./command.ts";
import { ExtensionApi, fromPiApi, type Shortcut } from "./extension-api.ts";
import {
	ExtensionContext,
	fromPiContext,
	fromPiProjectTrustContext,
	ProjectTrustContext,
} from "./extension-context.ts";
import type { Failures as HandlerFailures, Services as HandlerServices, Handlers } from "./handlers.ts";
import { type Run, runner } from "./runner.ts";
import type * as Tool from "./tool.ts";

/** A CLI flag the extension declares: Pi's `registerFlag` options and the flag's name. */
export type Flag = Parameters<ExtensionAPI["registerFlag"]>[1] & { readonly name: string };

/**
 * What an extension registers when Pi loads it. Its Effects fail with `E` and need `R` besides the contexts they are
 * given; without arguments, any of each: what `make` takes.
 */
export interface Definition<R = unknown, E = unknown> {
	readonly tools?: ReadonlyArray<Tool.Any<R>>;
	readonly commands?: ReadonlyArray<Command.Any<R>>;
	readonly shortcuts?: ReadonlyArray<Shortcut<R, E>>;
	readonly flags?: ReadonlyArray<Flag>;
	/** The handlers of the session's events, asked in the order the extensions were loaded. */
	readonly on?: Handlers<E, R>;
	/** Runs when Pi loads the extension, after the rest is registered: for what depends on flags or settings. */
	readonly setup?: Effect.Effect<void, E, R | ExtensionApi>;
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
	| (D["shortcuts"] extends ReadonlyArray<infer S> ? (S extends Shortcut<infer R, infer _E> ? R : never) : never)
	| HandlerServices<NonNullable<D["on"]>>
	| (D["setup"] extends Effect.Effect<infer _A, infer _E, infer R> ? R : never),
	ExtensionApi | ExtensionContext
>;

/** What the Effects of an extension of `D` fail with: its shortcuts, handlers and setup. Pi reports each failure. */
export type Failures<D extends Definition> =
	| (D["shortcuts"] extends ReadonlyArray<infer S> ? (S extends Shortcut<infer _R, infer E> ? E : never) : never)
	| HandlerFailures<NonNullable<D["on"]>>
	| (D["setup"] extends Effect.Effect<infer _A, infer E, infer _R> ? E : never);

/**
 * Defines the extension `name`. When Pi loads it, its tools, commands, shortcuts, flags and handlers are registered,
 * then `setup` runs. Every Effect of the extension has `ExtensionApi` (the API of this load: Pi loads an extension
 * again on reload) and the services of the context `inline` runs in.
 */
export function make<const D extends Definition>(name: string, definition: D): Extension<Services<D>> {
	// `Services<D>` and `Failures<D>` are what the Effects of `D` need besides the contexts given to them and what they
	// fail with, collected from `D`'s arrays and records, which TypeScript cannot follow back to each Effect.
	const typed = definition as Definition<Services<D>, Failures<D>>;
	return {
		name,
		inline: Effect.map(Effect.context<Services<D>>(), (context): Inline => {
			const run = runner(context);
			return {
				name,
				factory: (pi) => run(load(typed, pi)),
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

/**
 * Registers what `definition` declares on Pi's API of this load, in its order, then runs its setup, all with the
 * extension's `ExtensionApi`.
 */
const load = Effect.fn("Extension.load")(function* <R, E>(definition: Definition<R, E>, pi: ExtensionAPI) {
	const api = fromPiApi(pi);
	yield* Effect.gen(function* () {
		// Taken here, where `ExtensionApi` is provided: the handlers run with it.
		const context = yield* Effect.context<R>();
		yield* Effect.forEach(definition.tools ?? [], api.registerTool, { concurrency: 1, discard: true });
		yield* Effect.forEach(definition.commands ?? [], api.registerCommand, { concurrency: 1, discard: true });
		yield* Effect.forEach(definition.shortcuts ?? [], api.registerShortcut, { concurrency: 1, discard: true });
		yield* Effect.forEach(definition.flags ?? [], ({ name, ...flag }) => api.registerFlag(name, flag), {
			concurrency: 1,
			discard: true,
		});
		subscribe(definition.on ?? {}, pi, runner(context));
		if (definition.setup !== undefined) yield* definition.setup;
	}).pipe(Effect.provideService(ExtensionApi, api));
});

/** A handler of `Handlers` but `project_trust`'s, whatever its event. */
type Handler<E, R> = (event: never) => Effect.Effect<unknown, E, R | ExtensionContext>;

/** Pi's `on` for an event chosen at run time, which its overloads, one per event, cannot take. */
type On = (type: string, handler: (event: never, ctx: PiContext) => Promise<unknown>) => () => void;

/** Subscribes each handler of `handlers` on Pi's API, its Effect run with `run` and the context of the event. */
function subscribe<E, R>(handlers: Handlers<E, R>, pi: ExtensionAPI, run: Run<R>): void {
	const { project_trust: trust, ...rest } = handlers;
	if (trust !== undefined) {
		pi.on("project_trust", (event, ctx) =>
			run(Effect.provideService(trust(event), ProjectTrustContext, fromPiProjectTrustContext(ctx))),
		);
	}
	// The handler of each key gets the event of that key (`Handlers`); `test/pi-conformance.ts` checks that Pi's `on`
	// takes each one with its event and its answer.
	const on = pi.on as On;
	const entries = Record.toEntries<string, Handler<E, R> | undefined>(rest);
	for (const [type, handler] of entries) {
		if (handler === undefined) continue;
		on(type, (event, ctx) => run(Effect.provideService(handler(event), ExtensionContext, fromPiContext(ctx))));
	}
}
