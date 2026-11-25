// A process of its own that serves a local engine in a directory it is given and waits, for local-engine-suite.ts:
// what becomes of an engine whose host ends without closing its scope is the question.
//   node --conditions=source local-engine-process.ts <directory>
// It says `ready <the engine's process ids>` once the engine answers.

import { Effect } from "effect";
import * as BunEngine from "../src/bun.ts";
import * as NodeEngine from "../src/node.ts";

const [directory = ""] = process.argv.slice(2);
// Feature detection: only Bun has this global.
const engines = "Bun" in globalThis ? BunEngine : NodeEngine;

await Effect.runPromise(
	Effect.scoped(
		Effect.gen(function* () {
			yield* engines.serve({ actors: [], logging: { level: "error" }, directory });
			const pids = yield* engines.running(directory);
			process.stdout.write(`ready ${pids.join(" ")}\n`);
			// Something to do until the process is ended from outside.
			setInterval(() => {}, 1_000);
			yield* Effect.never;
		}),
	),
);
