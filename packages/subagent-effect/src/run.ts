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
import { Effect, Option, Schema } from "effect";
import * as Child from "./child.ts";
import * as ChildSetup from "./child-setup.ts";
import * as Copy from "./copy.ts";
import * as Declared from "./declared.ts";
import * as Outcome from "./outcome.ts";
import * as Result from "./result.ts";
import * as Started from "./started.ts";

/** The task's kind, as Pi stores it: live tasks of this kind in a conversation are its live subagents. */
export const NAME = "subagent.run";

/** The entry kind a background child's result is placed as in its parent: the model reads it as a user message. */
export const REPORT = "subagent.report";

/** What a run is created with. The child's conversation is not part of it: the task is created first, to own it. */
const Input = Schema.Struct({
	subagent: Schema.String,
	/** The task for the child, as the parent's model wrote it. */
	task: Schema.String,
	mode: Child.Mode,
	depth: Schema.Number,
});

/** `start` hands the child its task; `settle` reads what became of the submission numbered `attempt`. */
const State = Schema.Union([
	Schema.Struct({ phase: Schema.Literal("start") }),
	Schema.Struct({ phase: Schema.Literal("settle"), attempt: Schema.Number }),
]);

/** The run task of one extension: `R` is what its phases need, the product's `ChildSetup`. */
export type Run = Task.Task<typeof Input, typeof State, typeof Schema.Null, ChildSetup.ChildSetup>;

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
export function make(declared: Effect.Effect<Declared.Declared, SchemaConversionError>): Run {
	return Task.make({
		name: NAME,
		version: 1,
		input: Input,
		state: State,
		result: Schema.Null,
		initial: () => ({ phase: "start" as const }),
		phases: {
			start: (task, api) =>
				unlessCopied(
					task,
					api,
					Effect.gen(function* () {
						const entry = yield* Declared.find(yield* declared, task.input.subagent);
						const driven = yield* drive(task, api);
						const setup = yield* ChildSetup.ChildSetup;
						return yield* Effect.matchEffect(setup.beforeStart(driven.child), {
							onFailure: (refused) =>
								api.commit((tx) =>
									finish(tx, driven, Option.none(), {
										_tag: "Failed",
										reason: "setup_failed",
										message: refused.message,
										answer: null,
									}),
								),
							onSuccess: () =>
								Effect.gen(function* () {
									const content = Option.match(entry.typed, {
										onNone: () => task.input.task,
										onSome: (typed) => `${task.input.task}\n\n${typed.contract}`,
									});
									// The request id makes a phase that runs again find the submission it already made.
									yield* driven.conversation.submit(ask(task.id, 0, content));
									return sleepFor(0);
								}),
						});
					}),
				),
			settle: (task, api) =>
				unlessCopied(
					task,
					api,
					Effect.gen(function* () {
						const { attempt } = task.state;
						const settled = yield* settledAt(api, attempt);
						// A phase that runs before its time sleeps again with the same state, as Pi's own tasks do (spec 5.6).
						if (Option.isNone(settled)) return sleepFor(attempt);
						const entry = yield* Declared.find(yield* declared, task.input.subagent);
						const driven = yield* drive(task, api);
						return yield* api.commit((tx) =>
							Effect.flatMap(
								judge(tx, entry, settled.value, attempt),
								(verdict): Effect.Effect<Step, Failure> => {
									switch (verdict._tag) {
										case "Ended":
											return finish(tx, driven, verdict.answer, verdict.state);
										case "Correct":
											// Admitted in this commit, so a phase that runs again never sends a correction twice.
											return Effect.as(
												driven.conversation.admit(tx, ask(task.id, attempt + 1, verdict.message)),
												sleepFor(attempt + 1),
											);
									}
								},
							),
						);
					}),
				),
		},
		// The work the run owns, the child's, has ended when Pi runs this: only the record is left to write.
		abort: (task, api) => unlessCopied(task, api, end(task, api, Outcome.failed("aborted"), Task.aborted())),
	});
}

/**
 * `handler`, unless the run was copied with its storage (`onStorageFork`): then it ends at once, `aborted` with the
 * reason `copied`. It hands its child no task, sends its parent no report and asks the setup port nothing: the child
 * and its result belong to the storage the run was copied from, where the run goes on. The child's document says so.
 */
function unlessCopied<A, E, R>(task: Running, api: Api, handler: Effect.Effect<A, E, R>) {
	return Effect.flatMap(
		api.snapshot(Copy.Document),
		(mark): Effect.Effect<A | Task.Committed, E | Failure | SchemaConversionError, R> =>
			Copy.covers(mark, task.id) ? end(task, api, Outcome.failed(Copy.REASON), Task.aborted(Copy.REASON)) : handler,
	);
}

