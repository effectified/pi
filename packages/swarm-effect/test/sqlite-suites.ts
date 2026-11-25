// Test helper: the suites that need a real SQLite `SqlClient`, registered once per driver by a platform test file:
// kill and resume of a swarm on a SQLite file (kill-resume.ts), and the Rivet driver's record of forks
// (records-suite.ts).

import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClientLayer, registerKillResume } from "./kill-resume.ts";
import { registerRecords } from "./records-suite.ts";

/** Vitest's `describe`, or its `skipIf` for the driver the runtime cannot load. */
export type Describe = (name: string, body: () => void) => void;

/** Registers every SQLite suite for one driver. */
export function registerSqliteSuites(describe: Describe, driver: string, client: ClientLayer): void {
	describe(`kill and resume of a swarm (${driver})`, () =>
		registerKillResume(client, withDatabaseFile, copyDatabaseFile));
	describe(`the Rivet driver's record of forks (${driver})`, () => registerRecords(client));
}

/** Runs `use` with the path of a database file in a fresh temporary directory, removed afterwards. */
async function withDatabaseFile<A>(use: (filename: string) => Promise<A>): Promise<A> {
	const directory = mkdtempSync(join(tmpdir(), "pi-swarm-effect-"));
	try {
		return await use(join(directory, "storage.sqlite"));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

/** Copies the database file `from` and the files SQLite keeps beside it to `to`. */
function copyDatabaseFile(from: string, to: string): void {
	for (const suffix of ["", "-wal", "-shm"]) {
		if (existsSync(`${from}${suffix}`)) copyFileSync(`${from}${suffix}`, `${to}${suffix}`);
	}
}
