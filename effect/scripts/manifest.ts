// What a package manifest says once it leaves this repository, for the scripts that ship packages (`pack.ts`,
// `vendor.ts`): the `source` condition points at `src`, which only this repository has.

/** `exports` without the `source` condition of each entry. */
export function withoutSource(exports: unknown): unknown {
	if (typeof exports !== "object" || exports === null) return exports;
	return Object.fromEntries(
		Object.entries(exports)
			.filter(([condition]) => condition !== "source")
			.map(([key, value]) => [key, withoutSource(value)]),
	);
}
