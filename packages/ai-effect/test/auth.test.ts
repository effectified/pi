// The auth members of Models as Effects, against pi-ai itself: the Radius provider's OAuth device login and token
// refresh on a loopback gateway, and an API key auth read from the stored credential or from Config.

import { ConfigProvider, Deferred, Effect, Exit, Fiber, Layer, Option, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	AuthError,
	type AuthEvent,
	Credentials,
	checkAuth,
	createProvider,
	envApiKeyAuth,
	getAllAvailable,
	getAuth,
	getAvailable,
	getAvailableOfType,
	type LoginInteraction,
	login,
	logout,
	Models,
	type Provider,
	ProviderAuthContext,
	ProviderId,
	type RedactedOAuthCredential,
	refreshModels,
} from "../src/index.ts";
import { radiusProvider } from "../src/providers/radius.ts";
import { fauxProvider, runLive } from "../src/testing/index.ts";
import { gateway } from "./gateway.ts";

class Cancelled extends Schema.TaggedError<Cancelled, { readonly brand: unique symbol }>()("Cancelled", {}) {}

const RADIUS = ProviderId.make("radius");
const KEYED = ProviderId.make("keyed");
const FAUX = ProviderId.make("faux");

/** A provider with pi-ai's standard API key auth on `TEST_KEY`, and a login that prompts for the key. */
const keyed: Provider = createProvider({
	id: "keyed",
	auth: { apiKey: envApiKeyAuth("Test key", ["TEST_KEY"]) },
	models: [],
	api: { stream: fauxProvider().provider.stream, streamSimple: fauxProvider().provider.streamSimple },
});

/** A collection of `providers` with memory credentials and the environment `env`. */
function layer(providers: ReadonlyArray<Provider>, env: Record<string, string> = {}) {
	return Models.layerWithAuth([...providers]).pipe(
		Layer.provideMerge(Layer.mergeAll(Credentials.layerMemory, ProviderAuthContext.layer)),
		Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
	);
}

/** An interaction that answers prompts in order and records what the flow told the user. */
function scripted(answers: ReadonlyArray<string>): { interaction: LoginInteraction; events: AuthEvent[] } {
	const queue = [...answers];
	const events: AuthEvent[] = [];
	return {
		events,
		interaction: {
			prompt: () => Effect.sync(() => queue.shift() ?? ""),
			notify: (event) => Effect.sync(() => void events.push(event)),
		},
	};
}

