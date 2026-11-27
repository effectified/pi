// The shells pi-coding-agent runs commands in, found as Effects: the user's shell for `bash` and PowerShell for
// `powershell`.

import {
	getPowerShellConfig as piGetPowerShellConfig,
	getShellConfig as piGetShellConfig,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { type CodingAgentFailure, fromPi } from "./errors.ts";

/** The shell `bash` runs commands in, and its arguments: `customShellPath`, else the one Pi finds on the machine. */
// Written out: the declaration build cannot name Pi's `ShellConfig`, which its package does not export.
export const getShellConfig: (
	customShellPath?: string,
) => Effect.Effect<ReturnType<typeof piGetShellConfig>, CodingAgentFailure> = Effect.fn("Shell.getShellConfig")(
	(customShellPath?: string): Effect.Effect<ReturnType<typeof piGetShellConfig>, CodingAgentFailure> =>
		Effect.try({ try: () => piGetShellConfig(customShellPath), catch: fromPi }),
);

/** The PowerShell `powershell` runs commands in, preferring PowerShell 7, and its arguments. */
export const getPowerShellConfig: Effect.Effect<
	ReturnType<typeof piGetPowerShellConfig>,
	CodingAgentFailure
> = Effect.try({ try: () => piGetPowerShellConfig(), catch: fromPi }).pipe(
	Effect.withSpan("Shell.getPowerShellConfig"),
);
