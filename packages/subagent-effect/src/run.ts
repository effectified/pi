// The durable task behind every child: it hands the child its task, sleeps until the child's submission settles,
// sends an answer that does not match the declared result back, and records how the child ended.

import type {
	ConversationId,
	EntryRecord,
	SettledSubmissionRecord,
	SubmissionDraft,
	TaskId,
} from "@effectified/pi-durable";
import {
	type DurableError,
	type SchemaConversionError,
	type SchemaDecodeError,
	Signal,
	Task,
	type Tool,
	type Tx,
} from "@effectified/pi-durable";
import { Data, Effect, Option, Schema } from "effect";
import * as Child from "./child.ts";
import * as ChildSetup from "./child-setup.ts";
import * as Copy from "./copy.ts";
import * as Declared from "./declared.ts";
import * as Outcome from "./outcome.ts";
import * as Result from "./result.ts";
import * as Started from "./started.ts";
import { Name } from "./subagent-name.ts";

/** The task's kind, as Pi stores it: live tasks of this kind in a conversation are its live subagents. */
export const NAME = "subagent.run";

/** The entry kind a background child's result is placed as in its parent: the model reads it as a user message. */
export const REPORT = "subagent.report";

/** What a run is created with. The child's conversation is not part of it: the task is created first, to own it. */
const Input = Schema.Struct({
	subagent: Name,
	/** The task for the child, as the parent's model wrote it. */
	task: Schema.String,
	mode: Child.Mode,
	depth: Child.Depth,
});

/** The number of a run's submission to its child, from 0: the task, then each correction. */
const Attempt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** `start` hands the child its task; `settle` reads what became of the submission numbered `attempt`. */
const State = Schema.Union([
	Schema.Struct({ phase: Schema.Literal("start") }),
	Schema.Struct({ phase: Schema.Literal("settle"), attempt: Attempt }),
]).pipe(Schema.toTaggedUnion("phase"));

/** The run task of one extension: `R` is what its phases need, the product's `ChildSetup`. */
export type Run = Task.Task<typeof Input, typeof State, typeof Schema.Null, ChildSetup.ChildSetup>;

/** The declarations, ready once the registry built them. */
type Ready = Effect.Effect<Declared.Declared, SchemaConversionError>;

/**
 * Defines the run task over `declared`. One task drives both kinds of child, and what differs is who owns it:
 *
 * - A foreground run is a child task of the parent's tool call, which waits for it (`Tool.wait`). Aborting the parent
 *   aborts the call, and Pi's cascade reaches the run and the conversation it owns.
 * - A background run is a conversation-owned task with `background: true`: Pi's abort and idle traversal stop at it,
 *   so the child outlives the parent's abort and does not keep the parent busy.
 *
 * The run holds no process while the child works: it submits with `notify` and sleeps on Pi's `SubmissionSettled`.
 *
 * A run that was copied with its storage does none of this (`unlessCopied`).
 */
export function make(declared: Ready): Run {
	return Task.make({
		name: NAME,
		version: 1,
		input: Input,
		state: State,
		result: Schema.Null,
		initial: () => ({ phase: "start" as const }),
		phases: {
			start: (task, api) => unlessCopied(task, api, handOver(declared, task, api)),
			settle: (task, api) => unlessCopied(task, api, settle(declared, task, api)),
		},
		// The work the run owns, the child's, has ended when Pi runs this: only the record is left to write.
		abort: (task, api) => unlessCopied(task, api, end(task, api, Outcome.failed("aborted"), Task.aborted())),
	});
}

/** The child of a run: what the setup port is told of it, and the link its document was created from. */
interface Located {
	readonly child: ChildSetup.Child;
	readonly link: Child.Link;
}

/**
 * What a run drives: its child, the child's conversation, and where the result of a background child is sent. An
 * interface, not a Schema: it holds Pi's conversation handles.
 */
interface Driven extends Located {
	readonly conversation: Tool.Handle;
	/** The parent's conversation, for a background child; none for a foreground one, whose tool call reads the result. */
	readonly reportTo: Option.Option<Tool.Handle>;
}

/** What a commit of a run stores as the task's step. */
type Step = Task.Step<typeof State.Type, null>;

/** What reading and writing a run's records fails with. */
type Failure = DurableError | SchemaDecodeError;

/** The api of a run's handlers. */
type Api = Task.Api<typeof Input.Type, typeof State.Type, null>;

/** The task a run's handlers run for, in the phase `P`. */
type Running<P extends (typeof State.Type)["phase"] = (typeof State.Type)["phase"]> = Task.Running<
	typeof Input.Type,
	Extract<typeof State.Type, { readonly phase: P }>
>;

/**
 * `handler`, unless the run was copied with its storage (`onStorageFork`): then it ends at once, `aborted` with the
 * reason `copied`. It hands its child no task, sends its parent no report and asks the setup port nothing: the child
 * and its result belong to the storage the run was copied from, where the run goes on. The child's document says so.
 */
