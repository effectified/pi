// The system prompt of a documentation eval: the documentation section taken out, and the prompt sent checked against
// its variant.

import {
	excludePiDocumentation,
	type PiCodingAgentHarnessOptions,
	verifySystemPrompt,
} from "@earendil-works/pi-evals/src/harness.ts";
import { Effect } from "effect";
import { messageOf, PromptMismatch } from "./errors.ts";

/**
 * `systemPrompt`, when it fits the variant: it keeps its rules, and has Pi's documentation section exactly when
 * `expectedPiDocumentation` says so. Without `expectedPiDocumentation` every prompt fits. Fails with
 * `PromptMismatch`, whose message names the variant by `name`.
 */
export const verify = Effect.fn("SystemPrompt.verify")(
	(systemPrompt: string, options: Pick<PiCodingAgentHarnessOptions, "name" | "expectedPiDocumentation">) =>
		Effect.try({ try: () => verifySystemPrompt(systemPrompt, options), catch: promptMismatch }),
);

/**
 * Pi's default system prompt without its documentation section, the rest unchanged: the `without_docs` variant.
 * Fails with `PromptMismatch` when the prompt has no complete documentation section before its working directory.
 */
export const excludeDocumentation = Effect.fn("SystemPrompt.excludeDocumentation")((defaultPrompt: string) =>
	Effect.try({ try: () => excludePiDocumentation(defaultPrompt), catch: promptMismatch }),
);

function promptMismatch(cause: unknown): PromptMismatch {
	return PromptMismatch.make({ message: messageOf(cause) });
}
