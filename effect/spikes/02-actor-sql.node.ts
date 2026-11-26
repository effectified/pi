// The Node entry of spike 02 (see 02-actor-sql.ts): the local engine of `@effectified/pi-durable-rivet/node`.
//   node --conditions=source effect/spikes/02-actor-sql.node.ts

import * as LocalEngine from "@effectified/pi-durable-rivet/node";
import { run } from "./02-actor-sql.ts";

await run("node", LocalEngine.serve);
process.exit(0);
