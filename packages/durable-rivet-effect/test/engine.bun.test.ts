import * as LocalEngine from "../src/bun.ts";
import { registerEngineSuite } from "./engine-suite.ts";

// The Bun lane's local engine. Vitest never loads this file: vitest.config.ts excludes it, because importing bun:ffi
// fails on Node.
registerEngineSuite("Bun", LocalEngine);
