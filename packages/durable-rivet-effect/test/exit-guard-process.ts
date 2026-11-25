// A process of its own that holds back rivetkit's exit for good, for exit-guard.test.ts: the hold lasts as long as its
// process, so no test process may be the one that takes it.
//   node exit-guard-process.ts <a module under rivetkit/dist whose export calls its argument with 1>
// It says `went on` after each exit that was dropped, and ends by itself with code 7.

import { createRequire } from "node:module";
import { Effect } from "effect";
import * as ExitGuard from "../src/node/exit-guard.ts";

const [caller = ""] = process.argv.slice(2);
const asRivetkit: (exit: (code: number) => void) => void = createRequire(import.meta.url)(caller);

Effect.runSync(ExitGuard.keep);
asRivetkit((code) => process.exit(code));
process.stdout.write("went on\n");
// A start that became ready ends its own hold, and takes nothing off.
Effect.runSync(Effect.flatMap(ExitGuard.hold, (hold) => hold.ready));
asRivetkit((code) => process.exit(code));
process.stdout.write("went on\n");
process.exit(7);
