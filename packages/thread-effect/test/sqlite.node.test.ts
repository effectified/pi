import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "vitest";
import { registerSqliteSuites } from "./sqlite-suites.ts";

// The Node lane's driver (node:sqlite). Bun runs this file too, since its runner takes every test file: skipped there.
registerSqliteSuites(
	{ describe: describe.skipIf("Bun" in globalThis), expect, it },
	"@effect/sql-sqlite-node",
	(filename) => SqliteClient.layer({ filename }),
);
