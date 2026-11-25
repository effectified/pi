import { SqliteClient } from "@effect/sql-sqlite-bun";
import { describe } from "vitest";
import { registerRestart } from "./restart.ts";

// The Bun lane's driver (bun:sqlite). Vitest never loads this file: vitest.config.ts excludes it, because importing
// bun:sqlite fails on Node.
registerRestart(describe, "@effect/sql-sqlite-bun", (filename) => SqliteClient.layer({ filename }));
