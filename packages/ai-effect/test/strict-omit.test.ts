// StrictOmit: a key its type does not have, as after an upstream rename, does not compile.

import type { ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { StrictOmit } from "../src/index.ts";

describe("StrictOmit", () => {
	it("leaves out the keys it names, as Omit does", () => {
		const options: StrictOmit<ModelsSimpleStreamOptions, "signal"> = { maxTokens: 10 };
		// @ts-expect-error `signal` is left out.
		const withSignal: StrictOmit<ModelsSimpleStreamOptions, "signal"> = { signal: new AbortController().signal };
		expect([options, withSignal].length).toBe(2);
	});

	it("takes only keys of its type", () => {
		// @ts-expect-error `deferredRenamed` is no key of pi-ai's options, so this is no silent no-op.
		type Renamed = StrictOmit<ModelsSimpleStreamOptions, "deferredRenamed">;
		const renamed: Renamed = {};
		expect(renamed).toEqual({});
	});
});
