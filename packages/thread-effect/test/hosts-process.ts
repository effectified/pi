// Test helper, run as a process of its own by hosts-suite.ts: a host of the thread actor on an engine that runs already.
// Arguments: the engine's endpoint, the outside's URL, the name of this host.

import { Host } from "@effectified/pi-durable-rivet";
import { Effect } from "effect";
import { HOST_POOL, threadOn } from "./hosts-thread.ts";
import { ask } from "./hosts-wire.ts";

const [endpoint = "", url = "", host = ""] = process.argv.slice(2);

// The parent holds the other end: a host does not outlive the test that started it.
process.stdin.on("end", () => process.exit(0)).resume();

const main = Effect.gen(function* () {
	yield* Host.serve({
		actors: [threadOn(url, host)],
		endpoint,
		node: { poolName: HOST_POOL },
		noWelcome: true,
		startServices: false,
		logging: { level: "error" },
	});
	yield* Effect.promise(() => ask(url, { host, kind: "ready" }));
	return yield* Effect.never;
});

await Effect.runPromise(Effect.scoped(main));
