// Starting a child: the limits, and the one commit that creates its run task, its conversation and its documents.

import type { DurableError, SchemaDecodeError, TaskOptions, Tool } from "@effectified/pi-durable";
import { Effect, Match, Option, Schema } from "effect";
import * as Child from "./child.ts";
import * as ChildSetup from "./child-setup.ts";
import * as Declared from "./declared.ts";
import { type ChildSetupFailed, DepthExceeded, TooManyChildren, type UnknownSubagent } from "./errors.ts";
import * as Live from "./live.ts";
import * as Run from "./run.ts";
import * as Started from "./started.ts";
import * as Subagent from "./subagent.ts";

/** What a tool call asks for: the subagent by its name, the task for it, and whether the call waits for it. */
export const Request = Schema.Struct({ subagent: Subagent.Name, task: Schema.String, mode: Child.Mode });

/** What a tool call asks for. */
export type Request = typeof Request.Type;

/** Why no child was started: each is an error result for the parent's model, never a failed call. */
export type Refusal = UnknownSubagent | DepthExceeded | TooManyChildren | ChildSetupFailed;

/**
 * The child of the tool call `api` belongs to: the one it already started, or a new one. A call runs again after a
 * crash and after every park, so the commit that creates a child records it under the call's task, and a later run
 * reads that first.
 *
 * A new child is made in one commit of the call: its run task, its conversation owned by that task, the declared
 * agent, the product's setup, and its documents. Any failure, a limit and the product's refusal included, stores
 * nothing. The limits are counted from what Pi stores, so a restart resets neither:
 *
 * - **Depth** from the asking conversation's own `subagent.child` document: one more than its depth, 1 when it has
 *   none.
 * - **Live children** from Pi's task table: the tasks of kind `subagent.run` in the asking conversation that Pi has
 *   not settled, `completing` ones included (`Live.LIVE`), read in the creating commit. Commits run one at a time, so
 *   two calls of one round cannot both pass.
 */
export const start: (
	api: Tool.Api,
	declared: Declared.Declared,
	run: Run.Run,
	request: Request,
) => Effect.Effect<Started.Started, Refusal | DurableError | SchemaDecodeError, ChildSetup.ChildSetup> = Effect.fn(
	"Subagents.start",
)(function* (api: Tool.Api, declared: Declared.Declared, run: Run.Run, request: Request) {
	const document = yield* api.snapshot(Started.Document, api.taskId);
	const kept = Option.flatMap(document, (value) => Option.fromNullOr(value.started));
	if (Option.isSome(kept)) return kept.value;
	const { subagent } = yield* Declared.find(declared, request.subagent);
	const { maxDepth, maxLive } = declared.config;
	// A conversation's depth never changes, so it is read before the commit, which could only create the document.
	const own = yield* api.snapshot(Child.Document, Child.key(api.conversationId));
	const depth = Option.match(own, { onNone: () => 0, onSome: (record) => record.depth }) + 1;
	if (depth > maxDepth) return yield* DepthExceeded.make({ depth: depth - 1, maxDepth });
	const setup = yield* ChildSetup.ChildSetup;
	return yield* api.commit((tx) =>
		Effect.gen(function* () {
			const live = yield* Live.countLive(tx, api.conversationId, Run.NAME, maxLive);
			if (live >= maxLive) return yield* TooManyChildren.make({ live, maxLive });
			const input = { subagent: subagent.name, task: request.task, mode: request.mode, depth };
			const task = yield* tx.createTask(run, input, ownership(api, request.mode));
			const { id: conversationId } = yield* tx.createConversation({ ownership: { kind: "task", taskId: task } });
			yield* tx.configure(conversationId, Subagent.exactly(subagent.agent));
			// After the declared agent, so what the product grants or narrows is what holds.
			yield* setup.created(
				tx,
				ChildSetup.Child.make({
					conversationId,
					parentId: api.conversationId,
					subagent: subagent.name,
					mode: request.mode,
					depth,
				}),
			);
			yield* tx.doc(Child.Document, Child.key(conversationId), {
				conversation: conversationId,
				subagent: subagent.name,
				parent: api.conversationId,
				depth,
				mode: request.mode,
				task,
			});
			const started = Started.Started.make({ conversationId, task });
			// Under the call, for its next run; under the run, which was created before its conversation.
			yield* Effect.forEach(
				[api.taskId, task],
				(owner) => Effect.flatMap(tx.doc(Started.Document, owner), (written) => written.set({ started })),
				{ concurrency: 1, discard: true },
			);
			return started;
		}),
	);
});

/**
 * Who owns the run, which decides what an abort of the parent reaches (spec 5.4): a foreground run is a child of the
 * tool call, so the cascade reaches it; a background run belongs to the conversation as a background task, which is
 * a boundary the cascade and the parent's idle wait stop at.
 */
function ownership(api: Tool.Api, mode: Child.Mode): TaskOptions {
	return Match.value(mode).pipe(
		Match.when("foreground", (): TaskOptions => ({ ownership: { kind: "task", taskId: api.taskId } })),
		Match.when("background", (): TaskOptions => ({ ownership: { kind: "conversation" }, background: true })),
		Match.exhaustive,
	);
}
