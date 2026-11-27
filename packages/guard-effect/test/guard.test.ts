import type { ConversationId } from "@earendil-works/pi-durable";
import { Extension, Harness, Hook, Registry, Tool, ToolName, type Tx } from "@effectified/pi-durable";
import { answer, TestHarness, toolCall } from "@effectified/pi-durable/testing";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	Conversations,
	DeniedTool,
	Guard,
	InvalidPolicy,
	Matcher,
	Policy,
	ReservedExtension,
	Rule,
} from "../src/index.ts";
import { harnessOn, names, offering, tools } from "./guarded.ts";

const verbs = Matcher.firstWord(["approve", "sign", "export", "send", "delete"]);
const policy: Policy.Policy = { ...Policy.empty, denied: [verbs] };

const named = (name: string) =>
	Tool.make(name, {
		description: `The ${name} tool.`,
		parameters: Schema.Struct({}),
		success: Schema.String,
		handler: () => Effect.succeed("ran"),
	});

class Journal extends Context.Service<Journal, { readonly note: (text: string) => Effect.Effect<void> }>()(
	"test/Journal",
) {}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Builds the Layer and gives what it failed with. */
const failure = <E>(layer: Layer.Layer<Registry.Registry | Guard.Guard, E>) =>
	Effect.runPromise(Effect.flip(Effect.scoped(Layer.build(layer))));

describe("layer", () => {
	it("fails with DeniedTool for a tool under a denied verb, in snake case and in camel case", async () => {
		const { Search } = tools();
		const snake = await failure(
			Guard.layer({
				policy,
				extensions: [Extension.make({ name: "app", tools: [Search, named("approve_claim")] })],
			}),
		);
		expect(snake).toEqual(DeniedTool.make({ tool: ToolName.make("approve_claim"), extension: "app", rule: verbs }));
		expect(snake.message).toBe(
			"Tool approve_claim of extension app can never be registered: the policy denies the first word approve, sign, export, send, delete",
		);
		const camel = await failure(
			Guard.layer({
				policy,
				extensions: [
					Extension.make({ name: "app", tools: [Search] }),
					Extension.make({ name: "office", tools: [named("signDocument")] }),
				],
			}),
		);
		expect(camel).toEqual(DeniedTool.make({ tool: ToolName.make("signDocument"), extension: "office", rule: verbs }));
	});

	it("fails for every verb of the list, and builds when the verb is only part of a longer word", async () => {
		for (const name of ["export_pdf", "sendMail", "delete", "Approve", "SIGN_ALL"]) {
			const error = await failure(Guard.layer({ policy, extensions: [{ name: "app", tools: [named(name)] }] }));
			expect(error).toEqual(DeniedTool.make({ tool: ToolName.make(name), extension: "app", rule: verbs }));
		}
		const layer = Guard.layer({
			policy,
			extensions: [{ name: "app", tools: [named("signature_lookup"), named("resend_status")] }],
		});
		const built = await Effect.runPromise(
			Registry.Registry.use((registry) => Effect.succeed(registry.snapshot())).pipe(Effect.provide(layer)),
		);
		expect(built.tools().map(({ tool }) => tool.name)).toEqual(["signature_lookup", "resend_status"]);
	});

	it("fails with InvalidPolicy before it looks at a tool, and with ReservedExtension for the guard's own name", async () => {
		const invalid = await failure(
			Guard.layer({
				policy: { ...policy, toolCeilings: { search: "public" } },
				extensions: [{ name: "app", tools: [named("approve")] }],
			}),
		);
		expect(invalid).toEqual(
			InvalidPolicy.make({ reason: "The ceiling public of tool search is not a classification" }),
		);
		const reserved = await failure(Guard.layer({ policy, extensions: [{ name: "guard", tools: [] }] }));
		expect(reserved).toEqual(ReservedExtension.make({ extension: "guard" }));
		expect(reserved.message).toBe("The extension name guard is the guard's own");
	});

	it("installs the guard's extension first, then the program's in order, and provides the guard", async () => {
		const { Search, Read } = tools();
		const layer = Guard.layer({
			policy,
			extensions: [
				Extension.make({ name: "approvals", hooks: [Hook.afterResponse(() => Effect.void)] }),
				Extension.make({ name: "app", tools: [Search, Read] }),
			],
		});
		const built = await Effect.runPromise(
			Effect.gen(function* () {
				const guard = yield* Guard.Guard;
				const registry = yield* Registry.Registry;
				return { guard, snapshot: registry.snapshot() };
			}).pipe(Effect.provide(layer)),
		);
		expect(built.snapshot.installed().map((extension) => extension.name)).toEqual(["guard", "approvals", "app"]);
		expect(built.snapshot.installed()[0]?.hooks?.map((hook) => hook.task)).toEqual(["pi.tool", "pi.tool"]);
		expect(built.snapshot.tools().map(({ extension, tool }) => [extension.name, tool.name])).toEqual([
			["app", "search"],
			["app", "read"],
		]);
		// The guard holds the policy decoded, its names branded: equal to the one written.
		expect(built.guard.policy).toEqual(policy);
	});

	it("requires what the tools, the hooks and the rules need, and not the guard it gives them", () => {
		const { Search } = tools();
		const Noted = Rule.make("noted", Search, ({ text }) =>
			Journal.use((journal) => Effect.as(journal.note(text), Rule.allow)),
		);
		const Granting = Tool.make("granting", {
			description: "Needs the guard.",
			parameters: Schema.Struct({}),
			success: Schema.Number,
			handler: () => Guard.Guard.use((guard) => Effect.succeed(guard.policy.denied.length)),
		});
		const extensions = [Extension.make({ name: "app", tools: [Search, Granting] })] as const;
		const needsJournal = Guard.layer({ policy, rules: [Noted], extensions });
		const plain = Guard.layer({ policy, extensions });
		const requirements: Equal<Layer.Services<typeof needsJournal>, Journal> = true;
		const none: Equal<Layer.Services<typeof plain>, never> = true;
		type Failure = Layer.Error<typeof needsJournal>;
		// @ts-expect-error The registry's rule needs Journal, which nothing provides.
		const unprovided: Layer.Layer<Registry.Registry | Guard.Guard, Failure> = needsJournal;
		const provided: Layer.Layer<Registry.Registry | Guard.Guard, Failure> = needsJournal.pipe(
			Layer.provide(Layer.succeed(Journal, { note: () => Effect.void })),
		);
		expect([requirements, none]).toEqual([true, true]);
		expect([unprovided, provided, plain].every(Layer.isLayer)).toBe(true);
	});
});

