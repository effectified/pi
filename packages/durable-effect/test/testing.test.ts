import { Models } from "@effectified/pi-ai";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	type DurableError,
	Extension,
	Harness,
	Registry,
	type SchemaConversionError,
	Storage,
	Tool,
} from "../src/index.ts";
import * as Testing from "../src/testing/index.ts";
import { answer, held, ScriptedModels, TestHarness, toolCall } from "../src/testing/index.ts";
import { KeptStorage } from "./scripted.ts";

class Records extends Context.Service<Records, { readonly title: (id: string) => Effect.Effect<string> }>()(
	"test/Records",
) {}

const Lookup = Tool.make("lookup", {
	description: "Look a record up by id.",
	parameters: Schema.Struct({ id: Schema.String }),
	success: Schema.String,
	handler: ({ id }) => Records.use((records) => records.title(id)),
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe("the testing kit", () => {
	it("exports the harness Layer, the scripted provider and the response builders", () => {
		expect(Object.keys(Testing).sort()).toEqual([
			"ScriptedModels",
			"TestHarness",
			"answer",
			"fauxAssistantMessage",
			"fauxText",
			"fauxThinking",
			"fauxToolCall",
			"held",
			"toolCall",
		]);
		expect(Object.keys(TestHarness).sort()).toEqual(["agent", "layer", "layerWith", "root", "sqlStorage"]);
	});
});

describe("TestHarness.layer", () => {
	it("is one Layer to provide: script the responses, prompt, assert", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const settled = yield* root.prompt("What is record 42 called?");
				yield* root.waitForIdle;
				const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
				return { settled, entries, requests: yield* ScriptedModels.use((models) => models.callCount) };
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [Extension.make({ name: "app", tools: [Lookup] })],
						responses: [toolCall("lookup", { id: "42" }, { id: "call-1" }), answer("It is called Answer.")],
					}),
				),
				Effect.provide(Layer.succeed(Records, { title: () => Effect.succeed("Answer") })),
			),
		);
		expect(result.settled.status).toBe("done");
		expect(result.requests).toBe(2);
		expect(result.entries.map((entry) => entry.kind)).toEqual([
			"pi.user",
			"pi.system",
			"pi.assistant",
			"pi.tool-result",
			"pi.assistant",
		]);
		expect(result.entries[3]?.model?.[0]).toMatchObject({ content: [{ type: "text", text: "Answer" }] });
		// The api name is fixed, so a stored message is the same in every run.
		expect(result.entries[4]?.model?.[0]).toMatchObject({ api: "scripted", provider: "faux", model: "faux-1" });
	});

	it("requires what the extensions' handlers need, and nothing without extensions", () => {
		const withTool = TestHarness.layer({ extensions: [Extension.make({ name: "app", tools: [Lookup] })] });
		const plain = TestHarness.layer();
		const needs: Equal<Layer.Services<typeof withTool>, Records> = true;
		const needsNothing: Equal<Layer.Services<typeof plain>, never> = true;
		// @ts-expect-error The lookup tool needs Records, which nothing provides.
		const unprovided: Layer.Layer<TestHarness.Provided, DurableError> = withTool;
		expect([needs, needsNothing]).toEqual([true, true]);
		expect(Layer.isLayer(unprovided)).toBe(true);
	});

	it("queues more responses while the test runs, and counts what the model was asked", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const root = yield* TestHarness.root;
				const before = yield* scripted.pendingResponseCount;
				yield* scripted.appendResponses([answer("One."), answer("Two.")]);
				const first = yield* root.prompt("First.");
				yield* root.waitForIdle;
				const second = yield* root.prompt("Second.");
				return { before, statuses: [first.status, second.status], left: yield* scripted.pendingResponseCount };
			}).pipe(Effect.provide(TestHarness.layer())),
		);
		expect(seen).toEqual({ before: 0, statuses: ["done", "done"], left: 0 });
	});

	it("takes a storage that keeps its data: a second build reopens what the first left", async () => {
		const storage = Storage.custom(new KeptStorage());
		await Effect.runPromise(
			Effect.flatMap(TestHarness.root, (root) => root.prompt("Hi.", { requestId: "a" })).pipe(
				Effect.tap(Harness.waitForIdle),
				Effect.provide(TestHarness.layer({ responses: [answer("Hello.")], storage })),
			),
		);
		const kinds = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Again.", { requestId: "b" });
				yield* root.waitForIdle;
				return (yield* Stream.runCollect(root.entries({ order: "ascending" }))).map((entry) => entry.kind);
			}).pipe(Effect.provide(TestHarness.layer({ responses: [answer("Hello again.")], storage }))),
		);
		expect(kinds).toEqual(["pi.user", "pi.assistant", "pi.user", "pi.assistant"]);
	});
});

