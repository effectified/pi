import * as LocalEngine from "../src/node.ts";
import { registerEngineSuite } from "./engine-suite.ts";

// The Node lane's local engine. Bun runs this file too, since its runner takes every test file: there the Node entry
// refuses to start an engine, so the suite is registered for Node only.
if (!("Bun" in globalThis)) registerEngineSuite("Node.js", LocalEngine);
