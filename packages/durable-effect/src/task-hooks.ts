// A task's own hooks in Effect: the questions a task of this package asks extension code, each answer an Effect.

import type { HookRegistration } from "@earendil-works/pi-durable";
import { Effect, Record } from "effect";
import type * as Hook from "./hook.ts";

/**
 * The hooks a task asks: for each name, the handler as the task calls it. A handler takes what the task gives it and
 * returns an Effect that needs nothing: the services its extension's handler needs were captured when the registry was
 * built.
 */
export type Handlers = { readonly [name: string]: (...args: never) => Effect.Effect<unknown, unknown> };

/**
 * The hooks of one task kind, typed by `H`: what an extension answers with `answer` and the task asks with
 * `api.eachHook`.
 */
export interface TaskHooks<H extends Handlers> {
	/** The name of the task kind that asks them, which Pi matches the answers by. */
	readonly task: string;
	/** Carries the type of the handlers; it has no value. */
	readonly handlers?: H;
}

/**
 * The hooks a task of `task`'s kind asks, typed by `H`: `TaskHooks.make<{ check: (text: string) =>
 * Effect.Effect<boolean> }>(Review)`. Pi matches the answers of extensions by the task's name.
 */
export function make<H extends Handlers>(task: { readonly name: string }): TaskHooks<H> {
	return { task: task.name };
}

/** What an extension gives for the hooks `H`: any of them, each an Effect that may need services. */
export type Answers<H extends Handlers> = {
	readonly [K in keyof H]?: (
		...args: Parameters<H[K]>
	) => Effect.Effect<Effect.Success<ReturnType<H[K]>>, Effect.Error<ReturnType<H[K]>>, unknown>;
};

/** The services the answers `A` need: the union over the hooks they answer. */
export type Services<A> = {
	readonly [K in keyof A]-?: NonNullable<A[K]> extends (...args: never) => Effect.Effect<infer _A, infer _E, infer R>
		? R
		: never;
}[keyof A];

/** One answer, whatever its hook. */
type Answer = (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown, unknown>;

/**
 * Answers `hooks` in an extension (Pi's `hook(task, handlers)` for a task of this package): the registry asks them
 * for every task of that kind in a conversation that selects the extension, in extension order. The answers run with
 * the services the registry was built with, which it requires.
 */
export function answer<H extends Handlers, const A extends Answers<H>>(
	hooks: TaskHooks<H>,
	answers: A,
): Hook.Hook<Services<A>> {
	return {
		registration: Effect.map(
			Effect.context<Services<A>>(),
			(context): HookRegistration => ({
				task: hooks.task,
				handlers: Record.map(
					// The answers by name, each a handler: `Answers` types each by its hook, which a walk over them loses.
					answers as unknown as { readonly [name: string]: Answer },
					(handler) =>
						(...args: ReadonlyArray<unknown>) =>
							// The context holds what every answer needs (`Services<A>`), so what this one needs too.
							Effect.provideContext(
								Effect.suspend(() => handler(...args)) as Effect.Effect<unknown, unknown, Services<A>>,
								context,
							),
				),
			}),
		),
	};
}
