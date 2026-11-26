import * as LocalEngine from "@effectified/pi-durable-rivet/node";
import { registerRivetReadme } from "./rivet-readme.ts";

// The Node lane's local engine; on Bun the example runs from rivet-readme.bun.test.ts.
if (!("Bun" in globalThis)) registerRivetReadme("Node.js", LocalEngine);
