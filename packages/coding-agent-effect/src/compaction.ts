// pi-coding-agent's compaction and summaries in Effect: the model requests that summarize a conversation or a branch,
// sent through the program's `StreamFn` and cancelled by interruption. Pi's pure helpers stay as they are.

import {
	type BranchSummaryResult,
	type CompactionResult,
	type GenerateBranchSummaryOptions,
	compact as piCompact,
	generateBranchSummary as piGenerateBranchSummary,
	generateSummaryWithUsage as piGenerateSummaryWithUsage,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { type AgentMessage, StreamFn } from "@effectified/pi-agent";
import type { Usage } from "@effectified/pi-ai";
import { Effect, Redacted } from "effect";
import { type CodingAgentFailure, fromPi } from "./errors.ts";

/** Pi's positional arguments of `generateSummary`, named. */
type SummaryArguments = Parameters<typeof piGenerateSummaryWithUsage>;

/**
 * How a summary is requested: the model and its credentials, the instructions, and Pi's retry policy. The API key
 * stays `Redacted` until Pi sends the request.
 */
export interface SummaryOptions {
	readonly model: SummaryArguments[1];
	readonly apiKey?: Redacted.Redacted<string>;
	readonly headers?: SummaryArguments[4];
	/** Added to (or, for a branch, with `replaceInstructions`, instead of) Pi's summary prompt. */
	readonly customInstructions?: string;
	readonly thinkingLevel?: SummaryArguments[8];
	readonly env?: SummaryArguments[10];
	readonly retry?: SummaryArguments[11];
	/** The session the request belongs to, for providers that route or cache by it. */
	readonly sessionId?: string;
}

/** What `generateSummary` takes besides the messages: the summary it updates, if any. */
export interface ConversationOptions extends SummaryOptions {
	readonly previousSummary?: string;
}

/**
 * What `generateBranchSummary` takes besides the entries: Pi's options, the request through `StreamFn`, the API key
 * `Redacted`.
 */
export type BranchOptions = Omit<GenerateBranchSummaryOptions, "signal" | "streamFn" | "callbacks" | "apiKey"> & {
	readonly apiKey?: Redacted.Redacted<string>;
};

/**
 * Compacts what `preparation` selected (the one a `session_before_compact` event carries): summarizes the messages it
 * cuts and keeps the rest. Interrupting it cancels the request.
 */
// Written out: the declaration build cannot name Pi's `CompactionPreparation`, which its package does not export.
export const compact: (
	preparation: Parameters<typeof piCompact>[0],
	options: SummaryOptions,
) => Effect.Effect<CompactionResult, CodingAgentFailure, StreamFn> = Effect.fn("Compaction.compact")(
	(
		preparation: Parameters<typeof piCompact>[0],
		options: SummaryOptions,
	): Effect.Effect<CompactionResult, CodingAgentFailure, StreamFn> =>
		request((signal, streamFn) =>
			piCompact(
				preparation,
				options.model,
				revealed(options.apiKey),
				options.headers,
				options.customInstructions,
				signal,
				options.thinkingLevel,
				streamFn,
				options.env,
				options.retry,
				undefined,
				options.sessionId,
			),
		),
);

/** A summary of `messages` (or an update of `previousSummary` with them) and the usage of its request. */
export const generateSummary = Effect.fn("Compaction.generateSummary")(
	(
		messages: ReadonlyArray<AgentMessage>,
		options: ConversationOptions,
	): Effect.Effect<{ readonly text: string; readonly usage: Usage }, CodingAgentFailure, StreamFn> =>
		request((signal, streamFn) =>
			piGenerateSummaryWithUsage(
				[...messages],
				options.model,
				undefined,
				revealed(options.apiKey),
				options.headers,
				signal,
				options.customInstructions,
				options.previousSummary,
				options.thinkingLevel,
				streamFn,
				options.env,
				options.retry,
				undefined,
				options.sessionId,
			),
		),
);

/** A summary of the branch `entries` leave, as Pi writes it when the session moves to another point of its tree. */
export const generateBranchSummary = Effect.fn("Compaction.generateBranchSummary")(
	(
		entries: ReadonlyArray<SessionEntry>,
		options: BranchOptions,
	): Effect.Effect<BranchSummaryResult, CodingAgentFailure, StreamFn> =>
		request((signal, streamFn) => {
			const { apiKey, ...rest } = options;
			return piGenerateBranchSummary([...entries], {
				...rest,
				...(apiKey === undefined ? {} : { apiKey: Redacted.value(apiKey) }),
				signal,
				streamFn,
			});
		}),
);

/** A summary request through the program's `StreamFn`, cancelled through its signal when the fiber is interrupted. */
function request<A>(
	send: (signal: AbortSignal, streamFn: StreamFn["Service"]) => Promise<A>,
): Effect.Effect<A, CodingAgentFailure, StreamFn> {
	return Effect.flatMap(StreamFn, (streamFn) =>
		Effect.tryPromise({ try: (signal) => send(signal, streamFn), catch: fromPi }),
	);
}

/** The API key as Pi takes it: it leaves `Redacted` here, where Pi puts it on the request. */
function revealed(apiKey: Redacted.Redacted<string> | undefined): string | undefined {
	return apiKey === undefined ? undefined : Redacted.value(apiKey);
}
