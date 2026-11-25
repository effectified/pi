import type { SchemaConversionError } from "@gunta/pi-schema-effect";
import { Context, Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Extension, Hook, Registry, Task, Tool } from "../src/index.ts";

class Records extends Context.Service<Records, { readonly title: (id: string) => Effect.Effect<string> }>()(
	"test/Records",
) {}

const Lookup = Tool.make("lookup", {
	description: "Look a record up by id.",
	parameters: Schema.Struct({ id: Schema.String }),
	success: Schema.String,
	handler: ({ id }) => Records.use((records) => records.title(id)),
});

const Echo = Tool.make("echo", {
	description: "Say it back.",
	parameters: Schema.Struct({ text: Schema.String }),
	success: Schema.String,
	handler: ({ text }) => Effect.succeed(text),
});

class Clock extends Context.Service<Clock, { readonly now: Effect.Effect<number> }>()("test/Clock") {}

const Now = Tool.make("now", {
	description: "The current time.",
	parameters: Schema.Struct({}),
	success: Schema.Number,
	handler: () => Clock.use((clock) => clock.now),
});

class Mailer extends Context.Service<Mailer, { readonly send: (to: string) => Effect.Effect<void> }>()("test/Mailer") {}

/** A task whose phase needs `Mailer` and whose abort handler needs `Clock`. */
const Notify = Task.make({
	name: "test.notify",
	version: 1,
	input: Schema.Struct({ to: Schema.String }),
	state: Schema.Struct({ phase: Schema.Literal("send") }),
	result: Schema.Null,
	initial: () => ({ phase: "send" as const }),
	phases: {
		send: (task) =>
			Effect.as(
				Mailer.use((mailer) => mailer.send(task.input.to)),
				Task.complete(null),
			),
	},
	abort: () =>
		Effect.as(
			Clock.use((clock) => clock.now),
			Task.aborted(),
		),
});

const records = Layer.succeed(Records, { title: (id) => Effect.succeed(id) });

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe("layer", () => {
	it("requires what the tools' handlers need until a Layer provides it", () => {
		const needsBoth = Registry.layer([
			Extension.make({ name: "app", tools: [Lookup, Now] }),
			Extension.make({ name: "empty" }),
			{ name: "plain", tools: [Echo] },
		]);
		const requirements: Equal<Layer.Services<typeof needsBoth>, Records | Clock> = true;
		// @ts-expect-error The registry's tools need Records and Clock, which nothing provides.
		const unprovided: Layer.Layer<Registry.Registry, SchemaConversionError> = needsBoth;
		// @ts-expect-error Records alone is not enough: the `now` tool needs Clock.
		const half: Layer.Layer<Registry.Registry, SchemaConversionError> = needsBoth.pipe(Layer.provide(records));
		const provided: Layer.Layer<Registry.Registry, SchemaConversionError> = needsBoth.pipe(
			Layer.provide(records),
			Layer.provide(Layer.succeed(Clock, { now: Effect.succeed(0) })),
		);
		const needsNothing: Layer.Layer<Registry.Registry, SchemaConversionError> = Registry.layer([
			{ name: "plain", tools: [Echo] },
		]);
		expect(requirements).toBe(true);
		expect([unprovided, half, provided, needsNothing].every(Layer.isLayer)).toBe(true);
	});

	it("requires what the phases and the abort handler of its tasks need, and installs them by name", async () => {
		const needsBoth = Registry.layer([Extension.make({ name: "app", tasks: [Notify] })]);
		const requirements: Equal<Layer.Services<typeof needsBoth>, Mailer | Clock> = true;
		const mixed = Registry.layer([
			Extension.make({
				name: "app",
				tools: [Lookup],
				tasks: [Notify],
				hooks: [Hook.afterResponse(() => Effect.void)],
			}),
		]);
		const ofAll: Equal<Layer.Services<typeof mixed>, Records | Mailer | Clock> = true;
		// @ts-expect-error The task's phase needs Mailer and its abort handler Clock, which nothing provides.
		const unprovided: Layer.Layer<Registry.Registry, SchemaConversionError> = needsBoth;
		const mailer = Layer.succeed(Mailer, { send: () => Effect.void });
		// @ts-expect-error Mailer alone is not enough: the abort handler needs Clock.
		const half: Layer.Layer<Registry.Registry, SchemaConversionError> = needsBoth.pipe(Layer.provide(mailer));
		const provided: Layer.Layer<Registry.Registry, SchemaConversionError> = needsBoth.pipe(
			Layer.provide(mailer),
			Layer.provide(Layer.succeed(Clock, { now: Effect.succeed(0) })),
		);
		expect([requirements, ofAll]).toEqual([true, true]);
		expect([unprovided, half].every(Layer.isLayer)).toBe(true);
		const snapshot = await Effect.runPromise(
			Registry.Registry.use((registry) => Effect.succeed(registry.snapshot())).pipe(Effect.provide(provided)),
		);
		const installed = snapshot.task("test.notify");
		expect([installed?.definition.name, installed?.definition.version]).toEqual(["test.notify", 1]);
		expect(Object.keys(installed?.definition.phases ?? {})).toEqual(["send"]);
		// The installed definition is the registration's, not the creation token.
		expect(installed).not.toBe(Notify.token);
	});

	it("installs the extensions in order, in a registry that has Pi's built-in tasks", async () => {
		const layer = Registry.layer([
			Extension.make({ name: "first", tools: [Echo] }),
			Extension.make({ name: "second" }),
			Extension.make({ name: "third", tools: [Lookup] }),
		]).pipe(Layer.provide(records));
		const snapshot = await Effect.runPromise(
			Registry.Registry.use((registry) => Effect.succeed(registry.snapshot())).pipe(Effect.provide(layer)),
		);
		expect(snapshot.installed().map((extension) => extension.name)).toEqual(["first", "second", "third"]);
		expect(snapshot.tools().map(({ extension, tool }) => [extension.name, tool.name])).toEqual([
			["first", "echo"],
			["third", "lookup"],
		]);
		expect(snapshot.task("pi.generation")?.definition.name).toBe("pi.generation");
	});

	it("fails with SchemaConversionError when a tool's parameters have no JSON Schema", async () => {
		const Bad = Tool.make("bad", {
			description: "Cannot be described to a model.",
			parameters: Schema.Struct({ [Symbol.for("key")]: Schema.String }),
			success: Schema.String,
			handler: () => Effect.succeed("never called"),
		});
		const error = await Effect.runPromise(
			Effect.flip(Effect.scoped(Layer.build(Registry.layer([Extension.make({ name: "app", tools: [Bad] })])))),
		);
		expect(error).toMatchObject({
			_tag: "SchemaConversionError",
			reason: "Tool bad: Objects property names must be strings",
		});
	});
});
