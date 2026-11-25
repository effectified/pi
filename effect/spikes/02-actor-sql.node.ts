// The Node entry of spike 02 (see 02-actor-sql.ts): the local engine of `@gunta/pi-durable-rivet-effect/node`.
//   node --conditions=source effect/spikes/02-actor-sql.node.ts

import * as LocalEngine from "@gunta/pi-durable-rivet-effect/node";
import { run } from "./02-actor-sql.ts";

await run("node", LocalEngine.serve);
process.exit(0);
