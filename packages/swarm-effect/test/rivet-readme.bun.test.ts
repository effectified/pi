import * as LocalEngine from "@effectified/pi-durable-rivet/bun";
import { registerRivetReadme } from "./rivet-readme.ts";

// The Bun lane's local engine. Vitest never loads this file: vitest.config.ts excludes it.
registerRivetReadme("Bun", LocalEngine);