describe("held", () => {
	it("holds a response back until it is released, and says when the model was asked", async () => {
		const response = held(answer("Done."));
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const submission = yield* root.submit({ type: "input", content: "Go." });
				yield* response.requested;
				const busy = (yield* submission.status).status;
				yield* response.release;
				return { busy, settled: (yield* submission.wait).status };
			}).pipe(Effect.provide(TestHarness.layer({ responses: [response.response] }))),
		);
		expect(seen).toEqual({ busy: "placed", settled: "done" });
	});

	it("answers by itself when its request is aborted, so an aborted run ends", async () => {
		const response = held(answer("Never read."));
		const status = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const submission = yield* root.submit({ type: "input", content: "Go." });
				yield* response.requested;
				yield* root.abort();
				return yield* submission.status;
			}).pipe(Effect.provide(TestHarness.layer({ responses: [response.response] }))),
		);
		expect(status).toMatchObject({ status: "unanswered", reason: "aborted" });
	});
});

/** A service a product's registry Layer provides beside the registry, as a guard does. */
class Audit extends Context.Service<Audit, { readonly installed: ReadonlyArray<string> }>()("test/Audit") {}

/** A product's registry Layer: it builds the registry itself and provides a service of its own with it. */
const audited = Layer.merge(
	Registry.layer([Extension.make({ name: "app", tools: [Lookup] })]),
	Layer.succeed(Audit, { installed: ["app"] }),
);

/** A service a product's models Layer provides beside `Models`, as a budget does. */
class Asked extends Context.Service<Asked, { readonly requests: Array<string> }>()("test/Asked") {}

/** A product's models Layer: a `Models` that wraps the one underneath and records every request made through it. */
const recording: Layer.Layer<Models | Asked, never, Models> = Layer.effectContext(
	Effect.gen(function* () {
		const inner = yield* Models;
		const requests: string[] = [];
		const wrapped = new Proxy(inner, {
			get: (target, property) => {
				const member: unknown = Reflect.get(target, property, target);
				if (typeof member !== "function") return member;
				if (typeof property === "string" && /^(stream|complete)/.test(property)) requests.push(property);
				return member.bind(target);
			},
		});
		return Context.make(Models, wrapped).pipe(Context.add(Asked, { requests }));
	}),
);

