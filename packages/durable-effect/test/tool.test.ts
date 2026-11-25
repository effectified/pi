import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type EntryRecord,
	type JsonObject,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { runTest } from "@gunta/pi-ai-effect/testing";
import { type SchemaConversionError, toJsonSchema } from "@gunta/pi-schema-effect";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { Tool as AiTool, Toolkit } from "effect/ai";
import { describe, expect, it } from "vitest";
import { Extension, Harness, Registry, Tool } from "../src/index.ts";
import { runBoth } from "./parity.ts";
import { AGENT, answer, harnessLayer } from "./scripted.ts";

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.String }) {
	override get message(): string {
		return `No record ${this.id}`;
	}
}

class Records extends Context.Service<
	Records,
	{ readonly get: (id: string) => Effect.Effect<{ readonly title: string }, NotFound> }
>()("test/Records") {}

const records = Layer.succeed(Records, {
	get: (id) => (id === "42" ? Effect.succeed({ title: "Answer" }) : Effect.fail(new NotFound({ id }))),
});

const LookupParameters = Schema.Struct({ id: Schema.String });

const Lookup = Tool.make("lookup", {
	description: "Look a record up by id.",
	parameters: LookupParameters,
	success: Schema.Struct({ title: Schema.String }),
	replay: "safe",
	handler: ({ id }) => Records.use((service) => service.get(id)),
});

/** A model turn that calls `name` with `args`. */
function toolCall(name: string, args: JsonObject): FauxResponseStep {
	return fauxAssistantMessage([fauxToolCall(name, args, { id: "call-1" })], { stopReason: "toolUse" });
}

