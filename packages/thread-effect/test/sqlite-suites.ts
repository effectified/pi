// Test helper: the suites that need a real SQLite file, registered once per driver by a platform test file.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageConformanceRunner } from "@earendil-works/pi-durable/testing";
import { type ClientLayer, registerKillResume } from "./kill-resume.ts";

/** Registers every SQLite suite for one driver. `runner.describe` skips them on the other runtime. */
export function registerSqliteSuites(runner: StorageConformanceRunner, driver: string, client: ClientLayer): void {
	registerKillResume(runner, driver, client, withDatabaseFile);
}

/** Runs `use` with the path of a database file in a fresh temporary directory, removed afterwards. */
async function withDatabaseFile<A>(use: (filename: string) => Promise<A>): Promise<A> {
	const directory = mkdtempSync(join(tmpdir(), "pi-thread-effect-"));
	try {
		return await use(join(directory, "storage.sqlite"));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
