// pi-coding-agent's run modes in Effect: print mode (one prompt, its answer on stdout), RPC mode (JSON commands on
// stdin, events on stdout) and the CLI's own entry point, each over a session runtime.

import {
	type MainOptions,
	type PrintModeOptions,
	main as piMain,
	runPrintMode,
	runRpcMode,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { AgentSessionRuntimeHandle } from "./agent-session-runtime.ts";
import { type CodingAgentFailure, fromPi } from "./errors.ts";

/**
 * Runs the runtime's session in print mode: Pi's `runPrintMode`. Sends `options`' messages, writes the answer (text,
 * or JSON events) to stdout, and succeeds with the exit code Pi chose. Interrupting it aborts the session's run.
 */
export const print = Effect.fn("Modes.print")(
	(runtime: AgentSessionRuntimeHandle, options: PrintModeOptions): Effect.Effect<number, CodingAgentFailure> =>
		Effect.tryPromise({ try: () => runPrintMode(runtime.pi, options), catch: fromPi }).pipe(
			Effect.onInterrupt(() => Effect.promise(() => runtime.pi.session.abort())),
		),
);

/**
 * Serves the runtime in RPC mode: Pi's `runRpcMode`. It reads JSON commands from stdin and writes responses and events
 * to stdout until stdin ends or the process is signalled; then Pi disposes the runtime and ends the process. It never
 * succeeds.
 */
export const rpc = Effect.fn("Modes.rpc")(
	(runtime: AgentSessionRuntimeHandle): Effect.Effect<never, CodingAgentFailure> =>
		Effect.tryPromise({ try: () => runRpcMode(runtime.pi), catch: fromPi }),
);

/**
 * Pi's command-line program, as the `pi` binary runs it, with `args` as its arguments: Pi's `main`. It may set the
 * process's exit code, or end the process on a fatal error, as the CLI does.
 */
export const main = Effect.fn("Modes.main")(
	(args: ReadonlyArray<string>, options?: MainOptions): Effect.Effect<void, CodingAgentFailure> =>
		Effect.tryPromise({ try: () => piMain([...args], options), catch: fromPi }),
);
