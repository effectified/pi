// The process settings an eval run reads: the model, the documentation variant, and an isolated home for the run.

import {
	applyIsolatedEnvironment,
	type PiCodingAgentModelSelection,
	resolveDocumentationVariant,
	resolveModelSelection,
} from "@earendil-works/pi-evals/src/harness.ts";
import type { DocumentationVariant } from "@earendil-works/pi-evals/src/plan.ts";
import { Effect, type Scope } from "effect";
import { InvalidSetting, messageOf } from "./errors.ts";

/**
 * The model a harness runs: `explicit` when given, else `PI_PROVIDER` and `PI_MODEL` of `environment` (the process
 * environment when it is left out), trimmed. Fails with `InvalidSetting` when neither names both.
 */
export function modelSelection(
	explicit: PiCodingAgentModelSelection | undefined,
	environment?: Parameters<typeof resolveModelSelection>[1],
): Effect.Effect<PiCodingAgentModelSelection, InvalidSetting> {
	return Effect.try({ try: () => resolveModelSelection(explicit, environment), catch: invalidSetting });
}

/**
 * `value` (`PI_EVAL_VARIANT` of the process environment when it is left out) as a documentation variant. Fails with
 * `InvalidSetting` when it is neither `without_docs` nor `with_docs`.
 */
export function documentationVariant(value?: string): Effect.Effect<DocumentationVariant, InvalidSetting> {
	return Effect.try({ try: () => resolveDocumentationVariant(value), catch: invalidSetting });
}

/**
 * For the scope: `HOME`, `USERPROFILE` and `PI_CODING_AGENT_DIR` set to `home` and `agentDir`, and every `PI_EVAL_*`
 * variable removed. Closing the scope restores them. The process environment is global: two scopes open at once
 * in one process see each other's values. On Bun, `os.homedir()` does not follow `HOME`.
 */
export function isolated(home: string, agentDir: string): Effect.Effect<void, never, Scope.Scope> {
	return Effect.asVoid(
		Effect.acquireRelease(
			Effect.sync(() => applyIsolatedEnvironment(home, agentDir)),
			(restore) => Effect.sync(restore),
		),
	);
}

function invalidSetting(cause: unknown): InvalidSetting {
	return new InvalidSetting({ message: messageOf(cause) });
}
