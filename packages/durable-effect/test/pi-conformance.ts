// What durable-effect restates of Pi Durable by hand, and which of Pi's members it leaves out, checked against Pi's
// own types. Type-only: nothing here runs (the functions below are never called; they exist so the compiler resolves
// Pi's overloads). A failure names what moved upstream.

import type { Context as ChordContext } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type * as PiDurable from "@earendil-works/pi-durable";
import type {
	AgentChange,
	CompactionHooks,
	ConversationCreateOptions,
	ConversationDocFamilyToken,
	ConversationDocToken,
	ConversationHandle,
	DocumentObserver,
	DocumentReader,
	EntryId,
	GenerationHooks,
	HarnessOptions,
	HookApi,
	JsonObject,
	LatestConversationSemantics,
	NextTaskState,
	AfterToolsDecision as PiAfterToolsDecision,
	Conversation as PiConversation,
	ConversationBusy as PiConversationBusy,
	ConversationIdle as PiConversationIdle,
	defineDoc as PiDefineDoc,
	defineDocFamily as PiDefineDocFamily,
	Extension as PiExtension,
	Harness as PiHarness,
	ModelRef as PiModelRef,
	ReadAfterWrite as PiReadAfterWrite,
	ReadOnlySession as PiReadOnlySession,
	SessionFailed as PiSessionFailed,
	StorageRequestError as PiStorageRequestError,
	Submission as PiSubmission,
	Tx as PiTx,
	UserInput as PiUserInput,
	YieldDecision as PiYieldDecision,
	RewindableConversationDocFamilyToken,
	RewindableConversationDocToken,
	RewindableConversationSemantics,
	SessionDocFamilyToken,
	SessionDocToken,
	TaskDefinition,
	TaskDocFamilyToken,
	TaskDocToken,
	TaskRuntime,
	ToolExecutionApi,
	ToolExecutionResult,
	ToolHooks,
	ToolPark,
	ToolRegistration,
} from "@earendil-works/pi-durable";
import type { StrictOmit } from "@effectified/pi-ai";
import type { Assert, Conform, Covers } from "../../../effect/conformance.ts";
import type * as Errors from "../src/errors.ts";
import type {
	Agent,
	Conversation,
	ConversationBusy,
	ConversationIdle,
	Doc,
	Extension,
	Gate,
	Harness,
	Hook,
	ReadAfterWrite,
	ReadOnlySession,
	SessionFailed,
	StorageRequestError,
	Submission,
	Task,
	Tool,
	Tx,
} from "../src/index.ts";

// Facades: every member of a Pi interface this package wraps is wrapped, or named here with why it is not.

/**
 * Every option of Pi's harness is an option of `Harness.layer`, or comes from elsewhere: `models` and `registry` from
 * their services, `now` and `setTimer` from Effect's `Clock`, `onReport` is `Harness.reports`, `onWake` is
 * `hostWakes` with `Harness.wakes`.
 */
export type HarnessOptionsCovered = Assert<
	Covers<HarnessOptions, Harness.Options, "models" | "registry" | "now" | "setTimer" | "onReport" | "onWake">
>;

/**
 * Every method of Pi's harness is a function of `Harness`, or named: the Layer's scope closes it (`close`), `commits`
 * is `observeCommits`, `taskGraph` is `watchTaskGraph`, and `closing` is `subscribeClose`.
 */
export type HarnessCovered = Assert<
	Covers<PiHarness, typeof Harness, "close" | "observeCommits" | "watchTaskGraph" | "subscribeClose">
>;

/** Every method of Pi's conversation is wrapped; `watch` is `changes`, a Stream. */
export type ConversationCovered = Assert<Covers<PiConversation, Conversation.Conversation, "watch">>;

/** Every method of Pi's submission is wrapped. */
export type SubmissionCovered = Assert<Covers<PiSubmission, Submission.Submission>>;