/** Asks the root conversation one question and returns how it settled and the tool results the model was given. */
const ask = Effect.gen(function* () {
	const root = yield* Harness.rootWith({ agent: AGENT });
	const settled = yield* root.prompt("Summarise the record.");
	yield* root.waitForIdle;
	const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
	return { settled, results: entries.filter((entry) => entry.kind === "pi.tool-result") };
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe("make", () => {
	it("infers the handler's parameters from the schema and the tool's requirements from the handler", () => {
		const parameters: Equal<Parameters<typeof Lookup.handler>[0], { readonly id: string }> = true;
		const requirements: Equal<
			typeof Lookup.registration,
			Effect.Effect<ToolRegistration, SchemaConversionError, Records>
		> = true;
		const name: Equal<typeof Lookup.name, "lookup"> = true;
		expect([parameters, requirements, name]).toEqual([true, true, true]);
	});

	it("gives Pi the JSON Schema of the parameters, the replay policy and the callers", async () => {
		const tool = Tool.make("note", {
			description: "Keep a note.",
			parameters: Schema.Struct({ text: Schema.String }),
			success: Schema.String,
			callers: ["tools"],
			handler: ({ text }) => Effect.succeed(text),
		});
		expect(await Effect.runPromise(tool.registration)).toMatchObject({
			name: "note",
			description: "Keep a note.",
			parameters: toJsonSchema(Schema.Struct({ text: Schema.String })),
			callers: ["tools"],
		});
		expect(await Effect.runPromise(Effect.provide(Lookup.registration, records))).toMatchObject({ replay: "safe" });
	});
});

describe("a call from the model", () => {
	const app = Registry.layer([Extension.make({ name: "app", tools: [Lookup] })]);

	it("runs the handler with the service from the Layer and gives the model the result as JSON", async () => {
		const { settled, results } = await Effect.runPromise(
			ask.pipe(
				Effect.provide(
					harnessLayer({
						responses: [toolCall("lookup", { id: "42" }), answer("It is titled Answer.")],
						registry: app,
					}),
				),
				Effect.provide(records),
			),
		);
		expect(settled.status).toBe("done");
		expect(results.map((entry) => entry.model)).toEqual([
			[
				expect.objectContaining({
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "lookup",
					isError: false,
					content: [{ type: "text", text: '{"title":"Answer"}' }],
				}),
			],
		]);
	});

	it("gives the model a string result as it is", async () => {
		const Echo = Tool.make("echo", {
			description: "Say it back.",
			parameters: Schema.Struct({ text: Schema.String }),
			success: Schema.String,
			handler: ({ text }) => Effect.succeed(text.toUpperCase()),
		});
		const { results } = await Effect.runPromise(
			ask.pipe(
				Effect.provide(
					harnessLayer({
						responses: [toolCall("echo", { text: "hi" }), answer("Done.")],
						registry: Registry.layer([Extension.make({ name: "app", tools: [Echo] })]),
					}),
				),
			),
		);
		expect(results[0]?.model?.[0]).toMatchObject({ isError: false, content: [{ type: "text", text: "HI" }] });
	});

	it("turns a handler failure into an error result the model reads, and the run goes on", async () => {
		const { settled, results } = await Effect.runPromise(
			ask.pipe(
				Effect.provide(
					harnessLayer({
						responses: [toolCall("lookup", { id: "404" }), answer("There is no such record.")],
						registry: app,
					}),
				),
				Effect.provide(records),
			),
		);
		expect(settled.status).toBe("done");
		expect(errorResult(results)).toEqual({
			isError: true,
			content: [{ type: "text", text: "<harness>\n[error] No record 404\n</harness>" }],
			diagnostics: [{ severity: "error", code: "tool_error", message: "No record 404" }],
		});
	});

	it("turns arguments the schema rejects after Pi accepted them into an error result", async () => {
		const Strict = Tool.make("strict", {
			description: "Look a record up by its prefixed id.",
			parameters: Schema.Struct({
				id: Schema.String.check(Schema.makeFilter((id: string) => id.startsWith("rec-") || "must start with rec-")),
			}),
			success: Schema.String,
			handler: ({ id }) => Effect.succeed(id),
		});
		const { settled, results } = await Effect.runPromise(
			ask.pipe(
				Effect.provide(
					harnessLayer({
						responses: [toolCall("strict", { id: "42" }), answer("The id was wrong.")],
						registry: Registry.layer([Extension.make({ name: "app", tools: [Strict] })]),
					}),
				),
			),
		);
		expect(settled.status).toBe("done");
		expect(errorResult(results)).toEqual({
			isError: true,
			content: [{ type: "text", text: "<harness>\n[error] /id: must start with rec-\n</harness>" }],
			diagnostics: [{ severity: "error", code: "invalid_arguments", message: "/id: must start with rec-" }],
		});
	});

	it("leaves a defect of the handler to Pi, which writes its own error result", async () => {
		const Broken = Tool.make("broken", {
			description: "Always breaks.",
			parameters: Schema.Struct({}),
			success: Schema.String,
			handler: () => Effect.die(new Error("boom")),
		});
		const { settled, results } = await Effect.runPromise(
			ask.pipe(
				Effect.provide(
					harnessLayer({
						responses: [toolCall("broken", {}), answer("It broke.")],
						registry: Registry.layer([Extension.make({ name: "app", tools: [Broken] })]),
					}),
				),
			),
		);
		expect(settled.status).toBe("done");
		expect(errorResult(results)).toMatchObject({
			isError: true,
			diagnostics: [{ severity: "error", code: "tool_error", message: "boom" }],
		});
	});

	it("gives its error results the diagnostic codes Pi gives its own", async () => {
		// Pi writes no exported union of its codes: each error result of ours is held to the one Pi wrote for the same
		// kind of failure in the same run, so a code Pi renames fails here.
		const Strict = Tool.make("strict", {
			description: "Look a record up by its prefixed id.",
			parameters: Schema.Struct({
				id: Schema.String.check(Schema.makeFilter((id: string) => id.startsWith("rec-") || "must start with rec-")),
			}),
			success: Schema.String,
			handler: ({ id }) => Effect.succeed(id),
		});
		const Broken = Tool.make("broken", {
			description: "Always breaks.",
			parameters: Schema.Struct({}),
			success: Schema.String,
			handler: () => Effect.die(new Error("boom")),
		});
		const results = await runTest(
			ask.pipe(
				Effect.map(({ results }) =>
					results.map((entry) => (entry.data as { readonly diagnostics: unknown }).diagnostics),
				),
				Effect.provide(
					harnessLayer({
						responses: [
							toolCall("lookup", { id: "404" }),
							toolCall("broken", {}),
							toolCall("strict", { id: "42" }),
							toolCall("strict", {}),
							answer("Nothing worked."),
						],
						registry: Registry.layer([Extension.make({ name: "app", tools: [Lookup, Broken, Strict] })]),
					}),
				),
				Effect.provide(records),
			),
		);
		const [handlerFailure, piThrown, schemaRejected, piInvalid] = results.map((diagnostics) =>
			(diagnostics as ReadonlyArray<{ readonly severity: string; readonly code: string }>).map(
				({ severity, code }) => ({ severity, code }),
			),
		);
		expect(handlerFailure).toEqual(piThrown);
		expect(schemaRejected).toEqual(piInvalid);
		// The two kinds are told apart, as a gate or a plugin reads them.
		expect(handlerFailure).not.toEqual(schemaRejected);
	});

	it("interrupts the handler's fiber when Pi aborts the call", async () => {
		const started = Promise.withResolvers<void>();
		let interrupted = false;
		const Slow = Tool.make("slow", {
			description: "Never finishes by itself.",
			parameters: Schema.Struct({}),
			success: Schema.String,
			handler: () =>
				Effect.sync(() => started.resolve()).pipe(
					Effect.andThen(Effect.never),
					Effect.onInterrupt(() =>
						Effect.sync(() => {
							interrupted = true;
						}),
					),
				),
		});
		const results = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				yield* root.submit({ type: "input", content: "Take your time." });
				yield* Effect.promise(() => started.promise);
				yield* root.abort();
				const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
				return entries.filter((entry) => entry.kind === "pi.tool-result");
			}).pipe(
				Effect.provide(
					harnessLayer({
						responses: [toolCall("slow", {})],
						registry: Registry.layer([Extension.make({ name: "app", tools: [Slow] })]),
					}),
				),
			),
		);
		expect(interrupted).toBe(true);
		expect(errorResult(results)).toMatchObject({
			isError: true,
			diagnostics: [{ severity: "error", code: "aborted" }],
		});
	});
});

