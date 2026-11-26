import type { ConversationId } from "@earendil-works/pi-durable";
import { Harness } from "@effectified/pi-durable";
import { answer, held, toolCall } from "@effectified/pi-durable/testing";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { Subagents } from "../src/index.ts";
import {
	childOf,
	children,
	conversation,
	entriesOf,
	harness,
	PARENT,
	parent,
	routed,
	said,
	toolResults,
	worker,
} from "./scene.ts";

const config: Subagents.Config = { subagents: [worker("researcher")], maxDepth: 1, maxLive: 2 };
const { foreground, background, status } = Subagents.TOOLS;

describe("the tools as the model sees them", () => {
	it("are three, each naming the declared subagents it can start", async () => {
		const { layer } = harness({ config, responses: [] });
		const seen = await Effect.runPromise(
			Effect.map(
				Effect.flatMap(parent, (root) => root.agent),
				(agent) =>
					agent.tools
						.filter((tool) => tool.name.startsWith("subagent"))
						.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
			).pipe(Effect.provide(layer)),
		);
		const delegation = {
			type: "object",
			properties: {
				subagent: { type: "string", description: "The name of the subagent, one of those the tool lists." },
				task: {
					type: "string",
					description: "What the subagent must do. It sees nothing of this conversation: say everything it needs.",
				},
			},
			required: ["subagent", "task"],
			additionalProperties: false,
		};
		expect(seen).toEqual([
			{
				name: "subagent",
				description:
					"Delegate a self-contained task to a subagent and wait for its result. The subagent starts fresh, with " +
					"its own tools and instructions. Subagents:\n- researcher: Does researcher work.",
				parameters: delegation,
			},
			{
				name: "subagent_start",
				description:
					"Start a subagent on a self-contained task in the background and go on at once. You get a handle. The " +
					"result is sent to you as a message when it is ready, and subagent_status reads it by the handle. " +
					"Subagents:\n- researcher: Does researcher work.",
				parameters: delegation,
			},
			{
				name: "subagent_status",
				description:
					"Read what became of a subagent started with subagent_start, by its handle: still working, its result, " +
					"or why it failed.",
				parameters: {
					type: "object",
					properties: { handle: { type: "string", description: "The handle subagent_start gave." } },
					required: ["handle"],
					additionalProperties: false,
				},
			},
		]);
	});
});