describe("TestHarness.layerWith", () => {
	it("opens the harness on a registry Layer of your own, and provides what that Layer provides besides", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const settled = yield* root.prompt("What is record 42 called?");
				yield* root.waitForIdle;
				const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
				return {
					settled: settled.status,
					kinds: entries.map((entry) => entry.kind),
					audit: (yield* Audit).installed,
					registered: (yield* Registry.Registry)
						.snapshot()
						.installed()
						.map((extension) => extension.name),
				};
			}).pipe(
				Effect.provide(
					TestHarness.layerWith({
						registry: audited,
						responses: [toolCall("lookup", { id: "42" }, { id: "call-1" }), answer("It is called Answer.")],
					}),
				),
				Effect.provide(Layer.succeed(Records, { title: () => Effect.succeed("Answer") })),
			),
		);
		expect(result).toEqual({
			settled: "done",
			kinds: ["pi.user", "pi.system", "pi.assistant", "pi.tool-result", "pi.assistant"],
			audit: ["app"],
			registered: ["app"],
		});
	});

	it("opens the harness on your Models over the scripted provider, which ScriptedModels still scripts and counts", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				yield* scripted.appendResponses([answer("Two.")]);
				const root = yield* TestHarness.root;
				const first = yield* root.prompt("First.");
				yield* root.waitForIdle;
				const second = yield* root.prompt("Second.");
				yield* root.waitForIdle;
				return {
					statuses: [first.status, second.status],
					// Through the product's `Models`, and on to the provider underneath.
					asked: (yield* Asked).requests.length,
					reached: yield* scripted.callCount,
					left: yield* scripted.pendingResponseCount,
					wrapped: (yield* Models).getModel(scripted.model.provider, scripted.model.id) === scripted.model,
				};
			}).pipe(Effect.provide(TestHarness.layerWith({ models: recording, responses: [answer("One.")] }))),
		);
		expect(result.statuses).toEqual(["done", "done"]);
		expect(result.asked).toBeGreaterThanOrEqual(2);
		expect(result).toMatchObject({ reached: 2, left: 0, wrapped: true });
	});

	it("takes both, harness options and a storage, and a Layer that needs the open harness goes over it", async () => {
		const storage = Storage.custom(new KeptStorage());
		const created: number[] = [];
		const layer = TestHarness.layerWith({
			registry: audited,
			models: recording,
			storage,
			responses: [answer("Hello.")],
			harness: {
				conversationCreated: (_tx, conversation) =>
					Records.use(() => Effect.sync(() => void created.push(conversation.id))),
			},
		});
		/** What a product attaches once the harness is open, such as a budget's shares. */
		const attached = Layer.effectDiscard(Effect.flatMap(TestHarness.root, (root) => root.prompt("Hi.")));
		const kinds = await Effect.runPromise(
			Effect.gen(function* () {
				yield* Harness.waitForIdle;
				const root = yield* Harness.root;
				return (yield* Stream.runCollect(root.entries({ order: "ascending" }))).map((entry) => entry.kind);
			}).pipe(
				Effect.provide(attached.pipe(Layer.provideMerge(layer))),
				Effect.provide(Layer.succeed(Records, { title: () => Effect.succeed("Answer") })),
			),
		);
		// The registry's tool is offered: Pi declares it in a system entry.
		expect(kinds).toEqual(["pi.user", "pi.system", "pi.assistant"]);
		expect(created).toEqual([1]);
	});

	it("provides what layer provides and what your Layers add, and requires what they and the options need", () => {
		const plain = TestHarness.layerWith();
		const withRegistry = TestHarness.layerWith({ registry: audited });
		const withModels = TestHarness.layerWith({ models: recording });
		const withBoth = TestHarness.layerWith({
			registry: audited,
			models: recording,
			harness: { conversationCreated: () => Asked.use(() => Effect.void) },
		});
		const checks: [
			Equal<Layer.Success<typeof plain>, TestHarness.Provided>,
			Equal<Layer.Services<typeof plain>, never>,
			Equal<Layer.Error<typeof plain>, DurableError>,
			Equal<Layer.Success<typeof withRegistry>, TestHarness.Provided | Audit>,
			// The lookup tool of the registry needs Records.
			Equal<Layer.Services<typeof withRegistry>, Records>,
			Equal<Layer.Error<typeof withRegistry>, DurableError | SchemaConversionError>,
			Equal<Layer.Success<typeof withModels>, TestHarness.Provided | Asked>,
			// The `Models` the wrapper requires is the scripted one, which the kit provides.
			Equal<Layer.Services<typeof withModels>, never>,
			Equal<Layer.Success<typeof withBoth>, TestHarness.Provided | Audit | Asked>,
			// What `conversationCreated` needs is required, also when one of the Layers happens to provide it.
			Equal<Layer.Services<typeof withBoth>, Records | Asked>,
		] = [true, true, true, true, true, true, true, true, true, true];
		expect(checks.every((check) => check)).toBe(true);
		expect([plain, withRegistry, withModels, withBoth].every(Layer.isLayer)).toBe(true);
	});
});
