// The Bun entry of spike 02 (see 02-actor-sql.ts): the local engine of `@effectified/pi-durable-rivet/bun`.
//   bun --conditions=source effect/spikes/02-actor-sql.bun.ts

import * as LocalEngine from "@effectified/pi-durable-rivet/bun";
import { run } from "./02-actor-sql.ts";

await run("bun", LocalEngine.serve);
process.exit(0);
