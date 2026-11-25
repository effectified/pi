import { SqliteClient } from "@effect/sql-sqlite-bun";
import { describe, expect, it } from "vitest";
import { registerSqliteSuites } from "./sqlite-suites.ts";

// The Bun lane's driver (bun:sqlite). Vitest never loads this file: vitest.config.ts excludes it, because importing
// bun:sqlite fails on Node.
registerSqliteSuites({ describe, expect, it }, "@effect/sql-sqlite-bun", (filename) =>
	SqliteClient.layer({ filename }),
);
