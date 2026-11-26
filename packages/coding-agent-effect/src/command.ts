// An extension's commands in Effect: the handler of `/name` as an Effect with the command's context as a service.

import type { RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { type CommandContext, type ExtensionContext, inCommand } from "./extension-context.ts";
import { runner } from "./runner.ts";

/** The contexts a command's handler gets as services. */
export type Contexts = ExtensionContext | CommandContext;

/** One completion of a command's argument, as Pi's editor shows it. */
export type Completion = NonNullable<
	Awaited<ReturnType<NonNullable<RegisteredCommand["getArgumentCompletions"]>>>
>[number];

/** What Pi registers for a command: `ExtensionAPI.registerCommand`'s options. */
export type Registration = Omit<RegisteredCommand, "name" | "sourceInfo">;

/** What `make` takes besides the command's name. */
export interface Options<E, R> {
	/** What the command list shows. */
	readonly description?: string;
	/**
	 * Runs `/name <args>`: `args` is the text after the name. It runs with `ExtensionContext` and `CommandContext`; a
	 * failure is reported as an extension error with its message.
	 */
	readonly handler: (args: string) => Effect.Effect<void, E, R>;
	/** The completions of an argument that starts with `prefix`; `null` for none. */
	readonly getArgumentCompletions?: (
		prefix: string,
	) => Effect.Effect<ReadonlyArray<Completion> | null, never, Exclude<R, Contexts>>;
}

/** A command made by `make`. */
export interface Command<Name extends string, E, R> extends Options<E, R>, Any<Exclude<R, Contexts>> {
	readonly name: Name;
}

/** Any command: what an extension and `ExtensionApi.registerCommand` take. */
export interface Any<R> {
	readonly name: string;
	/** Builds what Pi registers; the handler runs with the services of the context this Effect runs in. */
	readonly registration: Effect.Effect<Registration, never, R>;
}

/** Defines the command `/name` of an extension. */
export function make<const Name extends string, E, R>(name: Name, options: Options<E, R>): Command<Name, E, R> {
	return { ...options, name, registration: registration(options) };
}

/** What Pi registers for `options`, its Effects run with the services of the context it is built in. */
function registration<E, R>(options: Options<E, R>): Effect.Effect<Registration, never, Exclude<R, Contexts>> {
	return Effect.map(Effect.context<Exclude<R, Contexts>>(), (context): Registration => {
		const run = runner(context);
		const completions = options.getArgumentCompletions;
		return {
			...(options.description === undefined ? {} : { description: options.description }),
			handler: (args, ctx) => run(inCommand(options.handler(args), ctx)),
			...(completions === undefined
				? {}
				: {
						getArgumentCompletions: (prefix: string) =>
							run(completions(prefix)).then((items) => items && [...items]),
					}),
		};
	});
}