describe("a reply", () => {
	/** Asks once with `tool` installed. */
	const askWith = (
		tool: Tool.Any & { readonly registration: Effect.Effect<ToolRegistration, SchemaConversionError> },
	) =>
		ask.pipe(
			Effect.provide(
				harnessLayer({
					responses: [toolCall(tool.name, {}), answer("Done.")],
					registry: Registry.layer([Extension.make({ name: "app", tools: [tool] })]),
				}),
			),
		);

	it("carries a raw payload in details that the model never reads", async () => {
		const raw = { provider: "exa", retrievedAt: 1795500000000, hits: [{ url: "https://example.com", score: 0.9 }] };
		const Search = Tool.make("search", {
			description: "Search the web.",
			parameters: Schema.Struct({}),
			success: Schema.Struct({ titles: Schema.Array(Schema.String) }),
			handler: () => Effect.succeed(Tool.result({ titles: ["Example"] }, { details: raw })),
		});
		const { results } = await Effect.runPromise(askWith(Search));
		const message = results[0]?.model?.[0];
		expect(message).toMatchObject({
			role: "toolResult",
			isError: false,
			// What the model reads: the success value only.
			content: [{ type: "text", text: '{"titles":["Example"]}' }],
			// What a host reads from the stored result.
			details: raw,
		});
		expect(JSON.stringify(message?.content)).not.toContain("example.com");
	});

	it("is an error result the handler decides itself, with the text the model reads", async () => {
		const Deny = Tool.make("deny", {
			description: "Always says no.",
			parameters: Schema.Struct({}),
			success: Schema.String,
			handler: () => Effect.succeed(Tool.error("permission denied: /etc", { details: { path: "/etc" } })),
		});
		const { settled, results } = await Effect.runPromise(askWith(Deny));
		expect(settled.status).toBe("done");
		expect(results[0]?.model?.[0]).toMatchObject({
			isError: true,
			content: [{ type: "text", text: "permission denied: /etc" }],
			details: { path: "/etc" },
		});
	});

	it("passes Pi's other result fields on: another output, usage, diagnostics and control", async () => {
		const usage = {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
		};
		const Summarise = Tool.make("summarise", {
			description: "Summarise with a model of its own.",
			parameters: Schema.Struct({}),
			success: Schema.Struct({ words: Schema.Number }),
			handler: () =>
				Effect.succeed(
					Tool.result(
						{ words: 3 },
						{
							output: [{ type: "text", text: "Three words long." }],
							usage,
							diagnostics: [{ severity: "info", message: "truncated", code: "truncated" }],
							control: { terminate: true },
						},
					),
				),
		});
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const asked = yield* ask;
				return { ...asked, usage: yield* Harness.usage };
			}).pipe(
				Effect.provide(
					harnessLayer({
						// No second response: `terminate` ends the run without another model request.
						responses: [toolCall("summarise", {})],
						registry: Registry.layer([Extension.make({ name: "app", tools: [Summarise] })]),
					}),
				),
			),
		);
		expect(outcome.settled.status).toBe("done");
		expect(outcome.results[0]?.model?.[0]?.content).toEqual([
			{ type: "text", text: "Three words long." },
			{ type: "text", text: "<harness>\n[info] truncated\n</harness>" },
		]);
		expect(outcome.usage.tools).toEqual({ summarise: usage });
	});

	it("declares the success schema as Pi's structured output when the tool is `structured`", async () => {
		const success = Schema.Struct({ lines: Schema.Number });
		const Lines = Tool.make("lines", {
			description: "Count lines.",
			parameters: Schema.Struct({}),
			success,
			structured: true,
			handler: () => Effect.succeed({ lines: 3 }),
		});
		expect(await Effect.runPromise(Lines.registration)).toMatchObject({
			structuredOutputSchema: toJsonSchema(success),
		});
		const plain = await Effect.runPromise(Effect.provide(Lookup.registration, records));
		expect(Object.hasOwn(plain, "structuredOutputSchema")).toBe(false);
		expect(Object.hasOwn(plain, "cancel")).toBe(false);
	});

	it("takes a handler with one argument unchanged, and types the second as the tool api", () => {
		const second: Equal<Parameters<typeof Lookup.handler>[1], Tool.Api> = true;
		expect(second).toBe(true);
	});
});