function unlessCopied<A, E, R>(
	task: Running,
	api: Api,
	handler: Effect.Effect<A, E, R>,
): Effect.Effect<A | Task.Committed, E | Failure | SchemaConversionError, R> {
	return Effect.flatMap(
		api.snapshot(Copy.Document),
		(mark): Effect.Effect<A | Task.Committed, E | Failure | SchemaConversionError, R> =>
			Copy.covers(mark, task.id) ? end(task, api, Outcome.failed(Copy.REASON), Task.aborted(Copy.REASON)) : handler,
	);
}

/**
 * Hands the child its task, with the contract of a declared result. The product's setup may still refuse the child
 * first: then the run ends with the child failed, without a provider request.
 */
const handOver = Effect.fn("SubagentRun.handOver")(function* (declared: Ready, task: Running<"start">, api: Api) {
	const ready = yield* declared;
	const entry = yield* Declared.find(ready, task.input.subagent);
	const driven = yield* drive(task, api);
	const setup = yield* ChildSetup.ChildSetup;
	return yield* Effect.matchEffect(setup.beforeStart(driven.child), {
		onFailure: (refused) =>
			api.commit((tx) =>
				finish(
					tx,
					driven,
					Option.none(),
					Child.State.cases.Failed.make({ reason: "setup_failed", message: refused.message, answer: null }),
				),
			),
		onSuccess: () => {
			const content = Option.match(entry.typed, {
				onNone: () => task.input.task,
				onSome: (typed) => `${task.input.task}\n\n${typed.contract}`,
			});
			// The request id makes a phase that runs again find the submission it already made.
			return Effect.as(driven.conversation.submit(ask(task.id, 0, content)), sleepFor(0));
		},
	});
});

/**
 * Reads what became of the submission numbered `attempt`, and acts on it in one commit: the child ended, or its answer
 * did not match the declared result and it is asked again.
 */
const settle = Effect.fn("SubagentRun.settle")(function* (declared: Ready, task: Running<"settle">, api: Api) {
	const { attempt } = task.state;
	const settled = yield* settledAt(api, attempt);
	// A phase that runs before its time sleeps again with the same state, as Pi's own tasks do (spec 5.6).
	if (Option.isNone(settled)) return sleepFor(attempt);
	const ready = yield* declared;
	const entry = yield* Declared.find(ready, task.input.subagent);
	const driven = yield* drive(task, api);
	return yield* api.commit((tx) =>
		Effect.flatMap(judge(tx, entry, settled.value, attempt), (verdict): Effect.Effect<Step, Failure> =>
			Verdict.$match(verdict, {
				Ended: ({ state, answer }) => finish(tx, driven, answer, state),
				// Admitted in this commit, so a phase that runs again never sends a correction twice.
				Correct: ({ message }) =>
					Effect.as(driven.conversation.admit(tx, ask(task.id, attempt + 1, message)), sleepFor(attempt + 1)),
			}),
		),
	);
});

/** Ends the run with `ending`, in the commit that writes how its child ended, `state`, to the child's document. */
const end = Effect.fn("SubagentRun.end")(function* (
	task: Running,
	api: Api,
	state: Child.Ended,
	ending: Task.End<null>,
) {
	const located = yield* locate(task, api);
	return yield* api.commit((tx) => Effect.as(record(tx, located, state), ending));
});

/** The child of the run `task`, found by the document the creating commit wrote under the task. */
const locate = Effect.fn("SubagentRun.locate")(function* (task: Running, api: Api) {
	const document = yield* api.snapshot(Started.Document, task.id);
	const found = Option.flatMap(document, (value) => Option.fromNullOr(value.started));
	// The commit that created the task wrote the document, so an absent one is a defect.
	const { conversationId } = yield* Effect.orDie(Effect.fromOption(found));
	const { subagent, mode, depth } = task.input;
	const parentId = task.conversationId;
	const located: Located = {
		child: ChildSetup.Child.make({ conversationId, parentId, subagent, mode, depth }),
		link: { conversation: conversationId, subagent, parent: parentId, depth, mode, task: task.id },
	};
	return located;
});

/**
 * The child of the run `task` with the handles a phase needs. They are taken before the phase's commit: a read of a
 * conversation inside a commit waits for the commit itself.
 */
const drive = Effect.fn("SubagentRun.drive")(function* (task: Running, api: Api) {
	const located = yield* locate(task, api);
	// Both conversations exist: the child was created with the task, and the task lives in the parent's.
	const handle = (id: ConversationId) => Effect.orDie(Effect.flatMap(api.conversation(id), Effect.fromOption));
	const conversation = yield* handle(located.child.conversationId);
	const reportTo = yield* located.child.mode === "background"
		? Effect.asSome(handle(task.conversationId))
		: Effect.succeedNone;
	const driven: Driven = { ...located, conversation, reportTo };
	return driven;
});

