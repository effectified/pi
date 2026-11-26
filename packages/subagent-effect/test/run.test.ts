import type { ConversationId } from "@earendil-works/pi-durable";
import { Harness } from "@effectified/pi-durable";
import { answer, fauxAssistantMessage, held, toolCall } from "@effectified/pi-durable/testing";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { Subagents } from "../src/index.ts";
import {
	childOf,
	children,
	conversation,
	entriesOf,
	harness,
	parent,
	routed,
	said,
	type ToolResult,
	toolResults,
	worker,
} from "./scene.ts";

const config: Subagents.Config = { subagents: [worker("researcher")], maxDepth: 1, maxLive: 2 };
const { foreground, background, status } = Subagents.TOOLS;

/** The outcome of the run task of the child `id`. */
const outcomeOf = (id: ConversationId) =>
	Effect.gen(function* () {
		const run = Option.getOrThrow(yield* Harness.getTask((yield* childOf(id)).task));
		return run.state.status === "terminal" ? run.state.outcome.status : run.state.status;
	});

describe("an abort of the parent", () => {
	it("stops an attached child: the foreground child's request is aborted and it never answers", async () => {
		const asked: string[] = [];
		const thinking = held(answer("Too late."));
		const { layer } = harness({
			config,
			responses: routed(
				{
					parent: [toolCall(foreground, { subagent: "researcher", task: "Think long." }), answer("Unused.")],
					child: [thinking.response],
				},
				asked,
			),
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* parent;
				const submission = yield* root.submit({ type: "input", content: "Delegate." });
				yield* thinking.requested;
				const [child] = yield* children;
				const id = child?.id as ConversationId;
				const before = yield* outcomeOf(id);
				// Pi's `Conversation.abort`: it resolves once the conversation is idle, the work it owns included.
				yield* root.abort();
				const inspection = yield* Harness.inspect;
				return {
					before,
					settled: yield* submission.wait,
					record: yield* childOf(id),
					run: yield* outcomeOf(id),
					child: said(yield* entriesOf(yield* conversation(id))),
					results: toolResults(yield* entriesOf(root)),
					live: inspection.tasks.length,
				};
			}).pipe(Effect.provide(layer)),
		);
		expect(seen.before).toBe("sleeping");
		expect(seen.settled).toMatchObject({ status: "unanswered", reason: "aborted" });
		expect(seen.record.state).toEqual({
			_tag: "Failed",
			reason: "aborted",
			message: "The subagent was stopped before it answered.",
			answer: null,
		});
		expect(seen.run).toBe("aborted");
		// The child has its task and no answer; nothing of it is still live, and its model is not asked again.
		expect(seen.child).toEqual(["user: Think long."]);
		// Pi's own result for an aborted call, with the details the call last showed.
		expect(seen.results).toMatchObject([
			{ tool: "subagent", isError: true, details: { conversationId: seen.record.conversation, status: "running" } },
		]);
		expect(seen.results[0]?.text).toContain("Tool subagent was aborted");
		expect(seen.live).toBe(0);
		expect(asked).toEqual(["parent", "child"]);
	});

	it("does not reach a background child: it finishes, tells the parent, and its result stays readable", async () => {
		const asked: string[] = [];
		const working = held(answer("Paris."));
		const busy = held(answer("Unused."));
		const { layer } = harness({
			config,
			responses: routed(
				{
					parent: [
						toolCall(background, { subagent: "researcher", task: "Name the capital of France." }),
						busy.response,
						answer("Noted."),
						(context) => {
							const report = JSON.stringify(
								context.messages.findLast((message) => message.role === "user")?.content,
							);
							return toolCall(status, { handle: /handle (\d+)/.exec(report)?.[1] ?? "" });
						},
						answer("It was Paris."),
					],
					child: [working.response],
				},
				asked,
			),
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* parent;
				const submission = yield* root.submit({ type: "input", content: "Start it and keep working." });
				// Both are in the middle of a model request: the parent in its own run, the child in its task.
				yield* busy.requested;
				yield* working.requested;
				const [child] = yield* children;
				const id = child?.id as ConversationId;
				yield* root.abort();
				const stopped = { settled: yield* submission.wait, record: yield* childOf(id), run: yield* outcomeOf(id) };
				yield* working.release;
				yield* Harness.waitForTask(stopped.record.task);
				yield* root.waitForIdle;
				const finished = {
					record: yield* childOf(id),
					run: yield* outcomeOf(id),
					child: said(yield* entriesOf(yield* conversation(id))),
					parent: said(yield* entriesOf(root)),
				};
				yield* root.prompt(`Read handle ${id}.`);
				yield* root.waitForIdle;
				return { id, stopped, finished, results: toolResults(yield* entriesOf(root)).slice(1) };
			}).pipe(Effect.provide(layer)),
		);
		const { id } = seen;
		// The parent's run is stopped; the child is untouched and still asleep on its submission.
		expect(seen.stopped.settled).toMatchObject({ status: "unanswered", reason: "aborted" });
		expect(seen.stopped.record.state).toEqual({ _tag: "Running" });
		expect(seen.stopped.run).toBe("sleeping");
		expect(seen.finished.record.state._tag).toBe("Answered");
		expect(seen.finished.run).toBe("completed");
		expect(seen.finished.child).toEqual(["user: Name the capital of France.", "assistant: Paris."]);
		// The report arrives after the Stop and starts a turn of its own, as Pi's example 22 says of its reports.
		expect(seen.finished.parent).toEqual([
			"user: Start it and keep working.",
			`user: [subagent researcher, handle ${id}, finished]\nParis.`,
			"assistant: Noted.",
		]);
		expect(seen.results).toEqual([
			{
				tool: "subagent_status",
				isError: false,
				text: "Paris.",
				details: {
					conversationId: id,
					handle: String(id),
					subagent: "researcher",
					mode: "background",
					status: "answered",
				},
			},
		]);
		// The parent: its call, the request the Stop cut, the report's turn, and two for the status. The child: once.
		expect(asked.toSorted()).toEqual(["child", "parent", "parent", "parent", "parent", "parent"]);
	});

	it("reaches a background child too when the host asks for it with `background: true`", async () => {
		const working = held(answer("Too late."));
		const { layer } = harness({
			config,
			responses: routed({
				parent: [toolCall(background, { subagent: "researcher", task: "Work." }), answer("Started.")],
				child: [working.response],
			}),
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* parent;
				yield* root.prompt("Start it.");
				yield* working.requested;
				const [child] = yield* children;
				const id = child?.id as ConversationId;
				yield* root.abort({ background: true });
				return { record: yield* childOf(id), run: yield* outcomeOf(id), kinds: (yield* entriesOf(root)).length };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen.record.state).toMatchObject({ _tag: "Failed", reason: "aborted" });
		expect(seen.run).toBe("aborted");
		// No report: nobody is told about work the host stopped. The parent's own run is all there is.
		expect(seen.kinds).toBe(5);
	});
});

