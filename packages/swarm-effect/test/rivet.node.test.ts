import * as LocalEngine from "@gunta/pi-durable-rivet-effect/node";
import { registerRivetSuite } from "./rivet-suite.ts";

// The Node lane's local engine. Bun runs this file too, since its runner takes every test file: there the Node entry
// refuses to start an engine, so the suite is registered for Node only.
if (!("Bun" in globalThis)) registerRivetSuite("Node.js", LocalEngine);
