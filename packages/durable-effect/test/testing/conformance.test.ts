import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import * as NodeEnv from "../../src/env/node.ts";
import { Storage } from "../../src/index.ts";
import { envConformance, storageConformance } from "../../src/testing/index.ts";

describe("storageConformance", () => {
	it("gives Pi's storage cases, each an Effect on a fresh storage", () => {
		const cases = Effect.runSync(storageConformance(Storage.memory, expect));
		expect(cases.length).toBeGreaterThan(10);
		expect(new Set(cases.map((testCase) => testCase.name)).size).toBe(cases.length);
	});
});

// A fresh, empty directory for each case, removed with the case's scope.
const freshDirectory = Effect.acquireRelease(
	Effect.sync(() => mkdtempSync(join(tmpdir(), "durable-effect-env-conformance-"))),
	(directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
);

describe("Pi's environment conformance on NodeEnv.make", () => {
	const cases = Effect.runSync(
		envConformance(
			Effect.flatMap(freshDirectory, (cwd) => NodeEnv.make({ cwd })),
			expect,
		),
	);
	for (const testCase of cases) it(testCase.name, () => Effect.runPromise(testCase.run), testCase.timeoutMs);
});