describe("a child that fails", () => {
	/** One foreground delegation whose child is scripted with `child`, and what the parent's model read. */
	const delegate = (options: {
		readonly subagent?: ReturnType<typeof worker>;
		readonly child: Parameters<typeof routed>[0]["child"];
		readonly during?: (id: ConversationId) => Effect.Effect<void, unknown, Harness.Harness>;
		readonly started?: Effect.Effect<void>;
	}) => {
		const { layer } = harness({
			config: { subagents: [options.subagent ?? worker("researcher")], maxDepth: 1, maxLive: 1 },
			// A failed request ends the run at once: Pi's retries are for another test.
			settings: { retry: { enabled: false } },
			responses: routed({
				parent: [toolCall(foreground, { subagent: "researcher", task: "Work." }), answer("I could not get it.")],
				child: options.child,
			}),
		});
		return Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* parent;
				const submission = yield* root.submit({ type: "input", content: "Delegate." });
				if (options.started !== undefined && options.during !== undefined) {
					yield* options.started;
					const [child] = yield* children;
					yield* options.during(child?.id as ConversationId);
				}
				const settled = yield* submission.wait;
				yield* root.waitForIdle;
				const [child] = yield* children;
				const id = child?.id as ConversationId;
				const [result] = toolResults(yield* entriesOf(root));
				return { id, settled: settled.status, result: result as ToolResult, run: yield* outcomeOf(id) };
			}).pipe(Effect.provide(layer)),
		);
	};
	const failed = (id: ConversationId, reason: string) => ({
		conversationId: id,
		handle: String(id),
		subagent: "researcher",
		mode: "foreground",
		status: "failed",
		reason,
	});

	it("gives an error result for a model error, with the provider's text, and the parent's run goes on", async () => {
		const seen = await delegate({
			child: [fauxAssistantMessage("", { stopReason: "error", errorMessage: "Budget: the lease is fenced" })],
		});
		expect(seen.result).toEqual({
			tool: "subagent",
			isError: true,
			text: "The subagent's model request failed: Budget: the lease is fenced. Its work so far is lost to you: decide whether to try again.",
			details: failed(seen.id, "model_error"),
		});
		// The run task itself completed: a failed child is a result, never a failed task.
		expect(seen.run).toBe("completed");
		expect(seen.settled).toBe("done");
	});

	it("gives an error result when the child reaches its turn limit", async () => {
		const seen = await delegate({
			subagent: worker("researcher", {
				agent: { model: { provider: "faux", modelId: "child" }, tools: ["c"], maxTurns: 1 },
			}),
			child: [toolCall("c", { text: "one" })],
		});
		expect(seen.result).toEqual({
			tool: "subagent",
			isError: true,
			text: "The subagent used up its turns (1 turn) without a final answer. Give it a smaller task.",
			details: failed(seen.id, "turn_limit"),
		});
		expect(seen.settled).toBe("done");
	});

	it("gives an error result when the child itself is stopped, and the parent's run goes on", async () => {
		const thinking = held(answer("Too late."));
		const seen = await delegate({
			child: [thinking.response],
			started: thinking.requested,
			during: (id) => Effect.flatMap(conversation(id), (child) => child.abort()),
		});
		expect(seen.result).toEqual({
			tool: "subagent",
			isError: true,
			text: "The subagent was stopped before it answered.",
			details: failed(seen.id, "aborted"),
		});
		expect(seen.run).toBe("completed");
		expect(seen.settled).toBe("done");
	});
});
