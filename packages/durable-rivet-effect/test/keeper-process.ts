// A process of its own that keeps watch over the engine of a directory, for keeper.test.ts: the watcher acts when its
// process ends, so no test process may be the one that is watched.
//   node keeper-process.ts <directory> killed [pid ...]   keeps watch, says `watching`, and waits to be killed
//   node keeper-process.ts <directory> closed             keeps watch, closes its scope, says `closed`, and ends

import { Effect } from "effect";
import * as Keeper from "../src/node/keeper.ts";

const [directory = "", mode = "", ...pids] = process.argv.slice(2);

await Effect.runPromise(
	Effect.scoped(
		Effect.gen(function* () {
			const watch = yield* Keeper.keep(directory);
			if (pids.length > 0) {
				yield* watch.engines(pids.map(Number));
				// On Bun the line is in the pipe a moment after the write was taken.
				yield* Effect.sleep("200 millis");
			}
			if (mode !== "killed") return;
			process.stdout.write("watching\n");
			// Something to do until the kill: the watcher and its pipe keep no process alive.
			setInterval(() => {}, 1_000);
			yield* Effect.never;
		}),
	),
);
process.stdout.write("closed\n");
