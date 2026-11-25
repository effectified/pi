import * as LocalEngine from "../src/bun.ts";
import { registerLocalEngineSuite } from "./local-engine-suite.ts";

// The Bun lane's local engine. Vitest never loads this file: vitest.config.ts excludes it.
registerLocalEngineSuite("Bun", LocalEngine);
