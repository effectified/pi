import * as LocalEngine from "../src/node.ts";
import { registerReadme } from "./readme.ts";

// The Node lane's local engine; on Bun the example runs from readme.bun.test.ts.
if (!("Bun" in globalThis)) registerReadme("Node.js", LocalEngine);
