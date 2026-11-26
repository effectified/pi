import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as PiTelemetrySqliteNode from "@earendil-works/chord/telemetry-sqlite/node";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import type { Coverage } from "../../../../effect/conformance.ts";
import { openNodeSqliteDatabase } from "../../src/node/sqlite.ts";
import { openTelemetryStore } from "../../src/node/telemetry-sqlite.ts";
import { findTraces, flush, make } from "../../src/telemetry-sqlite.ts";
import { run } from "../run.ts";

const replaced = (by: string): Coverage => ({ kind: "replaced", by });

/** What `@effectified/pi-chord/telemetry-sqlite/node` does with every value Chord's `/telemetry-sqlite/node` exports. */
const COVERAGE = {
	openTelemetryStore: replaced("openTelemetryStore: read-only, closed when its scope closes"),
} satisfies Record<keyof typeof PiTelemetrySqliteNode, Coverage>;

const directory = mkdtempSync(join(tmpdir(), "pi-chord-effect-telemetry-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("the coverage of Chord's /telemetry-sqlite/node", () => {
	it("records its one value", () => {
		expect(Object.keys(COVERAGE)).toEqual(["openTelemetryStore"]);
	});
});

describe("openTelemetryStore", () => {
	// Bun's `node:sqlite` refuses to open a WAL file read-only ("unable to open database file"): the Node lane only.
	it.skipIf("Bun" in globalThis)("reads a store another recorder wrote", async () => {
		const path = join(directory, "telemetry.db");
		const traces = await run(
			Effect.gen(function* () {
				yield* Effect.scoped(
					Effect.gen(function* () {
						const telemetry = yield* make(yield* openNodeSqliteDatabase(path));
						yield* Effect.promise(() => telemetry.startSpan({ name: "app.job" }, async () => {}));
						yield* flush(telemetry);
					}),
				);
				const store = yield* openTelemetryStore(path);
				return (yield* findTraces(store)).traces;
			}),
		);
		expect(traces.flatMap((trace) => trace.spans.map((span) => span.name))).toEqual(["app.job"]);
	});

	it("fails with SqliteError for a file that holds no store", async () => {
		const path = join(directory, "other.db");
		writeFileSync(path, "");
		const failure = await run(Effect.flip(openTelemetryStore(path)));
		expect(failure._tag).toBe("SqliteError");
	});
});
