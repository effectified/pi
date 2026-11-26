import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
	Client,
	constant,
	defineFacet,
	Host,
	Link,
	local,
	str,
	themesFacet,
	translationsFacet,
	WebScripts,
} from "../src/index.ts";
import { run } from "./run.ts";

describe("Client.environment", () => {
	it("runs the loop's timers and clock on the Clock", async () => {
		const [fired, cancelled, now] = await run(
			Effect.gen(function* () {
				const environment = yield* Client.environment;
				let fired = false;
				let cancelled = false;
				environment.after(1_000, () => {
					fired = true;
				});
				const cancel = environment.after(1_000, () => {
					cancelled = true;
				});
				cancel();
				yield* TestClock.adjust("1 second");
				return [fired, cancelled, environment.now()] as const;
			}),
		);
		expect(fired).toBe(true);
		expect(cancelled).toBe(false);
		expect(now).toBe(1_000);
	});
});

describe("Client.keepConnected", () => {
	it("gives the loop's states and gives up an attempt that does not open, on the Clock", async () => {
		const states = await run(
			Effect.gen(function* () {
				let closed = 0;
				const watching = yield* Effect.gen(function* () {
					const states = yield* Client.keepConnected({
						// A socket that never opens; closing it ends it at once, as a loop link does.
						open: () =>
							Effect.sync(() => {
								let listener = () => {};
								return {
									onClose: (closedListener: () => void) => {
										listener = closedListener;
									},
									close: () => {
										closed++;
										listener();
									},
								};
							}),
						canRetry: Effect.succeed(true),
					});
					return yield* Effect.forkChild(Stream.runCollect(Stream.take(states, 2)), { startImmediately: true });
				});
				yield* TestClock.adjust("20 seconds");
				const states = yield* Fiber.join(watching);
				return [states, closed] as const;
			}),
		);
		expect(states[0]).toEqual(["connecting", "waiting"]);
		expect(states[1]).toBe(1);
	});
});

describe("Client.start", () => {
	const Hello = local("example.hello", { version: 1, params: {}, members: { text: str() } });
	const hello = defineFacet((host) => {
		host.serve(Hello, () => ({ text: constant("hello") }));
	});

	it("starts a client host with its core facets, before the server answers", async () => {
		const text = await run(
			Effect.gen(function* () {
				const client = yield* Client.start({
					scripts: WebScripts,
					base: "base",
					initial: [],
					modules: {},
					core: [{ name: "@example/hello", facet: hello }],
					follow: false,
					open: () => Effect.map(Link.memoryPair, ([link]) => link).pipe(Effect.scoped),
					fetchScript: () => Effect.die("no scripts"),
					serverBase: Effect.succeed(undefined),
					outdated: Effect.void,
				});
				const reference = yield* client.host.get(Hello, {});
				return reference.text.value;
			}),
		);
		expect(text).toBe("hello");
	});
});

describe("Client.activeTheme, activeLanguage and hostLanguage", () => {
	const host = Effect.gen(function* () {
		const opened = yield* Host.make({});
		yield* opened.load([
			{ name: "@chord/themes", facet: themesFacet() },
			{ name: "@chord/translations", facet: translationsFacet() },
		]);
		return opened;
	});

	it("follows the active theme for a mode", async () => {
		const theme = await run(Effect.flatMap(host, (opened) => Stream.runHead(Client.activeTheme(opened, "dark"))));
		expect(theme).toMatchObject({ _tag: "Some", value: { mode: "dark" } });
	});

	it("follows the active language and sets it as the host's", async () => {
		const [language, set] = await run(
			Effect.gen(function* () {
				const opened = yield* host;
				const language = yield* Stream.runHead(Client.activeLanguage(opened, ["de"]));
				return [language, yield* Stream.runHead(Client.hostLanguage(opened))] as const;
			}),
		);
		expect(language._tag).toBe("Some");
		expect(set._tag === "Some" && set.value !== undefined).toBe(true);
	});

	it("sets the host's language", async () => {
		const language = await run(
			Effect.gen(function* () {
				const opened = yield* host;
				yield* Client.setHostLanguage(opened, undefined);
				return yield* Stream.runHead(Client.hostLanguage(opened));
			}),
		);
		expect(language).toMatchObject({ _tag: "Some", value: undefined });
	});
});
