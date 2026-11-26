// The tools a parent's model delegates with: one that waits for the child, one that does not, and a status.

import type { ConversationId, ToolRegistration } from "@earendil-works/pi-durable";
import {
	type DurableError,
	type SchemaConversionError,
	type SchemaDecodeError,
	Task,
	Tool,
} from "@effectified/pi-durable";
import { Effect, Option, Schema } from "effect";
import * as Child from "./child.ts";
import type * as Declared from "./declared.ts";
import type { ChildSetupFailed, DepthExceeded, TooManyChildren, UnknownSubagent } from "./errors.ts";
import * as Outcome from "./outcome.ts";
import type * as Run from "./run.ts";
import * as Start from "./start.ts";

/** The names of the tools, as a parent's agent lists them and a guard grants them. */
export const NAMES = { foreground: "subagent", background: "subagent_start", status: "subagent_status" } as const;

/** What the model passes to start a subagent. */
const Delegation = Schema.Struct({
	subagent: Schema.String.annotate({ description: "The name of the subagent, one of those the tool lists." }),
	task: Schema.String.annotate({
		description: "What the subagent must do. It sees nothing of this conversation: say everything it needs.",
	}),
});

/** What the model passes to read a background subagent. */
const Handle = Schema.Struct({
	handle: Schema.String.annotate({ description: `The handle ${NAMES.background} gave.` }),
});

/**
 * The three tools over `config`, whose children are driven by `run`. Each is `replay: "safe"`: a call cut off by a
 * crash runs again and finds the child it already started. They are registered only once `declared` is ready, so a
 * registry with a declaration that cannot work does not build. Every result about a child names its conversation in
 * the details, which the model never reads: `{ conversationId, handle, subagent, mode, status }`, with `result` for a
 * typed result and `reason` for a failure.
 */
export function make(
	config: Declared.Config,
	declared: Effect.Effect<Declared.Declared, SchemaConversionError>,
	run: Run.Run,
) {
	const subagents = config.subagents.map((subagent) => `- ${subagent.name}: ${subagent.description}`).join("\n");
	const delegate = (mode: Child.Mode, request: typeof Delegation.Type, api: Tool.Api) =>
		Effect.flatMap(declared, (ready) => Start.start(api, ready, run, { ...request, mode }));
	const foreground = Tool.make(NAMES.foreground, {
		description:
			"Delegate a self-contained task to a subagent and wait for its result. The subagent starts fresh, with " +
			`its own tools and instructions. Subagents:\n${subagents}`,
		parameters: Delegation,
		success: Schema.String,
		replay: "safe",
		handler: (request, api) =>
			Effect.gen(function* () {
				const { conversationId, task } = yield* delegate("foreground", request, api);
				// Woken by the end of the run it waited for: the child's document says how it ended.
				if (Option.isSome(api.wake)) return yield* read(api, Child.key(conversationId));
				yield* api.details(detailsOf(conversationId, request.subagent, "foreground", { status: "running" }));
				// The call holds no process while the child works, and a restart leaves it parked (spec 7.3).
				return Tool.wait({ on: [task], policy: "allSettled" });
			}).pipe(Effect.catchTags(REFUSALS)),
	});
	const background = Tool.make(NAMES.background, {
		description:
			"Start a subagent on a self-contained task in the background and go on at once. You get a handle. The " +
			`result is sent to you as a message when it is ready, and ${NAMES.status} reads it by the handle. ` +
			`Subagents:\n${subagents}`,
		parameters: Delegation,
		success: Schema.String,
		replay: "safe",
		handler: (request, api) =>
			Effect.map(delegate("background", request, api), ({ conversationId }) =>
				Tool.result(
					`Started subagent ${request.subagent} in the background. Handle: ${Child.key(conversationId)}. ` +
						`Its result will be sent to you; ${NAMES.status} reads it meanwhile.`,
					{ details: detailsOf(conversationId, request.subagent, "background", { status: "running" }) },
				),
			).pipe(Effect.catchTags(REFUSALS)),
	});
	const status = Tool.make(NAMES.status, {
		description:
			`Read what became of a subagent started with ${NAMES.background}, by its handle: still working, its ` +
			"result, or why it failed.",
		parameters: Handle,
		success: Schema.String,
		replay: "safe",
		handler: ({ handle }, api) => read(api, handle),
	});
	return [checked(declared, foreground), checked(declared, background), checked(declared, status)] as const;
}