describe("login", () => {
	it("runs a provider's OAuth device login and stores the credential, its tokens redacted", async () => {
		const result = await runLive(
			Effect.gen(function* () {
				const server = yield* gateway;
				const { interaction, events } = scripted(["device-code"]);
				return yield* Effect.gen(function* () {
					const credential = yield* login(RADIUS, "oauth", interaction);
					const stored = yield* (yield* Credentials).read(RADIUS);
					const auth = yield* getAuth(RADIUS);
					return {
						credential,
						stored,
						auth,
						events,
						grants: server.tokenRequests.map((form) => form.get("grant_type")),
					};
				}).pipe(Effect.provide(layer([radiusProvider({ gateway: server.origin })])));
			}),
		);
		const credential = result.credential as RedactedOAuthCredential;
		expect(credential.type).toBe("oauth");
		expect(Redacted.isRedacted(credential.access)).toBe(true);
		expect(Redacted.value(credential.access)).toBe("access-1");
		expect(String(credential.access)).not.toContain("access-1");
		expect(Option.map(result.stored, (stored) => stored.type)).toEqual(Option.some("oauth"));
		const auth = Option.getOrThrow(result.auth);
		expect(auth.source).toBe("OAuth");
		expect(auth.auth.apiKey === undefined ? undefined : Redacted.value(auth.auth.apiKey)).toBe("access-1");
		expect(result.events.map((event) => event.type)).toEqual(["device_code"]);
		expect(result.grants).toEqual(["urn:ietf:params:oauth:grant-type:device_code"]);
	});

	it("fails with AuthError, reason login, when the provider's flow fails, and stores nothing", async () => {
		const result = await runLive(
			Effect.gen(function* () {
				const server = yield* gateway;
				server.deviceError = "access_denied";
				return yield* Effect.gen(function* () {
					const failure = yield* Effect.flip(login(RADIUS, "oauth", scripted(["device-code"]).interaction));
					return { failure, stored: yield* (yield* Credentials).list };
				}).pipe(Effect.provide(layer([radiusProvider({ gateway: server.origin })])));
			}),
		);
		expect(result.failure).toBeInstanceOf(AuthError);
		expect(result.failure).toMatchObject({ reason: "login", message: "Device authorization was denied." });
		expect(result.stored).toEqual([]);
	});

	it("fails with the interaction's own failure when a prompt fails", async () => {
		const failure = await runLive(
			Effect.flip(
				login(KEYED, "api_key", { prompt: () => Effect.fail(new Cancelled()), notify: () => Effect.void }),
			).pipe(Effect.provide(layer([keyed]))),
		);
		expect(failure).toBeInstanceOf(Cancelled);
	});

	it("interrupts the prompt when the login is interrupted", async () => {
		const interrupted = await runLive(
			Effect.gen(function* () {
				const asked = yield* Deferred.make<void>();
				const stopped = yield* Deferred.make<void>();
				const fiber = yield* Effect.forkChild(
					login(KEYED, "api_key", {
						prompt: () =>
							Effect.andThen(Deferred.succeed(asked, undefined), Effect.never).pipe(
								Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
							),
						notify: () => Effect.void,
					}),
					{ startImmediately: true },
				);
				yield* Deferred.await(asked);
				yield* Fiber.interrupt(fiber);
				const exit = yield* Fiber.await(fiber);
				yield* Deferred.await(stopped);
				return Exit.hasInterrupts(exit);
			}).pipe(Effect.provide(layer([keyed]))),
		);
		expect(interrupted).toBe(true);
	});

	it("fails with AuthError, reason provider, for an unknown provider", async () => {
		const failure = await runLive(
			Effect.flip(login(ProviderId.make("missing"), "oauth", scripted([]).interaction)).pipe(
				Effect.provide(layer([])),
			),
		);
		expect(failure).toMatchObject({ _tag: "AuthError", reason: "provider" });
	});
});