describe("fromPolicy", () => {
	it("provides the guard of a policy without a registry, and fails for a policy that contradicts itself", async () => {
		const guard = await Effect.runPromise(
			Guard.Guard.use((service) => Effect.succeed(service)).pipe(Effect.provide(Guard.fromPolicy(policy))),
		);
		expect(guard.policy).toEqual(policy);
		const invalid = Guard.fromPolicy({ ...policy, toolCeilings: { search: "public" } });
		const error = await Effect.runPromise(Effect.flip(Effect.scoped(Layer.build(invalid))));
		expect(error).toEqual(
			InvalidPolicy.make({ reason: "The ceiling public of tool search is not a classification" }),
		);
		const needsNothing: Equal<Layer.Services<typeof invalid>, never> = true;
		expect(needsNothing).toBe(true);
	});
});

describe("registry", () => {
	it("checks the extensions against the policy of the guard it requires, and installs the guard's first", async () => {
		const { Search } = tools();
		const checked = Guard.registry({ extensions: [Extension.make({ name: "app", tools: [Search] })] });
		const requirements: Equal<Layer.Services<typeof checked>, Guard.Guard> = true;
		const provides: Equal<Layer.Success<typeof checked>, Registry.Registry> = true;
		expect([requirements, provides]).toEqual([true, true]);
		const installed = await Effect.runPromise(
			Registry.Registry.use((registry) => Effect.succeed(registry.snapshot().installed())).pipe(
				Effect.provide(checked),
				Effect.provide(Guard.fromPolicy(policy)),
			),
		);
		expect(installed.map((extension) => extension.name)).toEqual(["guard", "app"]);
		const denied = Guard.registry({ extensions: [{ name: "app", tools: [named("sign_off")] }] }).pipe(
			Layer.provide(Guard.fromPolicy(policy)),
		);
		expect(await Effect.runPromise(Effect.flip(Effect.scoped(Layer.build(denied))))).toEqual(
			DeniedTool.make({ tool: ToolName.make("sign_off"), extension: "app", rule: verbs }),
		);
		const reserved = Guard.registry({ extensions: [{ name: "guard", tools: [] }] }).pipe(
			Layer.provide(Guard.fromPolicy(policy)),
		);
		expect(await Effect.runPromise(Effect.flip(Effect.scoped(Layer.build(reserved))))).toEqual(
			ReservedExtension.make({ extension: "guard" }),
		);
	});
});