/** Every method of Pi's transaction is wrapped, or left to `tx.pi` on purpose (raw submissions, head markers). */
export type TxCovered = Assert<
	Covers<PiTx, Tx.Tx, "latestHeadMarker" | "createSubmission" | "placeSubmission" | "settleSubmission">
>;

/**
 * Every member of Pi's task runtime is in a task's api, or named: its abort `signal` is the fiber's interruption,
 * `sleepUntil` is the step `Task.sleepUntil`, `setTimer` is `timer`, `hooks` is `eachHook`, and the rest stays on
 * `api.pi`.
 */
export type TaskRuntimeCovered = Assert<
	Covers<
		TaskRuntime<unknown, { phase: string }, unknown, object>,
		Task.Api<unknown, unknown, unknown>,
		"signal" | "sleepUntil" | "setTimer" | "env" | "hooks" | "models" | "registry" | "settings"
	>
>;

/** Every member of Pi's tool api is in a tool's api, or stays on `api.pi`: running output, the environment, models. */
export type ToolApiCovered = Assert<
	Covers<ToolExecutionApi, Tool.Api, "output" | "outputWindow" | "retainedOutput" | "env" | "models" | "registry">
>;

/** Every method of Pi's conversation handle is wrapped. */
export type HandleCovered = Assert<Covers<ConversationHandle, Tool.Handle>>;

/** Every member of Pi's hook api is in a hook's api, or stays on `api.pi`: the models. */
export type HookApiCovered = Assert<Covers<HookApi, Hook.Api, "models">>;

/** Every hook of Pi's generation, tool and compaction tasks has its constructor in `Hook`. */
export type HooksCovered = [
	Assert<Covers<GenerationHooks, typeof Hook>>,
	Assert<Covers<ToolHooks, typeof Hook>>,
	Assert<Covers<CompactionHooks, typeof Hook>>,
];

/** Every field of a Pi extension is a field of an extension of this package. */
export type ExtensionCovered = Assert<Covers<PiExtension, Extension.Extension>>;

/** Every option of a conversation's creation is an option of `createConversation`. */
export type CreateOptionsCovered = Assert<Covers<ConversationCreateOptions, Harness.CreateOptions>>;

/** Every field of a Pi tool is an option of `Tool.make`: `execute` is `handler`, `structuredOutputSchema` `structured`. */
export type ToolCovered = Assert<
	Covers<ToolRegistration, Tool.Tool<string, never, never, unknown, unknown>, "execute" | "structuredOutputSchema">
>;

/**
 * Every field of a Pi task definition is an option of `Task.make`, but its `hooks`, which only types Pi's own: a task
 * of this package types its hooks with `TaskHooks.make`.
 */
export type TaskDefinitionCovered = Assert<
	Covers<
		TaskDefinition<unknown, { phase: string }, unknown, object>,
		Task.Options<never, never, never, never, unknown>,
		"hooks"
	>
>;

/**
 * The document tokens Pi exports: `BuiltinDoc` has the five every conversation has, and `nestedCall`, the task-scoped
 * slots of a tool call's nested calls.
 */
export type BuiltinDocsCovered = Assert<
	Conform<"LiveDoc" | "ProviderDoc" | "UsageDoc" | "InboxDoc" | "AgentDoc" | "NestedCallDoc", keyof DocTokens>
>;

/** The exports of Pi Durable that are document tokens. */
type DocTokens = {
	[K in keyof typeof PiDurable as (typeof PiDurable)[K] extends {
		readonly definition: { readonly kind: string; readonly scope: unknown };
	}
		? K
		: never]: true;
};

// Schemas and unions written by hand: equal to Pi's types both ways, or covering every member.

/** The input a hook task sends a run back with is exactly Pi's, with its list of items never empty. */
export type UserInputSame = Assert<Conform<Hook.UserInput, Continuation>>;

/** What an `onYield` task completes with is exactly Pi's, with a continuation that is never empty. */
export type YieldDecisionSame = Assert<
	Conform<
		Hook.YieldDecision,
		{ [K in keyof PiYieldDecision]: K extends "continue" ? Continuation : PiYieldDecision[K] }
	>
