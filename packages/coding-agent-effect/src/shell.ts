// The shells pi-coding-agent runs commands in, found as Effects: the user's shell for `bash` and PowerShell for
// `powershell`.

import {
	getPowerShellConfig as piGetPowerShellConfig,
	getShellConfig as piGetShellConfig,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { type CodingAgentFailure, fromPi } from "./errors.ts";

/** The shell `bash` runs commands in, and its arguments: `customShellPath`, else the one Pi finds on the machine. */
export function getShellConfig(
	customShellPath?: string,
): Effect.Effect<ReturnType<typeof piGetShellConfig>, CodingAgentFailure> {
	return Effect.try({ try: () => piGetShellConfig(customShellPath), catch: fromPi });
}

/** The PowerShell `powershell` runs commands in, preferring PowerShell 7, and its arguments. */
export function getPowerShellConfig(): Effect.Effect<ReturnType<typeof piGetPowerShellConfig>, CodingAgentFailure> {
	return Effect.try({ try: () => piGetPowerShellConfig(), catch: fromPi });
}