/** What a registry installs of a tool: its name, and how it is built. */
export interface Installable<Name extends string, R> {
	readonly name: Name;
	readonly registration: Effect.Effect<ToolRegistration, SchemaConversionError, R>;
}

/** `tool`, built only once the declarations are ready: their failure is the registry's. */
function checked<Name extends string, R>(
	declared: Effect.Effect<Declared.Declared, SchemaConversionError>,
	tool: Installable<Name, R>,
): Installable<Name, R> {
	return { name: tool.name, registration: Effect.andThen(declared, tool.registration) };
}

/** A refusal to start a child, as an error result: no child exists, so the details name no conversation. */
function refusal(reason: Start.Refusal["_tag"], text: string): Effect.Effect<Tool.Reply<never>> {
	return Effect.succeed(Tool.error(text, { details: { status: "refused", reason } }));
}

/** Each refusal in words the parent's model can act on. */
const REFUSALS = {
	UnknownSubagent: (refused: UnknownSubagent) => refusal(refused._tag, refused.message),
	DepthExceeded: (refused: DepthExceeded) => refusal(refused._tag, refused.message),
	TooManyChildren: (refused: TooManyChildren) => refusal(refused._tag, refused.message),
	ChildSetupFailed: (refused: ChildSetupFailed) => refusal(refused._tag, refused.message),
};

/** How far a child is, as the details say it. */
type Progress =
	| { readonly status: "running" }
	| { readonly status: "answered" }
	| { readonly status: "answered"; readonly result: Schema.Json }
	| { readonly status: "failed"; readonly reason: string };

/** The details of a tool result about a child: what a host opens the child by, and how far it is. */
function detailsOf(
	conversationId: ConversationId,
	subagent: string,
	mode: Child.Mode,
	progress: Progress,
): Schema.Json {
	return { conversationId, handle: Child.key(conversationId), subagent, mode, ...progress };
}

/** How a child ended, as the details say it. */
function progressOf(state: Child.Ended): Progress {
	switch (state._tag) {
		case "Answered":
			return { status: "answered" };
		case "Typed":
			return { status: "answered", result: state.result };
		case "Failed":
			return { status: "failed", reason: state.reason };
	}
}

/**
 * What became of the child with `handle`, as a tool result: its answer, a typed result as JSON text, an error result
 * that says why it failed, or that it is still working. A handle that is no child of the asking conversation is an
 * error result: a model reads only its own children.
 */
function read(api: Tool.Api, handle: string): Effect.Effect<Tool.Reply<string>, DurableError | SchemaDecodeError> {
	return Effect.gen(function* () {
		const found = yield* api.snapshot(Child.Document, handle);
		if (Option.isNone(found) || found.value.parent !== api.conversationId) {
			return Tool.error(`No subagent of yours has the handle ${handle}.`, { details: { status: "unknown" } });
		}
		const { conversation: conversationId, subagent, mode, state, task } = found.value;
		if (state._tag === "Running") {
			const ended = Option.match(yield* api.getTask(task), {
				onNone: () => true,
				onSome: (record) => Task.ended(record.state.status),
			});
			// A run that ended and left `Running` never got to write: Pi faulted or orphaned it.
			return ended
				? Tool.error(`Subagent ${subagent} ended without recording a result.`, {
						details: detailsOf(conversationId, subagent, mode, { status: "failed", reason: "no_result" }),
					})
				: Tool.result(`Subagent ${subagent} (handle ${handle}) is still working.`, {
						details: detailsOf(conversationId, subagent, mode, { status: "running" }),
					});
		}
		const answer = yield* Option.match(Outcome.answerOf(state), {
			onNone: () => Effect.succeedNone,
			// Any entry by id, read in a commit without writes.
			onSome: (id) => api.commit((tx) => tx.entry(id)),
		});
		const { isError, text } = Outcome.reading(state, answer);
		const details = detailsOf(conversationId, subagent, mode, progressOf(state));
		return isError ? Tool.error(text, { details }) : Tool.result(text, { details });
	});
}