describe("parity with Pi Durable", () => {
	it("a tool call leaves the records of the same tool defined with defineTool", async () => {
		const piLookup = defineTool({
			name: "lookup",
			description: "Look a record up by id.",
			parameters: toJsonSchema(LookupParameters) as object,
			replay: "safe",
			execute: async () => ({ output: [{ type: "text", text: '{"title":"Answer"}' }] }),
		});
		const Constant = Tool.make("lookup", {
			description: "Look a record up by id.",
			parameters: LookupParameters,
			success: Schema.Struct({ title: Schema.String }),
			replay: "safe",
			handler: () => Effect.succeed({ title: "Answer" }),
		});
		const both = await runBoth({
			responses: () => [toolCall("lookup", { id: "42" }), answer("It is titled Answer.")],
			extensions: {
				effect: Registry.layer([Extension.make({ name: "app", tools: [Constant] })]),
				pi: [defineExtension({ name: "app", tools: [piLookup] })],
			},
			effect: Effect.flatMap(Harness.rootWith({ agent: AGENT }), (root) => root.prompt("Summarise record 42.")),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				return (await root.submit({ type: "input", content: "Summarise record 42." }, context)).wait(context);
			},
		});
		expect(both.effect).toEqual(both.pi);
		expect(both.effect.records.entries.map((entry) => entry.kind)).toEqual([
			"pi.user",
			"pi.system",
			"pi.assistant",
			"pi.tool-result",
			"pi.assistant",
		]);
	});
	it("a reply with details leaves the records of a Pi tool that returns the same output and details", async () => {
		const raw = { hits: [{ url: "https://example.com" }] };
		const piSearch = defineTool({
			name: "search",
			description: "Search the web.",
			parameters: toJsonSchema(Schema.Struct({})) as object,
			execute: async () => ({ output: [{ type: "text", text: '{"titles":["Example"]}' }], details: raw }),
		});
		const Search = Tool.make("search", {
			description: "Search the web.",
			parameters: Schema.Struct({}),
			success: Schema.Struct({ titles: Schema.Array(Schema.String) }),
			handler: () => Effect.succeed(Tool.result({ titles: ["Example"] }, { details: raw })),
		});
		const both = await runBoth({
			responses: () => [toolCall("search", {}), answer("Found it.")],
			extensions: {
				effect: Registry.layer([Extension.make({ name: "app", tools: [Search] })]),
				pi: [defineExtension({ name: "app", tools: [piSearch] })],
			},
			effect: Effect.flatMap(Harness.rootWith({ agent: AGENT }), (root) => root.prompt("Search.")),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				return (await root.submit({ type: "input", content: "Search." }, context)).wait(context);
			},
		});
		expect(both.effect).toEqual(both.pi);
		const result = both.effect.records.entries.find((entry) => entry.kind === "pi.tool-result");
		expect(result).toMatchObject({ model: [{ details: raw }] });
	});
});