describe("getAuth", () => {
	it("prefers the stored key, then reads the environment through Config, and logout removes the stored key", async () => {
		const result = await runLive(
			Effect.gen(function* () {
				const before = yield* getAuth(KEYED);
				yield* login(KEYED, "api_key", scripted(["stored-key"]).interaction);
				const stored = yield* getAuth(KEYED);
				yield* logout(KEYED);
				const after = yield* getAuth(KEYED);
				return { before, stored, after };
			}).pipe(Effect.provide(layer([keyed], { TEST_KEY: "env-key" }))),
		);
		const reveal = (auth: typeof result.before) =>
			Option.map(auth, (resolved) => ({
				source: resolved.source,
				key: resolved.auth.apiKey === undefined ? undefined : Redacted.value(resolved.auth.apiKey),
			}));
		expect(reveal(result.before)).toEqual(Option.some({ source: "TEST_KEY", key: "env-key" }));
		expect(reveal(result.stored)).toEqual(Option.some({ source: "stored credential", key: "stored-key" }));
		expect(reveal(result.after)).toEqual(Option.some({ source: "TEST_KEY", key: "env-key" }));
	});

	it("is none for an unconfigured provider, where the environment has only a blank value", async () => {
		const auth = await runLive(getAuth(KEYED).pipe(Effect.provide(layer([keyed], { TEST_KEY: "  " }))));
		expect(auth).toEqual(Option.none());
	});

	it("takes a key of its own, redacted", async () => {
		const auth = await runLive(
			getAuth(KEYED, { apiKey: Redacted.make("override") }).pipe(Effect.provide(layer([keyed]))),
		);
		expect(Option.map(auth, (resolved) => resolved.auth.apiKey && Redacted.value(resolved.auth.apiKey))).toEqual(
			Option.some("override"),
		);
	});

	it("refreshes an expired OAuth token inside the store and keeps the new one", async () => {
		const result = await runLive(
			Effect.gen(function* () {
				const server = yield* gateway;
				return yield* Effect.gen(function* () {
					const credentials = yield* Credentials;
					yield* credentials.modify(RADIUS, () =>
						Effect.succeed(
							Option.some({
								type: "oauth" as const,
								access: Redacted.make("old-access"),
								refresh: Redacted.make("refresh-0"),
								expires: 0,
							}),
						),
					);
					const auth = yield* getAuth(RADIUS);
					const stored = yield* credentials.read(RADIUS);
					return { auth, stored, refreshed: server.tokenRequests.map((form) => form.get("refresh_token")) };
				}).pipe(Effect.provide(layer([radiusProvider({ gateway: server.origin })])));
			}),
		);
		expect(Option.map(result.auth, (auth) => auth.auth.apiKey && Redacted.value(auth.auth.apiKey))).toEqual(
			Option.some("access-1"),
		);
		const stored = Option.getOrThrow(result.stored) as RedactedOAuthCredential;
		expect(Redacted.value(stored.refresh)).toBe("refresh-1");
		expect(result.refreshed).toEqual(["refresh-0"]);
	});

	it("fails with AuthError, reason oauth, when the refresh fails, and keeps the stored credential", async () => {
		const result = await runLive(
			Effect.gen(function* () {
				const server = yield* gateway;
				return yield* Effect.gen(function* () {
					const credentials = yield* Credentials;
					yield* credentials.modify(RADIUS, () =>
						Effect.succeed(
							Option.some({
								type: "oauth" as const,
								access: Redacted.make("a"),
								refresh: Redacted.make("bad"),
								expires: 0,
							}),
						),
					);
					const failure = yield* Effect.flip(getAuth(RADIUS));
					return { failure, stored: yield* credentials.read(RADIUS) };
				}).pipe(Effect.provide(layer([radiusProvider({ gateway: server.origin })])));
			}),
		);
		expect(result.failure).toMatchObject({ _tag: "AuthError", reason: "oauth" });
		expect(Option.isSome(result.stored)).toBe(true);
	});
});

describe("checkAuth and getAvailable", () => {
	it("say which providers are configured, and list only their models", async () => {
		const faux = fauxProvider({ provider: "faux", models: [{ id: "f" }] });
		const result = await runLive(
			Effect.gen(function* () {
				return {
					keyed: yield* checkAuth(KEYED),
					faux: yield* checkAuth(FAUX),
					available: (yield* getAvailable()).map((model) => model.id),
					ofType: (yield* getAvailableOfType("chat", FAUX)).map((model) => model.id),
					all: (yield* getAllAvailable(KEYED)).length,
				};
			}).pipe(Effect.provide(layer([keyed, faux.provider]))),
		);
		expect(result).toEqual({
			keyed: Option.none(),
			faux: Option.some({ type: "api_key", source: undefined }),
			available: ["f"],
			ofType: ["f"],
			all: 0,
		});
	});
});

describe("refreshModels", () => {
	it("fetches the catalog of a configured provider with its credential", async () => {
		const result = await runLive(
			Effect.gen(function* () {
				const server = yield* gateway;
				return yield* Effect.gen(function* () {
					yield* login(RADIUS, "oauth", scripted(["device-code"]).interaction);
					const refreshed = yield* refreshModels({ allowNetwork: true });
					const models = yield* Models.use((models) => Effect.succeed(models.getModels(RADIUS)));
					return { refreshed, models: models.map((model) => model.id), seen: server.configAuthorizations };
				}).pipe(Effect.provide(layer([radiusProvider({ gateway: server.origin })])));
			}),
		);
		expect(result.refreshed).toEqual({ aborted: false, errors: new Map() });
		expect(result.models).toEqual(["gateway-model"]);
		expect(result.seen).toEqual(["Bearer access-1"]);
	});
});