describe("the foreground tool", () => {
	it("creates the child, gives it the task, and returns its answer with the child's conversation in the details", async () => {
		const asked: string[] = [];
		const { layer } = harness({
			config,
			responses: routed(
				{
					parent: [
						toolCall(foreground, { subagent: "researcher", task: "What is six times seven?" }),
						answer("The researcher says forty-two."),
					],
					child: [answer("Forty-two.")],
				},
				asked,
			),
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* parent;
				const settled = yield* root.prompt("Ask the researcher.");
				yield* root.waitForIdle;
				const [child, ...others] = yield* children;
				const id = child?.id as ConversationId;
				const ofRoot = yield* entriesOf(root);
				return {
					settled: settled.status,
					others: others.length,
					id,
					owner: child?.owner,
					record: yield* childOf(id),
					kinds: ofRoot.map((entry) => entry.kind),
					results: toolResults(ofRoot),
					child: said(yield* entriesOf(yield* conversation(id))),
				};
			}).pipe(Effect.provide(layer)),
		);
		const { id, record } = seen;
		expect(seen.settled).toBe("done");
		expect(seen.others).toBe(0);
		// Pi's own link: the child is owned by its run task, which lives in the parent's conversation.
		expect(seen.owner).toEqual({ conversationId: 1, taskId: record.task });
		expect(record).toEqual({
			conversation: id,
			subagent: "researcher",
			parent: 1,
			depth: 1,
			mode: "foreground",
			task: record.task,
			state: { _tag: "Answered", answer: record.state._tag === "Answered" ? record.state.answer : undefined },
		});
		expect(seen.kinds).toEqual(["pi.user", "pi.system", "pi.assistant", "pi.tool-result", "pi.assistant"]);
		expect(seen.results).toEqual([
			{
				tool: "subagent",
				isError: false,
				text: "Forty-two.",
				details: {
					conversationId: id,
					handle: String(id),
					subagent: "researcher",
					mode: "foreground",
					status: "answered",
				},
			},
		]);
		expect(seen.child).toEqual(["user: What is six times seven?", "assistant: Forty-two."]);
		expect(asked).toEqual(["parent", "child", "parent"]);
	});

	it("holds no process while the child works: the call waits on the child's run, which sleeps on the settlement", async () => {
		const thinking = held(answer("Done."));
		const { layer } = harness({
			config,
			responses: routed({
				parent: [toolCall(foreground, { subagent: "researcher", task: "Think." }), answer("It is done.")],
				child: [thinking.response],
			}),
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* parent;
				const submission = yield* root.submit({ type: "input", content: "Go." });
				yield* thinking.requested;
				const [child] = yield* children;
				const run = Option.getOrThrow(yield* Harness.getTask((yield* childOf(child?.id as ConversationId)).task));
				const call = Option.getOrThrow(yield* Harness.getTask(run.owner as NonNullable<typeof run.owner>));
				const during = {
					run: { kind: run.kind, background: run.background, state: run.state },
					call: { kind: call.kind, state: call.state },
				};
				yield* thinking.release;
				const settled = yield* submission.wait;
				yield* root.waitForIdle;
				return { during, settled: settled.status, results: toolResults(yield* entriesOf(root)), run: run.id };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen.during.run).toMatchObject({
			kind: "subagent.run",
			background: false,
			state: {
				status: "sleeping",
				checkpoint: { phase: "settle", attempt: 0 },
				signals: [{ signal: "pi.submission-settled", key: "settled:0" }],
			},
		});
		expect(seen.during.call).toMatchObject({
			kind: "pi.tool",
			state: { status: "waiting", on: [seen.run], policy: "allSettled" },
		});
		expect(seen.settled).toBe("done");
		expect(seen.results.map((result) => result.text)).toEqual(["Done."]);
	});
});