/** The one tool result of a run, as the model and Pi's diagnostics show it. */
function errorResult(results: readonly EntryRecord[]) {
	expect(results).toHaveLength(1);
	const message = results[0]?.model?.[0];
	const data = results[0]?.data as { readonly diagnostics: unknown } | undefined;
	return {
		isError: message?.role === "toolResult" && message.isError,
		content: message?.content,
		diagnostics: data?.diagnostics,
	};
}

describe("the other options of Pi's defineTool", () => {
	const Parameters = Schema.Struct({ items: Schema.Array(Schema.String) });
	const repair = (args: unknown) => {
		const { items } = args as { readonly items: unknown };
		return typeof items === "string" ? { items: JSON.parse(items) as unknown } : args;
	};
	const limits = { maxLines: 2, retain: "tail" } as const;
	const sampling = { type: "json_schema", strict: "prefer" } as const;

	/** Joins its items, one per line. `ran` gets when each call started and ended. */
	const join = (ran: string[] = []) =>
		Tool.make("join", {
			description: "Join items, one per line.",
			parameters: Parameters,
			success: Schema.String,
			executionMode: "sequential",
			deferred: true,
			prepareArguments: repair,
			outputLimits: limits,
			constrainedSampling: sampling,
			handler: ({ items }) =>
				Effect.gen(function* () {
					ran.push(`start ${items[0]}`);
					// A turn for anything else to run: a call that ran beside this one would start now.
					yield* Effect.yieldNow;
					ran.push(`end ${items[0]}`);
					return items.join("\n");
				}),
		});

	it("passes executionMode, deferred, prepareArguments, outputLimits and constrainedSampling on unchanged", async () => {
		const made = await Effect.runPromise(join().registration);
		expect(made.executionMode).toBe("sequential");
		expect(made.deferred).toBe(true);
		expect(made.prepareArguments).toBe(repair);
		expect(made.outputLimits).toBe(limits);
		expect(made.constrainedSampling).toBe(sampling);
		// A tool that sets none of them gives Pi none of them.
		const plain = await Effect.runPromise(
			Tool.make("plain", {
				description: "Nothing special.",
				parameters: Parameters,
				success: Schema.String,
				handler: () => Effect.succeed("ok"),
			}).registration,
		);
		expect(Object.keys(plain).sort()).toEqual(["description", "execute", "name", "parameters"]);
	});

	it("types each option as Pi does", () => {
		const options: Equal<
			Pick<ReturnType<typeof join>, "executionMode" | "deferred" | "outputLimits" | "constrainedSampling">,
			Pick<
				Tool.Options<typeof Parameters, typeof Schema.String, never, never>,
				"executionMode" | "deferred" | "outputLimits" | "constrainedSampling"
			>
		> = true;
		const mode: Equal<
			NonNullable<ReturnType<typeof join>["executionMode"]>,
			NonNullable<ToolRegistration["executionMode"]>
		> = true;
		// @ts-expect-error Pi's `deferred` is `true` or absent.
		const never: Tool.Options<typeof Parameters, typeof Schema.String, never, never>["deferred"] = false;
		expect([options, mode, never]).toEqual([true, true, false]);
	});

	it("repairs the arguments before Pi validates them, runs a sequential round one call after another, and keeps the output's tail", async () => {
		const ran: string[] = [];
		const offered: string[][] = [];
		const Join = join(ran);
		const twoCalls = fauxAssistantMessage(
			[
				// A JSON string where an array belongs: what `prepareArguments` repairs.
				fauxToolCall("join", { items: '["a","b","c"]' }, { id: "call-1" }),
				fauxToolCall("join", { items: ["x", "y", "z"] }, { id: "call-2" }),
			],
			{ stopReason: "toolUse" },
		);
		const { results } = await Effect.runPromise(
			Effect.gen(function* () {
				// A deferred tool is offered only once `modelTools` names it.
				const root = yield* Harness.rootWith({ agent: { ...AGENT, modelTools: { add: ["join"] } } });
				const settled = yield* root.prompt("Join them.");
				yield* root.waitForIdle;
				const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
				return { settled, results: entries.filter((entry) => entry.kind === "pi.tool-result") };
			}).pipe(
				Effect.provide(
					harnessLayer({
						responses: [
							(context) => {
								offered.push(getCurrentTools(context.messages).map((tool) => tool.name));
								return twoCalls;
							},
							answer("Joined."),
						],
						registry: Registry.layer([Extension.make({ name: "app", tools: [Join] })]),
					}),
				),
			),
		);
		expect(offered).toEqual([["join"]]);
		expect(ran).toEqual(["start a", "end a", "start x", "end x"]);
		const texts = results.map((entry) => {
			const message = entry.model?.[0];
			return message?.role === "toolResult" ? message.content : [];
		});
		// Pi keeps the last two lines and tells the model what it dropped.
		const dropped = "<harness>\n[warn] Output truncated to its end: 1 lines, 2 bytes dropped\n</harness>";
		expect(texts).toEqual([
			[
				{ type: "text", text: "b\nc" },
				{ type: "text", text: dropped },
			],
			[
				{ type: "text", text: "y\nz" },
				{ type: "text", text: dropped },
			],
		]);
	});

	it("does not offer a deferred tool to the model while `modelTools` does not name it", async () => {
		const offered: string[][] = [];
		await Effect.runPromise(
			Effect.flatMap(Harness.rootWith({ agent: AGENT }), (root) => root.prompt("Hello.")).pipe(
				Effect.provide(
					harnessLayer({
						responses: [
							(context) => {
								offered.push(getCurrentTools(context.messages).map((tool) => tool.name));
								return fauxAssistantMessage("Hi.");
							},
						],
						registry: Registry.layer([Extension.make({ name: "app", tools: [join()] })]),
					}),
				),
			),
		);
		expect(offered).toEqual([[]]);
	});
});

