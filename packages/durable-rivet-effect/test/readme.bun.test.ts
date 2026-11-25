import * as LocalEngine from "../src/bun.ts";
import { registerReadme } from "./readme.ts";

// The Bun lane's local engine. Vitest never loads this file: vitest.config.ts excludes it.
registerReadme("Bun", LocalEngine);
