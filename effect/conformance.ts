// Compile-time checks that a type of ours still matches the Pi type it mirrors: the shared helper of every package's
// `test/pi-conformance.ts`. Types only: nothing here runs.

/** `true` when `A` and `B` are the same type as the checker compares them, not only assignable both ways. */
export type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type Primitive = string | number | boolean | bigint | symbol | null | undefined;

/**
 * `T` without `readonly`, to a depth of 8: an Effect Schema's `Type` is readonly where Pi's types are mutable, and
 * that difference is never the drift we look for. Branded primitives (Pi's ids) and functions are kept as they are.
 * The depth bound stops recursive types (Chord's JSON values) from recursing forever.
 */
export type Mutable<T, Depth extends readonly unknown[] = []> = Depth["length"] extends 8
	? T
	: T extends Primitive
		? T
		: T extends (...args: never[]) => unknown
			? T
			: { -readonly [K in keyof T]: Mutable<T[K], [...Depth, unknown]> };

/** Two-way equality, readonly ignored: `true`, or an object that names the difference (the compiler prints it). */
export type Conform<Ours, Pi> = Equals<Mutable<Ours>, Mutable<Pi>> extends true
	? true
	: Difference<Mutable<Ours>, Mutable<Pi>>;

type UnionToIntersection<U> = (U extends unknown ? (member: U) => void : never) extends (all: infer I) => void
	? I
	: never;

type IsUnion<T> = [T] extends [UnionToIntersection<T>] ? false : true;

/**
 * What differs. For unions and primitives: the members only one side has. For one object on each side: the keys only
 * one side has, and the keys both have with different types.
 */
type Difference<Ours, Pi> = [IsUnion<Ours> | IsUnion<Pi>] extends [false]
	? [Ours, Pi] extends [object, object]
		? {
				readonly onlyOurs: Exclude<keyof Ours, keyof Pi>;
				readonly onlyPi: Exclude<keyof Pi, keyof Ours>;
				readonly differ: {
					readonly [K in keyof Ours & keyof Pi as Equals<Ours[K], Pi[K]> extends true ? never : K]: {
						readonly ours: Ours[K];
						readonly pi: Pi[K];
					};
				};
			}
		: { readonly onlyOurs: Exclude<Ours, Pi>; readonly onlyPi: Exclude<Pi, Ours> }
	: { readonly onlyOurs: Exclude<Ours, Pi>; readonly onlyPi: Exclude<Pi, Ours>; readonly ours: Ours; readonly pi: Pi };

/**
 * Every key of `Pi` is handled by `Ours` or named in `Skipped`, and every skipped key still exists in `Pi`: `true`,
 * or the keys that are neither, and the skipped keys Pi no longer has.
 */
export type Covers<Pi, Ours, Skipped extends PropertyKey = never> = [
	Exclude<keyof Pi, keyof Ours | Skipped>,
	Exclude<Skipped, keyof Pi>,
] extends [never, never]
	? true
	: {
			readonly unhandled: Exclude<keyof Pi, keyof Ours | Skipped>;
			readonly staleSkips: Exclude<Skipped, keyof Pi>;
		};

/** Compiles only when `T` is `true`; otherwise the error shows `T`, which is the difference. */
export type Assert<T extends true> = T;
