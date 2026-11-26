// Pi's methods as Effects under Pi's own names: what the facades of pi-coding-agent's managers (sessions, settings)
// are made of. The lists of methods are each facade's, checked against Pi's types in `test/pi-conformance.ts`.

import { Effect } from "effect";
import { type CodingAgentFailure, fromPi } from "./errors.ts";

/** The keys of `T` whose values are methods. */
export type MethodKeys<T> = {
	[K in keyof T]-?: T[K] extends (...args: never[]) => unknown ? K : never;
}[keyof T];

/** The keys of `T` whose values are not methods: Pi's fields and getters. */
export type FieldKeys<T> = Exclude<keyof T, MethodKeys<T>>;

/** Pi's fields and getters `K` of `T`, each an Effect that reads it when it runs. A throw is a defect. */
export type Fields<T, K extends FieldKeys<T>> = { readonly [P in K]: Effect.Effect<T[P]> };

/** Pi's methods `K` of `T` that only read: each an Effect of its result. A throw is a defect. */
export type Reads<T, K extends MethodKeys<T>> = {
	readonly [P in K]: T[P] extends (...args: infer A) => infer R ? (...args: A) => Effect.Effect<R> : never;
};

/** Pi's methods `K` of `T` that change state or reach storage: each an Effect that fails with what Pi threw. */
export type Writes<T, K extends MethodKeys<T>> = {
	readonly [P in K]: T[P] extends (...args: infer A) => infer R
		? (...args: A) => Effect.Effect<R, CodingAgentFailure>
		: never;
};

/** Pi's asynchronous methods `K` of `T`: each an Effect of what its promise resolves with, failing with its rejection. */
export type Awaits<T, K extends MethodKeys<T>> = {
	readonly [P in K]: T[P] extends (...args: infer A) => infer R
		? (...args: A) => Effect.Effect<Awaited<R>, CodingAgentFailure>
		: never;
};

/** The fields and getters `keys` of `pi`, as `Fields`. */
export function fields<T, const K extends FieldKeys<T>>(pi: T, keys: ReadonlyArray<K>): Fields<T, K> {
	const read: Record<PropertyKey, unknown> = {};
	for (const key of keys) read[key] = Effect.sync(() => pi[key]);
	// The loop builds one Effect per key, each the mapped type's: the shape TypeScript cannot follow.
	return read as Fields<T, K>;
}

/** The methods `keys` of `pi` that only read, as `Reads`. */
export function reads<T, const K extends MethodKeys<T>>(pi: T, keys: ReadonlyArray<K>): Reads<T, K> {
	return lift(pi, keys, (call) => Effect.sync(call));
}

/** The methods `keys` of `pi` that change state or reach storage, as `Writes`. */
export function writes<T, const K extends MethodKeys<T>>(pi: T, keys: ReadonlyArray<K>): Writes<T, K> {
	return lift(pi, keys, (call) => Effect.try({ try: call, catch: fromPi }));
}

/** The asynchronous methods `keys` of `pi`, as `Awaits`. */
export function awaits<T, const K extends MethodKeys<T>>(pi: T, keys: ReadonlyArray<K>): Awaits<T, K> {
	return lift(pi, keys, (call) => Effect.tryPromise({ try: () => Promise.resolve(call()), catch: fromPi }));
}

/** Each method of `keys` as a function of its arguments that gives `effect` of the call. */
function lift<T, K extends MethodKeys<T>, M>(
	pi: T,
	keys: ReadonlyArray<K>,
	effect: (call: () => unknown) => Effect.Effect<unknown, unknown>,
): M {
	const lifted: Record<PropertyKey, unknown> = {};
	for (const key of keys) {
		// `K` names methods only (`MethodKeys`), which TypeScript cannot carry to the indexed value.
		const method = pi[key] as (...args: unknown[]) => unknown;
		lifted[key] = (...args: unknown[]) => effect(() => method.apply(pi, args));
	}
	// The loop builds one entry per key, each the mapped type's function: the shape TypeScript cannot follow.
	return lifted as M;
}