>;

/** Pi's `UserInput` without the empty list, which Pi ignores as a continuation (`yieldContinuation`). */
type Continuation =
	| Exclude<PiUserInput, readonly unknown[]>
	| [Extract<PiUserInput, readonly unknown[]>[number], ...Extract<PiUserInput, readonly unknown[]>[number][]];

/** What an `afterTools` task completes with is exactly Pi's. */
export type AfterToolsDecisionSame = Assert<Conform<Hook.AfterToolsDecision, PiAfterToolsDecision>>;

/** The model of an agent change is exactly Pi's `ModelRef`. */
export type ModelRefSame = Assert<Conform<Agent.ModelRef, PiModelRef>>;

/** The JSON form of an agent change is Pi's `AgentChange` with every tool and extension a name. */
export type ByNameSame = Assert<Conform<Agent.ByName, { readonly [K in keyof AgentChange]?: Names<AgentChange[K]> }>>;

/** `T` with every list of named Pi objects as a list of names. */
type Names<T> = T extends readonly (infer Item)[]
	? Item extends { readonly name: string }
		? ReadonlyArray<string>
		: T
	: T extends object
		? { readonly [K in keyof T]: Names<T[K]> }
		: T;

/** A gate's decision is one of the fields Pi's `beforeTool` result has: a field Pi adds fails here. */
export type GateDecisionsCovered = Assert<Conform<"arguments" | "block" | "sleep", keyof NonNullable<Gate.Decision>>>;

/** Every field of the sleep a gate decides is one of `Gate.Park`'s. */
export type GateSleepCovered = Assert<Covers<NonNullable<NonNullable<Gate.Decision>["sleep"]>, Gate.Park>>;

/** A tool parks in one of Pi's two kinds. */
export type ToolParkKinds = Assert<Conform<"sleep" | "wait", ToolPark["kind"]>>;

/** Every field of a Pi park is one of the matching reply of `Tool`, but the tag. */
export type ToolParksCovered = [
	Assert<Covers<Park<"sleep">, Tool.Sleep, "kind">>,
	Assert<Covers<Park<"wait">, Tool.Wait, "kind">>,
];

/** Pi's park of `kind` without the result fields every park lacks. */
type Park<Kind extends ToolPark["kind"]> = StrictOmit<
	Extract<ToolPark, { readonly kind: Kind }>,
	Exclude<keyof ToolExecutionResult, "kind">
>;

/** A task commits for itself one of Pi's four states. */
export type TaskStepStatuses = Assert<
	Conform<"running" | "sleeping" | "waiting" | "terminal", NextTaskState<unknown, unknown>["status"]>
>;

/** Every field of a sleeping or waiting state is one of the matching step, `checkpoint` being its `state`. */
export type TaskStepsCovered = [
	Assert<Covers<Next<"sleeping">, Task.Sleep<unknown>, "status" | "checkpoint" | "outcome">>,
	Assert<Covers<Next<"waiting">, Task.Wait<unknown>, "status" | "checkpoint" | "outcome">>,
];

/** Pi's state of `status` a task commits for itself. */
type Next<Status extends NextTaskState<unknown, unknown>["status"]> = Extract<
	NextTaskState<unknown, unknown>,
	{ readonly status: Status }
>;

/** The error classes Pi Durable exports are exactly those `fromRejection` gives a tag of their own. */
export type ErrorClassesTagged = Assert<Conform<Errors.TaggedClass, keyof PiErrorClasses>>;

/** The exports of Pi Durable whose instances are `Error`s. */
type PiErrorClasses = {
	[K in keyof typeof PiDurable as (typeof PiDurable)[K] extends abstract new (
		...args: never[]
	) => Error
		? K
		: never]: true;
};