describe("the background tools", () => {
	it("start returns at once with a handle, and the result arrives in the parent as an input once the child is done", async () => {
		const asked: string[] = [];
		const working = held(answer("Paris."));
		const { layer } = harness({
			config,
			responses: routed(
				{
					parent: [
						toolCall(background, { subagent: "researcher", task: "Name the capital of France." }),
						answer("I asked the researcher."),
						answer("The researcher found: Paris."),
					],
					child: [working.response],
				},
				asked,
			),
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* parent;
				// The parent's run ends with its own answer while the child is still in its model request.
				const first = yield* root.prompt("Find the capital, in the background.");
				yield* root.waitForIdle;
				yield* working.requested;
				const [child] = yield* children;
				const id = child?.id as ConversationId;
				const before = { record: yield* childOf(id), results: toolResults(yield* entriesOf(root)) };
				const run = Option.getOrThrow(yield* Harness.getTask(before.record.task));
				yield* working.release;
				yield* Harness.waitForTask(run.id);
				yield* root.waitForIdle;
				const ofRoot = yield* entriesOf(root);
				return {
					first: first.status,
					id,
					before,
					run: { owner: run.owner, background: run.background },
					after: yield* childOf(id),
					kinds: ofRoot.map((entry) => entry.kind),
					report: ofRoot.find((entry) => entry.kind === "subagent.report"),
					said: said(ofRoot),
				};
			}).pipe(Effect.provide(layer)),
		);
		const { id } = seen;
		expect(seen.first).toBe("done");
		expect(seen.before.record.state).toEqual({ _tag: "Running" });
		expect(seen.before.results).toEqual([
			{
				tool: "subagent_start",
				isError: false,
				text: `Started subagent researcher in the background. Handle: ${id}. Its result will be sent to you; subagent_status reads it meanwhile.`,
				details: {
					conversationId: id,
					handle: String(id),
					subagent: "researcher",
					mode: "background",
					status: "running",
				},
			},
		]);
		// A conversation-owned background task: Pi's abort and idle traversal stop at it.
		expect(seen.run).toEqual({ owner: undefined, background: true });
		expect(seen.after.state._tag).toBe("Answered");
		expect(seen.kinds).toEqual([
			"pi.user",
			"pi.system",
			"pi.assistant",
			"pi.tool-result",
			"pi.assistant",
			"subagent.report",
			"pi.assistant",
		]);
		expect(seen.report?.data).toEqual({
			handle: String(id),
			conversationId: id,
			subagent: "researcher",
			isError: false,
		});
		expect(seen.said).toEqual([
			"user: Find the capital, in the background.",
			"assistant: I asked the researcher.",
			`user: [subagent researcher, handle ${id}, finished]\nParis.`,
			"assistant: The researcher found: Paris.",
		]);
		// The parent is asked twice for its own run, and once more for the report.
		expect(asked).toEqual(["parent", "child", "parent", "parent"]);
	});

	it("status reads a child by its handle: still working, then its result, and nothing of a handle that is not its own", async () => {
		const working = held(answer("Paris."));
		const calls = (handle: string, id: string) => toolCall(status, { handle }, { id });
		let handle = "";
		const { layer } = harness({
			config,
			responses: routed({
				parent: [
					toolCall(background, { subagent: "researcher", task: "Name the capital of France." }),
					(context) => {
						// The handle is what the model read in the result of its call.
						const result = context.messages.findLast((message) => message.role === "toolResult");
						const text = result?.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
						handle = /Handle: (\d+)\./.exec(text ?? "")?.[1] ?? "";
						return calls(handle, "status-1");
					},
					answer("Still waiting."),
					answer("Noted."),
					() => calls(handle, "status-2"),
					calls("1", "status-3"),
					calls("nonsense", "status-4"),
					answer("Paris it is."),
				],
				child: [working.response],
			}),
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* parent;
				yield* root.prompt("Find the capital, in the background, and check on it.");
				yield* root.waitForIdle;
				yield* working.release;
				const [child] = yield* children;
				yield* Harness.waitForTask((yield* childOf(child?.id as ConversationId)).task);
				yield* root.waitForIdle;
				yield* root.prompt("Check again.");
				yield* root.waitForIdle;
				return { id: child?.id, results: toolResults(yield* entriesOf(root)).slice(1) };
			}).pipe(Effect.provide(layer)),
		);
		const details = {
			conversationId: seen.id,
			handle: String(seen.id),
			subagent: "researcher",
			mode: "background",
		};
		expect(handle).toBe(String(seen.id));
		expect(seen.results).toEqual([
			{
				tool: "subagent_status",
				isError: false,
				text: `Subagent researcher (handle ${handle}) is still working.`,
				details: { ...details, status: "running" },
			},
			{ tool: "subagent_status", isError: false, text: "Paris.", details: { ...details, status: "answered" } },
			{
				tool: "subagent_status",
				isError: true,
				text: "No subagent of yours has the handle 1.",
				details: { status: "unknown" },
			},
			{
				tool: "subagent_status",
				isError: true,
				text: "No subagent of yours has the handle nonsense.",
				details: { status: "unknown" },
			},
		]);
	});

	it("never shows a model the child of another conversation", async () => {
		const { layer } = harness({
			config,
			responses: routed({
				parent: [
					toolCall(background, { subagent: "researcher", task: "Work." }),
					answer("Started."),
					answer("Noted."),
					(context) => {
						const said = JSON.stringify(context.messages.findLast((message) => message.role === "user")?.content);
						return toolCall(status, { handle: /handle (\d+)/.exec(said)?.[1] ?? "" });
					},
					answer("Nothing."),
				],
				child: [answer("Done.")],
			}),
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* parent;
				yield* root.prompt("Start one.");
				const [child] = yield* children;
				const id = child?.id as ConversationId;
				yield* Harness.waitForTask((yield* childOf(id)).task);
				yield* root.waitForIdle;
				const other = yield* Harness.createConversation({
					ownership: { kind: "ownerless" },
					agent: { model: PARENT, tools: [status] },
				});
				yield* other.prompt(`Read handle ${id}.`);
				yield* other.waitForIdle;
				return { id, results: toolResults(yield* entriesOf(other)) };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen.results).toEqual([
			{
				tool: "subagent_status",
				isError: true,
				text: `No subagent of yours has the handle ${seen.id}.`,
				details: { status: "unknown" },
			},
		]);
	});
});
