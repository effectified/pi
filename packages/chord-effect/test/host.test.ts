import { Effect, Exit, Fiber, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	constant,
	defineFacet,
	defineRegistry,
	Host,
	hostKind,
	keyedEntries,
	Link,
	local,
	method,
	obj,
	Reference,
	remote,
	str,
} from "../src/index.ts";
import { run } from "./run.ts";

const Greeter = local("example.greeter", {
	version: 1,
	params: { language: str() },
	members: { language: str(), greet: method(obj({ name: str() }), str()) },
});

const greeter = defineFacet((host) => {
	host.serve(Greeter, ({ language }) => ({
		language: constant(language),
		greet: async ({ name }) => `${language === "de" ? "Hallo" : "Hello"} ${name}`,
	}));
});

const plugins = [{ name: "@example/greeter", facet: greeter }];

class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", {}) {}

describe("Host.make", () => {
	it("gives references released with their scope, and closes the host with its own", async () => {
		const [greeting, afterHost] = await run(
			Effect.gen(function* () {
				const reference = yield* Effect.scoped(
					Effect.gen(function* () {
						const host = yield* Host.make({});
						yield* host.load(plugins);
						const german = yield* host.get(Greeter, { language: "de" });
						return [german, yield* Reference.call(german.greet, { name: "Mario" })] as const;
					}),
				);
				return [reference[1], yield* Effect.exit(Reference.call(reference[0].greet, { name: "Luigi" }))] as const;
			}),
		);
		expect(greeting).toBe("Hallo Mario");
		expect(afterHost).toMatchObject(Exit.fail({ _tag: "ChordFailed", code: "released" }));
	});

	it("fails a get before load as Chord's not_ready", async () => {
		const exit = await run(
			Effect.exit(Effect.flatMap(Host.make({}), (host) => host.get(Greeter, { language: "en" }))),
		);
		expect(exit).toMatchObject(Exit.fail({ _tag: "ChordFailed", code: "not_ready" }));
	});

	it("holds a reference at once and follows it to live", async () => {
		const states = await run(
			Effect.gen(function* () {
				const host = yield* Host.make({});
				yield* host.load(plugins);
				const held = yield* host.hold(Greeter, { language: "en" });
				return yield* Stream.runCollect(Stream.takeUntil(Reference.state(held), (state) => state.kind === "live"));
			}),
		);
		expect(states.at(-1)?.kind).toBe("live");
	});

	it("publishes its background errors on errors", async () => {
		const Broken = local("example.broken", { version: 1, params: {}, members: { name: str() } });
		const broken = defineFacet((host) => {
			host.serve(Broken, () => {
				throw new Error("no factory today");
			});
		});
		const error = await run(
			Effect.gen(function* () {
				const host = yield* Host.make({});
				const first = yield* Effect.forkChild(Stream.runHead(host.errors), { startImmediately: true });
				yield* host.load([{ name: "@example/broken", facet: broken }]);
				return yield* Fiber.join(first);
			}),
		);
		expect(error).toMatchObject({ _tag: "Some", value: { kind: "activation_failed" } });
	});

	it("streams the references to a type and the host's activity", async () => {
		const [references, activity] = await run(
			Effect.gen(function* () {
				const host = yield* Host.make({});
				yield* host.load(plugins);
				yield* host.get(Greeter, { language: "en" });
				return [yield* Stream.runHead(host.references(Greeter)), yield* Stream.runHead(host.activity)] as const;
			}),
		);
		expect(references).toMatchObject({ _tag: "Some", value: [{ params: { language: "en" } }] });
		expect(activity._tag).toBe("Some");
	});

	it("gives a registry's composed value", async () => {
		type Routes = { readonly routes: Readonly<Record<string, string>> };
		const Http = defineRegistry<Routes, ReadonlyMap<string, { readonly value: string }>>("example.http", {
			version: 1,
		});
		const provider = defineFacet((host) => {
			host.serve(Http, { compose: (table, { report }) => keyedEntries(table, (entry) => entry.routes, report) });
		});
		const notes = defineFacet((_, self) => {
			self.contribute(Http, { routes: { "/notes": "notes" } });
		});
		const routes = await run(
			Effect.gen(function* () {
				const host = yield* Host.make({});
				yield* host.load([
					{ name: "@example/http", facet: provider },
					{ name: "@example/notes", facet: notes },
				]);
				const router = yield* host.registry(Http);
				return [...router.value.keys()];
			}),
		);
		expect(routes).toEqual(["/notes"]);
	});

	it("runs a root scope's body as an Effect, its own failure the Effect's", async () => {
		const [greeting, failed] = await run(
			Effect.gen(function* () {
				const host = yield* Host.make({});
				yield* host.load(plugins);
				const greeting = yield* host.root((ctx) =>
					Effect.flatMap(
						Effect.promise(() => ctx.get(Greeter, { language: "en" })),
						(english) => Reference.call(english.greet, { name: "Ada" }),
					),
				);
				const failed = yield* Effect.exit(host.root(() => Effect.fail(new Unavailable())));
				return [greeting, failed] as const;
			}),
		);
		expect(greeting).toBe("Hello Ada");
		expect(failed).toEqual(Exit.fail(new Unavailable()));
	});

	it("fails the host data calls of a host without a store as Chord's invalid/args", async () => {
		const exit = await run(
			Effect.exit(
				Effect.flatMap(Host.make({}), (host) =>
					host.deleteHostData({ kind: "session", params: {}, key: "session|S1" }),
				),
			),
		);
		expect(exit).toMatchObject(Exit.fail({ _tag: "ChordFailed", code: "invalid", reason: "args" }));
	});
});

describe("Host.accept, Host.connect and Host.route", () => {
	type P = { readonly kind: "server" } | { readonly kind: "guest" };
	const Server = hostKind("server");
	const Notes = remote("example.notes", {
		version: 1,
		params: {},
		hostAddress: () => Server(),
		variants: { reader: { state: { title: str() } } },
	});
	const notes = defineFacet<P>((host) => {
		host.serve(Notes, () => ({ variant: "reader", members: { title: constant("Notes") } }));
	});

	it("serves a remote type to a client over a memory link", async () => {
		const title = await run(
			Effect.gen(function* () {
				const server = yield* Host.make<P>({ address: Server(), principal: { kind: "server" } });
				yield* server.load([{ name: "@example/notes", facet: notes }]);
				const [up, down] = yield* Link.memoryPair;
				yield* server.accept(up, { principal: { kind: "guest" } });
				const client = yield* Host.make<P>({});
				yield* client.connect(down, { principal: { kind: "server" } });
				yield* client.load([]);
				const reference = yield* client.get(Notes, {});
				return reference.title.value;
			}),
		);
		expect(title).toBe("Notes");
	});

	it("reaches a host of a kind through a route whose resolve is an Effect", async () => {
		const title = await run(
			Effect.gen(function* () {
				const server = yield* Host.make<P>({ address: Server(), principal: { kind: "server" } });
				yield* server.load([{ name: "@example/notes", facet: notes }]);
				const client = yield* Host.make<P>({ principal: { kind: "guest" } });
				yield* client.route(Server, {
					authorize: () => true,
					resolve: () =>
						Effect.gen(function* () {
							const [up, down] = yield* Link.memoryPair;
							yield* server.accept(up, { principal: { kind: "guest" } });
							return { link: down, principal: { kind: "server" } as const };
						}),
				});
				yield* client.load([]);
				const reference = yield* client.get(Notes, {});
				return reference.title.value;
			}),
		);
		expect(title).toBe("Notes");
	});
});