/** Each tagged error carries every field Pi's error class adds to `Error`, with Pi's type. */
export type ErrorFieldsSame = [
	Assert<Carried<ConversationBusy, PiConversationBusy>>,
	Assert<Carried<ConversationIdle, PiConversationIdle>>,
	Assert<Carried<ReadAfterWrite, PiReadAfterWrite>>,
	Assert<Carried<ReadOnlySession, PiReadOnlySession>>,
	Assert<Carried<SessionFailed, PiSessionFailed>>,
	Assert<Carried<StorageRequestError, PiStorageRequestError>>,
];

/** The fields `Pi`'s error adds to `Error`, as `Ours` has them, against Pi's. */
type Carried<Ours, Pi> = Conform<Pick<Ours, Extract<keyof Own<Pi>, keyof Ours>>, Own<Pi>>;

/** The fields an error class adds to `Error`. */
type Own<E> = Omit<E, keyof Error>;

// Pi's overloaded document methods, called per scope with the arguments this package spreads after a token
// (`Doc.Address`, `Doc.Opening`). `Doc` casts Pi's overloads away; these calls are what holds its arguments to them.

/** A document of this package of each scope, and a family of each. */
interface Docs {
	readonly session: Doc.Doc<Doc.ValueSchema, "session", undefined>;
	readonly conversation: Doc.Doc<Doc.ValueSchema, "conversation", "latest">;
	readonly rewindable: Doc.Doc<Doc.ValueSchema, "conversation", "rewindable">;
	readonly task: Doc.Doc<Doc.ValueSchema, "task", undefined>;
	readonly sessionFamily: Doc.Family<Doc.ValueSchema, "session", undefined, JsonValue>;
	readonly conversationFamily: Doc.Family<Doc.ValueSchema, "conversation", "latest", JsonValue>;
	readonly rewindableFamily: Doc.Family<Doc.ValueSchema, "conversation", "rewindable", JsonValue>;
	readonly taskFamily: Doc.Family<Doc.ValueSchema, "task", undefined, JsonValue>;
}

/** Pi's token of each scope, as Pi's overloads take it. */
interface Tokens {
	readonly session: SessionDocToken<JsonObject>;
	readonly conversation: ConversationDocToken<JsonObject>;
	readonly rewindable: RewindableConversationDocToken<JsonObject>;
	readonly task: TaskDocToken<JsonObject>;
	readonly sessionFamily: SessionDocFamilyToken<JsonObject, JsonValue>;
	readonly conversationFamily: ConversationDocFamilyToken<JsonObject, JsonValue>;
	readonly rewindableFamily: RewindableConversationDocFamilyToken<JsonObject, JsonValue>;
	readonly taskFamily: TaskDocFamilyToken<JsonObject, JsonValue>;
}

/** The address of a document of each scope, as `Doc.Address` types it. */
type Addresses = { readonly [K in keyof Docs]: Doc.Address<Docs[K]> };

/** What a commit opens a document of each scope with, as `Doc.Opening` types it. */
type Openings = { readonly [K in keyof Docs]: Doc.Opening<Docs[K]> };

/** Per scope, `Doc.reader`'s `snapshot` and `snapshotAsOf` arguments are those of Pi's overload for that scope. */
export function readArguments(
	pi: DocumentReader,
	token: Tokens,
	address: Addresses,
	at: EntryId,
	context: ChordContext,
): ReadonlyArray<Promise<unknown>> {
	return [
		pi.snapshot(token.session, ...address.session, context),
		pi.snapshot(token.conversation, ...address.conversation, context),
		pi.snapshot(token.task, ...address.task, context),
		pi.snapshot(token.sessionFamily, ...address.sessionFamily, context),
		pi.snapshot(token.conversationFamily, ...address.conversationFamily, context),
		pi.snapshot(token.taskFamily, ...address.taskFamily, context),
		pi.snapshotAsOf(token.rewindable, ...address.rewindable, at, context),
		pi.snapshotAsOf(token.rewindableFamily, ...address.rewindableFamily, at, context),
	];
}

