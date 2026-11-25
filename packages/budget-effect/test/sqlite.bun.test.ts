import { SqliteClient } from "@effect/sql-sqlite-bun";
import { describe } from "vitest";
import { registerSqliteSuites } from "./sqlite-suites.ts";

// The Bun lane's driver (bun:sqlite). Vitest never loads this file: vitest.config.ts excludes it, because importing
// bun:sqlite fails on Node.
registerSqliteSuites(describe, "@effect/sql-sqlite-bun", (filename) => SqliteClient.layer({ filename }));
