import * as LocalEngine from "@effectified/pi-durable-rivet/bun";
import { registerHostsSuite } from "./hosts-suite.ts";

// The Bun lane's local engine. Vitest never loads this file: vitest.config.ts excludes it, because the Bun entry
// sets the process environment through bun:ffi.
registerHostsSuite("Bun", LocalEngine);
