import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe } from "vitest";
import { registerSqliteSuites } from "./sqlite-suites.ts";

// The Node lane's driver (node:sqlite). Bun runs this file too, since its runner takes every test file: skipped there.
registerSqliteSuites(describe.skipIf("Bun" in globalThis), "@effect/sql-sqlite-node", (filename) =>
	SqliteClient.layer({ filename }),
);
