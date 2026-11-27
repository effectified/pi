import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { runTest } from "@effectified/pi-ai/testing";
import { Context, Effect, Latch, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Tool, ToolFailed } from "../src/index.ts";

class Records extends Context.Service<Records, { readonly title: (id: string) => Effect.Effect<string> }>()(
	"test/Records",
) {}

const Lookup = Tool.make("lookup", {
	label: "Lookup",
	description: "Look a record up by id.",
	parameters: Schema.Struct({ id: Schema.String, since: Schema.optional(Schema.Date) }),
	success: Schema.Struct({ title: Schema.String }),
	handler: ({ id, since }) =>
		Effect.map(
			Records.use((records) => records.title(id)),
			(title) => ({ title: since === undefined ? title : `${title} since ${since.getUTCFullYear()}` }),
		),
});

const records = Context.make(Records, { title: (id) => Effect.succeed(`Record ${id}`) });

/** Builds `tool` with the records service and runs one call of it. */
function execute(tool: Tool.Any<Records>, args: unknown, signal?: AbortSignal) {
	return Effect.flatMap(Effect.provide(tool.agentTool, records), (agentTool) =>
		Effect.promise(() => agentTool.execute("call-1", args as never, signal)),
	);
}

describe("Tool.make", () => {
	it("builds Pi's tool: the JSON Schema of the parameters, the label, the settings passed on", async () => {
		const tool = await runTest(
			Tool.make("search", {
				label: "Search",
				description: "Search.",
				parameters: Schema.Struct({ query: Schema.String }),
				success: Schema.String,
				executionMode: "sequential",
				replay: "safe",
				constrainedSampling: false,
				handler: () => Effect.succeed("found"),
			}).agentTool,
		);
		expect(tool).toMatchObject({
			name: "search",
			label: "Search",
			description: "Search.",
			executionMode: "sequential",
			replay: "safe",
			constrainedSampling: false,
			parameters: { type: "object", required: ["query"], additionalProperties: false },
		});
		expect(tool.outputSchema).toBeUndefined();
	});

	it("builds the JSON Schemas once: every build of the tool shares them, as pi-ai's validator cache wants", async () => {
		const [first, second] = await runTest(
			Effect.all([Lookup.agentTool, Lookup.agentTool], { concurrency: 1 }).pipe(Effect.provide(records)),
		);
		expect(first.parameters).toBe(second.parameters);
		expect(Lookup.name).toBe("lookup");
	});

	it("gives the handler the call's id", async () => {
		const Id = Tool.make("id", {
			label: "Id",
			description: "Id.",
			parameters: Schema.Struct({}),
			success: Schema.String,
			handler: (_params, api) => Effect.succeed(api.toolCallId),
		});
		const result = await runTest(execute(Id, {}));
		expect(result.content).toEqual([{ type: "text", text: "call-1" }]);
	});

	it("decodes the arguments, runs the handler with its services and gives the model the result as JSON", async () => {
		const result = await runTest(execute(Lookup, { id: "42", since: "2026-11-24T00:00:00.000Z" }));
		expect(result).toEqual({ content: [{ type: "text", text: '{"title":"Record 42 since 2026"}' }] });
	});

	it("gives a string result to the model as it is", async () => {
		const Echo = Tool.make("echo", {
			label: "Echo",
			description: "Echo.",
			parameters: Schema.Struct({ text: Schema.String }),
			success: Schema.String,
			handler: ({ text }) => Effect.succeed(text),
		});
		const result = await runTest(execute(Echo, { text: "plain" }));
		expect(result.content).toEqual([{ type: "text", text: "plain" }]);
	});

	it("carries the value as structured content, declared by the JSON Schema of success", async () => {
		const Structured = Tool.make("structured", {
			label: "Structured",
			description: "Structured.",
			parameters: Schema.Struct({}),
			success: Schema.Struct({ at: Schema.Date }),
			structured: true,
			handler: () => Effect.succeed({ at: new Date("2026-11-24T00:00:00.000Z") }),
		});
		const tool = await runTest(Structured.agentTool);
		expect(tool.outputSchema).toMatchObject({ type: "object", required: ["at"] });
		const result = await runTest(execute(Structured, {}));
		expect(result.structuredContent).toEqual({ at: "2026-11-24T00:00:00.000Z" });
	});

	it("passes a reply's extras on: other content, details, usage and terminate", async () => {
		const Rich = Tool.make("rich", {
			label: "Rich",
			description: "Rich.",
			parameters: Schema.Struct({}),
			success: Schema.Number,
			handler: () =>
				Effect.succeed(
					Tool.result(3, { content: [{ type: "text", text: "three" }], details: { n: 3 }, terminate: true }),
				),
		});
		const result = await runTest(execute(Rich, {}));
		expect(result).toEqual({ content: [{ type: "text", text: "three" }], details: { n: 3 }, terminate: true });
	});

	it("returns an error result the handler decides, as Pi's isError", async () => {
		const Refuses = Tool.make("refuses", {
			label: "Refuses",
			description: "Refuses.",
			parameters: Schema.Struct({}),
			success: Schema.String,
			handler: () => Effect.succeed(Tool.error("not today", { details: { retry: true } })),
		});
		const result = await runTest(execute(Refuses, {}));
		expect(result).toEqual({
			content: [{ type: "text", text: "not today" }],
			details: { retry: true },
			isError: true,
		});
	});

	it("rejects with the message of a handler's failure, which Pi turns into its error result", async () => {
		class NotFound extends Schema.TaggedError<NotFound, { readonly brand: unique symbol }>()("NotFound", {
			id: Schema.String,
		}) {}
		const Fails = Tool.make("fails", {
			label: "Fails",
			description: "Fails.",
			parameters: Schema.Struct({ id: Schema.String }),
			success: Schema.String,
			handler: ({ id }) => Effect.fail(NotFound.make({ id })),
		});
		const rejection = await runTest(
			Effect.flatMap(Fails.agentTool, (tool) =>
				Effect.promise(() =>
					tool.execute("call-1", { id: "7" }).then(
						() => undefined,
						(error: unknown) => error,
					),
				),
			),
		);
		expect(rejection).toBeInstanceOf(ToolFailed);
		expect(rejection).toMatchObject({ _tag: "ToolFailed", tool: "fails", cause: { _tag: "NotFound", id: "7" } });
		expect((rejection as ToolFailed).message).toContain("NotFound");
	});

	it("rejects arguments its schema refuses after Pi accepted them", async () => {
		const rejection = await runTest(
			Effect.flatMap(Effect.provide(Lookup.agentTool, records), (tool) =>
				Effect.promise(() =>
					tool.execute("call-1", { id: "42", since: "not a date" } as never).then(
						() => undefined,
						(error: unknown) => error,
					),
				),
			),
		);
		expect((rejection as Error).message).toContain("/since");
	});

	it("reports progress through Pi's update callback", async () => {
		const Slow = Tool.make("slow", {
			label: "Slow",
			description: "Slow.",
			parameters: Schema.Struct({}),
			success: Schema.String,
			handler: (_params, api) =>
				Effect.as(
					api.update({ content: [{ type: "text", text: `half of ${api.toolCallId}` }], details: undefined }),
					"done",
				),
		});
		const updates: AgentToolResult[] = [];
		await runTest(
			Effect.flatMap(Slow.agentTool, (tool) =>
				Effect.promise(() => tool.execute("call-9", {}, undefined, (partial) => updates.push(partial))),
			),
		);
		expect(updates).toEqual([{ content: [{ type: "text", text: "half of call-9" }], details: undefined }]);
	});

	it("interrupts the handler when Pi aborts the call", async () => {
		const result = await runTest(
			Effect.gen(function* () {
				const started = yield* Latch.make();
				const interrupted = yield* Latch.make();
				const Waits = Tool.make("waits", {
					label: "Waits",
					description: "Waits.",
					parameters: Schema.Struct({}),
					success: Schema.String,
					handler: () =>
						Effect.andThen(Latch.open(started), Effect.never).pipe(
							Effect.onInterrupt(() => Latch.open(interrupted)),
						),
				});
				const tool = yield* Waits.agentTool;
				const controller = new AbortController();
				const call = tool.execute("call-1", {}, controller.signal).then(
					() => "resolved",
					() => "rejected",
				);
				yield* started.await;
				controller.abort();
				yield* interrupted.await;
				return yield* Effect.promise(() => call);
			}),
		);
		expect(result).toBe("rejected");
	});
});
