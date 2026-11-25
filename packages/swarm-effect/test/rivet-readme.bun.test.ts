import * as LocalEngine from "@gunta/pi-durable-rivet-effect/bun";
import { registerRivetReadme } from "./rivet-readme.ts";

// The Bun lane's local engine. Vitest never loads this file: vitest.config.ts excludes it.
registerRivetReadme("Bun", LocalEngine);