/** The key of the wait for the submission numbered `attempt`. One wait per key (spec 5.7): each attempt has its own. */
function waitKey(attempt: number): string {
	return `settled:${attempt}`;
}

/** The sleep until the submission numbered `attempt` settles. */
function sleepFor(attempt: number): Task.Sleep<typeof State.Type> {
	return Task.sleep({
		state: { phase: "settle", attempt },
		signals: [Signal.SubmissionSettled.key(waitKey(attempt))],
	});
}

/** The settled record of the submission numbered `attempt`; none while it is open. */
function settledAt(
	api: Api,
	attempt: number,
): Effect.Effect<Option.Option<SettledSubmissionRecord>, Failure | SchemaConversionError> {
	return Effect.map(api.readSignal(Signal.SubmissionSettled, waitKey(attempt)), (state) =>
		// A sleep without a deadline never expires, so a state that is no value is as good as none.
		Option.flatMap(state, (read) => (read.kind === "value" ? Option.some(read.value) : Option.none())),
	);
}

/** The input numbered `attempt` of the run `taskId` for its child: the task, or a correction. */
function ask(taskId: TaskId, attempt: number, content: string): SubmissionDraft {
	return {
		type: "input",
		content,
		requestId: `subagent:${taskId}:${attempt}`,
		notify: { taskId, key: waitKey(attempt) },
	};
}

/**
 * What a settled submission means for the run: the child ended, or it is asked again. A `Data.TaggedEnum`, not a
 * Schema: it holds Pi's entry record, and lives inside one commit.
 */
type Verdict = Data.TaggedEnum<{
	Ended: { readonly state: Child.Ended; readonly answer: Option.Option<EntryRecord> };
	Correct: { readonly message: string };
}>;

/** The constructors and the matcher of `Verdict`. */
const Verdict = Data.taggedEnum<Verdict>();

/** Reads the answer of `settled`, in the commit that acts on it, and checks it against a declared result. */
const judge = Effect.fn("SubagentRun.judge")(function* (
	tx: Tx.Tx,
	entry: Declared.Entry,
	settled: SettledSubmissionRecord,
	attempt: number,
) {
	const answered = Outcome.answered(settled);
	if (Option.isNone(answered)) return Verdict.Ended({ state: Outcome.unanswered(settled), answer: Option.none() });
	const id = answered.value;
	const answer = yield* tx.entry(id);
	const { typed } = entry;
	if (Option.isNone(typed)) return Verdict.Ended({ state: Child.State.cases.Answered.make({ answer: id }), answer });
	return yield* Effect.match(typed.value.decode(Outcome.textOf(answer)), {
		onSuccess: (result): Verdict =>
			Verdict.Ended({ state: Child.State.cases.Typed.make({ answer: id, result }), answer }),
		onFailure: (mismatch): Verdict =>
			attempt < entry.corrections
				? Verdict.Correct({ message: Result.correction(mismatch) })
				: Verdict.Ended({
						state: Child.State.cases.Failed.make({
							reason: "invalid_result",
							message: `${mismatch.message}, after ${entry.corrections} corrections.`,
							answer: id,
						}),
						answer,
					}),
	});
});

/**
 * Ends the run in the commit of `tx`: the child's document gets `state`, and the parent of a background child gets
 * the result as an input, Pi's way of telling a conversation something later (example 22). It starts a turn when the
 * parent is idle and follows its current answer otherwise; `onAbort: "keep"` keeps it through a Stop of the parent,
 * since nobody can send it again. All of it is stored with the task's end, or not at all.
 */
const finish = Effect.fn("SubagentRun.finish")(function* (
	tx: Tx.Tx,
	driven: Driven,
	answer: Option.Option<EntryRecord>,
	state: Child.Ended,
) {
	if (Option.isSome(driven.reportTo)) {
		const { conversationId, subagent } = driven.child;
		const handle = Child.key(conversationId);
		const { isError, text } = Outcome.reading(state, answer);
		// An admission reads, so it comes before the commit's writes.
		yield* driven.reportTo.value.admit(tx, {
			type: "input",
			content: `[subagent ${subagent}, handle ${handle}, ${isError ? "failed" : "finished"}]\n${text}`,
			whenBusy: "followUp",
			onAbort: "keep",
			requestId: `subagent-report:${driven.link.task}`,
			entry: { kind: REPORT, data: { handle, conversationId, subagent, isError } },
		});
	}
	yield* record(tx, driven, state);
	return Task.complete(null);
});

/** Writes how the child ended to its document. */
function record(tx: Tx.Tx, located: Located, state: Child.Ended): Effect.Effect<void, Failure> {
	return Effect.flatMap(tx.doc(Child.Document, Child.key(located.child.conversationId), located.link), (document) =>
		document.update((current) => ({ ...current, state })),
	);
}