// The product's case: a port its subagent tools need, which grants a child through the guard in the creating commit.
class ChildSetup extends Context.Service<
	ChildSetup,
	{ readonly created: (tx: Tx.Tx, child: ConversationId) => Effect.Effect<void, Conversations.GrantError> }
>()("test/ChildSetup") {}

describe("a service that requires the guard, required by a tool of the registry the guard checks", () => {
	/** The registry of that product, built without a `Deferred`, and what its parts saw. */
	const composed = () => {
		const { ran, Search } = tools();
		const held: Guard.Service[] = [];
		const children: ConversationId[] = [];
		// As the subagent README builds its port: the guard is read when the Layer is built, before any registry.
		const Setup = Layer.effect(
			ChildSetup,
			Effect.gen(function* () {
				const guard = yield* Guard.Guard;
				held.push(guard);
				return {
					created: (tx, child) =>
						Conversations.grantIn(tx, child, { tools: names("search") }).pipe(
							Effect.provideService(Guard.Guard, guard),
						),
				};
			}),
		);
		const Spawn = Tool.make("spawn", {
			description: "Delegates a task to a child conversation.",
			parameters: Schema.Struct({ task: Schema.String }),
			success: Schema.String,
			handler: ({ task }, api) =>
				Effect.gen(function* () {
					const setup = yield* ChildSetup;
					const child = yield* api.commit((tx) =>
						Effect.gen(function* () {
							const made = yield* tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
							yield* setup.created(tx, made.id);
							return made.id;
						}),
					);
					children.push(child);
					const handle = Option.getOrThrow(yield* api.conversation(child));
					const submission = yield* handle.submit({ type: "input", content: task, requestId: "spawned" });
					return (yield* submission.wait).status;
				}),
		});
		const guard = Guard.fromPolicy(Policy.empty);
		const registry = Guard.registry({ extensions: [Extension.make({ name: "app", tools: [Search, Spawn] })] }).pipe(
			Layer.provide(Setup),
			Layer.provideMerge(guard),
		);
		return { ran, held, children, Setup, Spawn, guard, registry };
	};

	it("type checks, needs nothing more, and has no cycle", () => {
		const { Setup, Spawn, guard, registry } = composed();
		const needsNothing: Equal<Layer.Services<typeof registry>, never> = true;
		const provides: Equal<Layer.Success<typeof registry>, Registry.Registry | Guard.Guard> = true;
		// The port needs the guard, the registry needs the port and the guard, and one Layer provides the guard to both.
		const port: Equal<Layer.Services<typeof Setup>, Guard.Guard> = true;
		const before = Guard.registry({ extensions: [Extension.make({ name: "app", tools: [Spawn] })] });
		const both: Equal<Layer.Services<typeof before>, Guard.Guard | ChildSetup> = true;
		// `Guard.layer` gives the guard only with its registry, so the port's requirement stays open: the cycle.
		const cyclic = Guard.layer({
			policy: Policy.empty,
			extensions: [Extension.make({ name: "app", tools: [Spawn] })],
		});
		const open: Equal<Layer.Services<typeof cyclic>, ChildSetup> = true;
		const provided = cyclic.pipe(Layer.provide(Setup));
		const stillOpen: Equal<Layer.Services<typeof provided>, Guard.Guard> = true;
		expect([needsNothing, provides, port, both, open, stillOpen]).toEqual([true, true, true, true, true, true]);
		expect([guard, registry, provided].every(Layer.isLayer)).toBe(true);
	});

	it("grants a child in its creating commit with the guard the registry was checked by", async () => {
		const { ran, held, children, registry } = composed();
		const offered: string[][] = [];
		const layer = harnessOn(registry, {
			responses: [
				toolCall("spawn", { task: "Search c." }, { id: "call-1" }),
				toolCall("search", { text: "c" }, { id: "call-2" }),
				offering(offered, "The child is done."),
				answer("The parent is done."),
			],
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { model } = yield* TestHarness.agent;
				const parent = yield* Conversations.create({
					ownership: { kind: "ownerless" },
					grant: { tools: names("spawn") },
					model,
				});
				yield* parent.prompt("Delegate.");
				yield* parent.waitForIdle;
				return {
					same: (yield* Guard.Guard) === held[0],
					built: held.length,
					granted: yield* Conversations.granted(children[0] as ConversationId),
				};
			}).pipe(Effect.provide(layer)),
		);
		expect(seen).toEqual({ same: true, built: 1, granted: { tools: names("search") } });
		expect(offered).toEqual([["search"]]);
		expect(ran).toEqual(["search:c"]);
	});

	it("refuses the grant, so no child exists, when the port was given a second guard", async () => {
		const { children, Spawn } = composed();
		// Two Layer values are two guards: the port's built no registry.
		const Setup = Layer.succeed(ChildSetup, {
			created: (tx, child) =>
				Conversations.grantIn(tx, child, { tools: names("search") }).pipe(
					Effect.provide(Layer.orDie(Guard.fromPolicy(Policy.empty))),
				),
		});
		const registry = Guard.registry({ extensions: [Extension.make({ name: "app", tools: [Spawn] })] }).pipe(
			Layer.provide(Setup),
			Layer.provideMerge(Guard.fromPolicy(Policy.empty)),
		);
		const layer = harnessOn(registry, {
			responses: [toolCall("spawn", { task: "Search c." }, { id: "call-1" }), answer("It failed.")],
		});
		const owned = await Effect.runPromise(
			Effect.gen(function* () {
				const { model } = yield* TestHarness.agent;
				const parent = yield* Conversations.create({
					ownership: { kind: "ownerless" },
					grant: { tools: names("spawn") },
					model,
				});
				yield* parent.prompt("Delegate.");
				yield* parent.waitForIdle;
				return yield* Harness.commit((tx) => tx.scanConversations({ ownerConversationId: parent.id }, 10));
			}).pipe(Effect.provide(layer)),
		);
		expect(children).toEqual([]);
		expect(owned.items).toEqual([]);
	});
});

describe("a registry built the ordinary way", () => {
	it("gives no guard: a grant on it does not type check until a guard is provided", () => {
		const { Search } = tools();
		const ordinary = Registry.layer([Extension.make({ name: "app", tools: [Search] })]);
		const granting = Harness.commit((tx) =>
			Conversations.grantIn(tx, 1 as ConversationId, { tools: names("search") }),
		);
		const needs: Equal<Effect.Services<typeof granting>, Guard.Guard | Harness.Harness> = true;
		const gives: Equal<Layer.Success<typeof ordinary>, Registry.Registry> = true;
		// @ts-expect-error The ordinary registry provides no `Guard`, which the grant requires.
		const unprovided: Effect.Effect<void, unknown, Harness.Harness> = granting.pipe(Effect.provide(ordinary));
		// With a guard beside it the program type checks, and every grant fails with `Unguarded` when it runs: see
		// "a guard that built no registry" in conversations.test.ts.
		const beside: Effect.Effect<void, unknown, Harness.Harness> = granting.pipe(
			Effect.provide(Layer.merge(ordinary, Guard.fromPolicy(policy))),
		);
		expect([needs, gives]).toEqual([true, true]);
		expect([unprovided, beside].every(Effect.isEffect)).toBe(true);
	});
});
