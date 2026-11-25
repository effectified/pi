// The Bun entry of spike 02 (see 02-actor-sql.ts): the local engine of `@gunta/pi-durable-rivet-effect/bun`.
//   bun --conditions=source effect/spikes/02-actor-sql.bun.ts

import * as LocalEngine from "@gunta/pi-durable-rivet-effect/bun";
import { run } from "./02-actor-sql.ts";

await run("bun", LocalEngine.serve);
process.exit(0);
