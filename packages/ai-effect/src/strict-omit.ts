// `Omit` checked against the keys of its type, for the places that leave out keys of a Pi type by name.

/**
 * `Omit` that only takes keys `T` has: when Pi renames or removes a key named here, the use is a compile error instead
 * of an `Omit` that silently leaves the renamed key in.
 */
export type StrictOmit<T, K extends keyof T> = Omit<T, K>;