/** Per scope, `Doc.watch`'s arguments are those of Pi's `watchDoc` overload for that scope. */
export function watchArguments(
	pi: DocumentObserver,
	token: Tokens,
	address: Addresses,
	context: ChordContext,
): ReadonlyArray<Promise<unknown>> {
	return [
		pi.watchDoc(token.session, ...address.session, context),
		pi.watchDoc(token.conversation, ...address.conversation, context),
		pi.watchDoc(token.task, ...address.task, context),
		pi.watchDoc(token.sessionFamily, ...address.sessionFamily, context),
		pi.watchDoc(token.conversationFamily, ...address.conversationFamily, context),
		pi.watchDoc(token.taskFamily, ...address.taskFamily, context),
	];
}

/** Per scope, `Doc.open`'s and `Doc.retire`'s arguments are those of Pi's `doc` and `retireDoc` overloads. */
export function writeArguments(
	tx: PiTx,
	token: Tokens,
	opening: Openings,
	address: Addresses,
): ReadonlyArray<Promise<unknown>> {
	return [
		tx.doc(token.session, ...opening.session),
		tx.doc(token.conversation, ...opening.conversation),
		tx.doc(token.task, ...opening.task),
		tx.doc(token.sessionFamily, ...opening.sessionFamily),
		tx.doc(token.conversationFamily, ...opening.conversationFamily),
		tx.doc(token.taskFamily, ...opening.taskFamily),
		tx.retireDoc(token.session, ...address.session),
		tx.retireDoc(token.conversation, ...address.conversation),
		tx.retireDoc(token.task, ...address.task),
		tx.retireDoc(token.sessionFamily, ...address.sessionFamily),
		tx.retireDoc(token.conversationFamily, ...address.conversationFamily),
		tx.retireDoc(token.taskFamily, ...address.taskFamily),
	];
}

/** What `Doc.make` hands Pi's `defineDoc` for a definition of semantics `M`. */
type Defined<M> = StrictOmit<Doc.Shared<Doc.ValueSchema>, "schema" | "migrate"> &
	M & {
		readonly initial: () => JsonObject;
		readonly migrate?: (stored: JsonObject, fromVersion: number) => JsonObject;
	};

/** What `Doc.family` hands Pi's `defineDocFamily` for a definition of semantics `M`. */
type DefinedFamily<M> = StrictOmit<Doc.Shared<Doc.ValueSchema>, "schema" | "migrate"> &
	M & {
		readonly family: true;
		readonly initial: (seed: JsonValue) => JsonObject;
		readonly migrate?: (stored: JsonObject, fromVersion: number) => JsonObject;
	};

/** Per scope, what `Doc.make` and `Doc.family` hand Pi (behind a cast there) is a definition Pi's overloads take. */
export function defineArguments(
	defineDoc: typeof PiDefineDoc,
	defineDocFamily: typeof PiDefineDocFamily,
	definition: {
		readonly session: Defined<{ readonly scope: "session" }>;
		readonly conversation: Defined<LatestConversationSemantics>;
		readonly rewindable: Defined<RewindableConversationSemantics>;
		readonly task: Defined<{ readonly scope: "task" }>;
		readonly sessionFamily: DefinedFamily<{ readonly scope: "session" }>;
		readonly conversationFamily: DefinedFamily<LatestConversationSemantics>;
		readonly rewindableFamily: DefinedFamily<RewindableConversationSemantics>;
		readonly taskFamily: DefinedFamily<{ readonly scope: "task" }>;
	},
): ReadonlyArray<unknown> {
	return [
		defineDoc(definition.session),
		defineDoc(definition.conversation),
		defineDoc(definition.rewindable),
		defineDoc(definition.task),
		defineDocFamily(definition.sessionFamily),
		defineDocFamily(definition.conversationFamily),
		defineDocFamily(definition.rewindableFamily),
		defineDocFamily(definition.taskFamily),
	];
}
