import { Context, Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Extension, Gate, Hook, Task, Tool } from "../src/index.ts";

class Clock extends Context.Service<Clock, { readonly now: Effect.Effect<number> }>()("test/Clock") {}

class Notes extends Context.Service<Notes, { readonly add: (text: string) => Effect.Effect<void> }>()("test/Notes") {}

const Now = Tool.make("now", {
	description: "The current time.",
	parameters: Schema.Struct({}),
	success: Schema.Number,
	handler: () => Clock.use((clock) => clock.now),
});

const Note = Tool.make("note", {
	description: "Keep a note.",
	parameters: Schema.Struct({ text: Schema.String }),
	success: Schema.Void,
	handler: ({ text }) => Notes.use((notes) => notes.add(text)),
});

class Audit extends Context.Service<Audit, { readonly record: (line: string) => Effect.Effect<void> }>()(
	"test/Audit",
) {}

const Audited = Hook.beforeTool((call) =>
	Effect.as(
		Audit.use((audit) => audit.record(call.name)),
		Gate.allow,
	),
);

const Plain = Hook.afterResponse(() => Effect.void);

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe("make", () => {
	it("returns the extension it was given, and its services are the union of what its tools need", () => {
		const definition = { name: "app", tools: [Now, Note] } as const;
		const app = Extension.make(definition);
		const requirements: Equal<Extension.Services<typeof app>, Clock | Notes> = true;
		expect(app).toBe(definition);
		expect(requirements).toBe(true);
	});

	it("adds what its hooks need to its services", () => {
		const guarded = Extension.make({ name: "guarded", tools: [Now], hooks: [Audited, Plain] });
		const hooksOnly = Extension.make({ name: "hooks", hooks: [Audited] });
		const needsNothing = { name: "plain", hooks: [Plain] };
		const requirements: Equal<Extension.Services<typeof guarded>, Clock | Audit> = true;
		const ofHooks: Equal<Extension.Services<typeof hooksOnly>, Audit> = true;
		const ofPlain: Equal<Extension.Services<typeof needsNothing>, never> = true;
		expect([requirements, ofHooks, ofPlain]).toEqual([true, true, true]);
		expect(guarded.hooks).toEqual([Audited, Plain]);
	});

	it("adds what its tasks need to its services, and keeps the tasks it was given", () => {
		const Tick = Task.make({
			name: "test.tick",
			version: 1,
			input: Schema.Null,
			state: Schema.Struct({ phase: Schema.Literal("tick") }),
			result: Schema.Number,
			initial: () => ({ phase: "tick" as const }),
			phases: {
				tick: () =>
					Effect.map(
						Clock.use((clock) => clock.now),
						Task.complete,
					),
			},
			abort: () =>
				Effect.as(
					Audit.use((audit) => audit.record("aborted")),
					Task.aborted(),
				),
		});
		const Plain = Task.make({
			name: "test.plain",
			version: 1,
			input: Schema.Null,
			state: Schema.Struct({ phase: Schema.Literal("only") }),
			result: Schema.Null,
			initial: () => ({ phase: "only" as const }),
			phases: { only: () => Effect.succeed(Task.complete(null)) },
			abort: () => Effect.succeed(Task.aborted()),
		});
		const timed = Extension.make({ name: "timed", tools: [Note], tasks: [Tick, Plain] });
		const plain = Extension.make({ name: "plain", tasks: [Plain] });
		const requirements: Equal<Extension.Services<typeof timed>, Notes | Clock | Audit> = true;
		const ofPlain: Equal<Extension.Services<typeof plain>, never> = true;
		const ofTask: Equal<Task.Services<typeof Tick>, Clock | Audit> = true;
		expect([requirements, ofPlain, ofTask]).toEqual([true, true, true]);
		expect(timed.tasks).toEqual([Tick, Plain]);
	});

	it("needs nothing when it has no tools, made or written as a plain object", () => {
		const empty = Extension.make({ name: "empty" });
		const plain = { name: "plain" };
		const requirements: Equal<Extension.Services<typeof empty | typeof plain>, never> = true;
		expect(empty).toEqual({ name: "empty" });
		expect(requirements).toBe(true);
	});
});