describe("fromToolkit", () => {
	const ON = new Date("2026-11-25T00:00:00.000Z");
	const WeatherParameters = Schema.Struct({ city: Schema.String, on: Schema.Date });

	const GetWeather = AiTool.make("get_weather", {
		description: "The weather in a city on a day.",
		parameters: WeatherParameters,
		success: Schema.Struct({ temperature: Schema.Number, on: Schema.Date }),
	});
	// A failure this tool returns is part of its answer.
	const FindCity = AiTool.make("find_city", {
		description: "Find a city by name.",
		parameters: Schema.Struct({ name: Schema.String }),
		success: Schema.String,
		failure: Schema.Struct({ reason: Schema.String }),
		failureMode: "return",
	});
	// A failure this tool fails with ends its handler.
	const Broken = AiTool.make("broken", {
		description: "Never works.",
		parameters: Schema.Struct({}),
		success: Schema.String,
		failure: Schema.String,
	});
	const toolkit = Toolkit.make(GetWeather, FindCity, Broken);

	const seen: unknown[] = [];
	const handlers = toolkit.toLayer({
		get_weather: (params) =>
			Effect.sync(() => {
				seen.push(params);
				return { temperature: params.city.length, on: params.on };
			}),
		find_city: ({ name }) => (name === "Atlantis" ? Effect.fail({ reason: "sunk" }) : Effect.succeed(name)),
		broken: () => Effect.fail("wires crossed"),
	});

	const tools = Tool.fromToolkit(toolkit);
	const registry = Registry.layer([Extension.make({ name: "ai", tools })]);

	/** The tool result the model reads after one call of `name` with `args`. */
	const call = (name: string, args: JsonObject) =>
		Effect.runPromise(
			ask.pipe(
				Effect.map(({ results }) => results.map((entry) => [entry.model?.[0], entry.data])),
				Effect.provide(harnessLayer({ responses: [toolCall(name, args), answer("Done.")], registry })),
				Effect.provide(handlers),
			),
		);

	it("makes one tool per tool of the toolkit, with its name, its description and the JSON Schema of its parameters", async () => {
		const made = await Effect.runPromise(
			Effect.forEach(tools, (tool) => tool.registration).pipe(Effect.provide(handlers)),
		);
		expect(tools.map((tool) => tool.name)).toEqual(["get_weather", "find_city", "broken"]);
		expect(made.map((tool) => [tool.name, tool.description])).toEqual([
			["get_weather", "The weather in a city on a day."],
			["find_city", "Find a city by name."],
			["broken", "Never works."],
		]);
		expect(made[0]?.parameters).toEqual(toJsonSchema(WeatherParameters));
	});

	it("requires the toolkit's handlers: a registry of its tools does not build without their Layer", () => {
		const requirements: Equal<
			Layer.Services<typeof registry>,
			AiTool.HandlersFor<Toolkit.Tools<typeof toolkit>>
		> = true;
		// @ts-expect-error The tools need the toolkit's handlers, which nothing provides.
		const unprovided: Layer.Layer<Registry.Registry, SchemaConversionError> = registry;
		const provided: Layer.Layer<Registry.Registry, SchemaConversionError> = registry.pipe(Layer.provide(handlers));
		expect(requirements).toBe(true);
		expect([unprovided, provided].every(Layer.isLayer)).toBe(true);
	});

	it("runs the toolkit's handler with decoded arguments and gives the model the encoded result", async () => {
		seen.length = 0;
		const results = await call("get_weather", { city: "Paris", on: ON.toISOString() });
		expect(seen).toEqual([{ city: "Paris", on: ON }]);
		expect(results).toEqual([
			[
				expect.objectContaining({
					role: "toolResult",
					toolName: "get_weather",
					isError: false,
					content: [{ type: "text", text: JSON.stringify({ temperature: 5, on: ON.toISOString() }) }],
				}),
				{ diagnostics: [] },
			],
		]);
	});

	it("gives a failure the tool returns as an error result with the encoded failure", async () => {
		const found = await call("find_city", { name: "Paris" });
		const sunk = await call("find_city", { name: "Atlantis" });
		expect(found[0]?.[0]).toMatchObject({ isError: false, content: [{ type: "text", text: "Paris" }] });
		expect(sunk[0]?.[0]).toMatchObject({ isError: true, content: [{ type: "text", text: '{"reason":"sunk"}' }] });
	});

	it("turns a failure the tool fails with into a tool_error result, as for a tool of `make`", async () => {
		const results = await call("broken", {});
		expect(results[0]?.[0]).toMatchObject({ role: "toolResult", toolName: "broken", isError: true });
		expect(results[0]?.[1]).toEqual({
			// The failure as `make` words one that is no Error: the value, formatted.
			diagnostics: [{ severity: "error", code: "tool_error", message: '"wires crossed"' }],
		});
	});
});