/** Ends the run with `ending`, in the commit that writes how its child ended, `state`, to the child's document. */
function end(task: Running, api: Api, state: Child.Ended, ending: Task.End<null>) {
	return Effect.flatMap(locate(task, api), (located) =>
		api.commit((tx) => Effect.as(record(tx, located, state), ending)),
	);
}

/** The child of a run: what the setup port is told of it, and the link its document was created from. */
interface Located {
	readonly child: ChildSetup.Child;
	readonly link: Child.Link;
}

/** What a run drives: its child, the child's conversation, and where the result of a background child is sent. */
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

/** The task a run's handlers run for. */
type Running = Task.Running<typeof Input.Type, typeof State.Type>;

/** The child of the run `task`, found by the document the creating commit wrote under the task. */
function locate(task: Running, api: Api): Effect.Effect<Located, Failure> {
	return Effect.gen(function* () {
		const found = Option.flatMap(yield* api.snapshot(Started.Document, task.id), (value) =>
			Option.fromNullOr(value.started),
		);
		// The commit that created the task wrote the document, so an absent one is a defect.
		const { conversationId } = yield* Effect.orDie(Effect.fromOption(found));
		const { subagent, mode, depth } = task.input;
		const parentId = task.conversationId;
		return {
			child: { conversationId, parentId, subagent, mode, depth },
			link: { conversation: conversationId, subagent, parent: parentId, depth, mode, task: task.id },
		};
	});
}

/**
 * The child of the run `task` with the handles a phase needs. They are taken before the phase's commit: a read of a
 * conversation inside a commit waits for the commit itself.
 */
function drive(task: Running, api: Api): Effect.Effect<Driven, Failure> {
	return Effect.gen(function* () {
		const located = yield* locate(task, api);
		// Both conversations exist: the child was created with the task, and the task lives in the parent's.
		const handle = (id: ConversationId) => Effect.orDie(Effect.flatMap(api.conversation(id), Effect.fromOption));
		return {
			...located,
			conversation: yield* handle(located.child.conversationId),
			reportTo:
				located.child.mode === "background" ? Option.some(yield* handle(task.conversationId)) : Option.none(),
		};
	});
}

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

/** What a settled submission means for the run: the child ended, or it is asked again. */
type Verdict =
	| { readonly _tag: "Ended"; readonly state: Child.Ended; readonly answer: Option.Option<EntryRecord> }
	| { readonly _tag: "Correct"; readonly message: string };

/** Reads the answer of `settled`, in the commit that acts on it, and checks it against a declared result. */
function judge(
	tx: Tx.Tx,
	entry: Declared.Entry,
	settled: SettledSubmissionRecord,
	attempt: number,
): Effect.Effect<Verdict, DurableError> {
	const ended = (state: Child.Ended, answer: Option.Option<EntryRecord>): Verdict => ({
		_tag: "Ended",
		state,
		answer,
	});
	return Option.match(Outcome.answered(settled), {
		onNone: () => Effect.succeed(ended(Outcome.unanswered(settled), Option.none())),
		onSome: (id) =>
			Effect.flatMap(tx.entry(id), (answer) =>
				Option.match(entry.typed, {
					onNone: () => Effect.succeed(ended({ _tag: "Answered", answer: id }, answer)),
					onSome: (typed) =>
						Effect.match(typed.decode(Outcome.textOf(answer)), {
							onSuccess: (result) => ended({ _tag: "Typed", answer: id, result }, answer),
							onFailure: (mismatch): Verdict =>
								attempt < entry.corrections
									? { _tag: "Correct", message: Result.correction(mismatch) }
									: ended(
											{
												_tag: "Failed",
												reason: "invalid_result",
												message: `${mismatch.message}, after ${entry.corrections} corrections.`,
												answer: id,
											},
											answer,
										),
						}),
				}),
			),
	});
}

/**
 * Ends the run in the commit of `tx`: the child's document gets `state`, and the parent of a background child gets
 * the result as an input, Pi's way of telling a conversation something later (example 22). It starts a turn when the
 * parent is idle and follows its current answer otherwise; `onAbort: "keep"` keeps it through a Stop of the parent,
 * since nobody can send it again. All of it is stored with the task's end, or not at all.
 */
function finish(
	tx: Tx.Tx,
	driven: Driven,
	answer: Option.Option<EntryRecord>,
	state: Child.Ended,
): Effect.Effect<Task.End<null>, Failure> {
	return Effect.gen(function* () {
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
}

/** Writes how the child ended to its document. */
function record(tx: Tx.Tx, located: Located, state: Child.Ended): Effect.Effect<void, Failure> {
	return Effect.flatMap(tx.doc(Child.Document, Child.key(located.child.conversationId), located.link), (document) =>
		document.update((current) => ({ ...current, state })),
	);
}
