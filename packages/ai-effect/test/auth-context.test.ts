// The ambient part of auth: environment variables through Config, files through pi-ai's default.

import { ConfigProvider, Effect, Option, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { toPiAuthContext } from "../src/auth-context.ts";
import { ProviderAuthContext } from "../src/index.ts";
import { currentRunner } from "../src/run-in-pi.ts";
import { runTest } from "../src/testing/index.ts";

const ENV = ConfigProvider.layer(ConfigProvider.fromUnknown({ SET: "value", BLANK: " " }));

describe("ProviderAuthContext.layer", () => {
	it("reads the environment through Config, redacted, a blank value as unset", async () => {
		const result = await runTest(
			Effect.gen(function* () {
				const context = yield* ProviderAuthContext;
				return {
					set: Option.map(yield* context.env("SET"), Redacted.value),
					redacted: Option.map(yield* context.env("SET"), String),
					blank: yield* context.env("BLANK"),
					missing: yield* context.env("MISSING"),
				};
			}).pipe(Effect.provide(ProviderAuthContext.layer), Effect.provide(ENV)),
		);
		expect(result.set).toEqual(Option.some("value"));
		expect(result.redacted).not.toEqual(Option.some("value"));
		expect(result.blank).toEqual(Option.none());
		expect(result.missing).toEqual(Option.none());
	});

	it("checks files with pi-ai's default", async () => {
		const result = await runTest(
			Effect.gen(function* () {
				const context = yield* ProviderAuthContext;
				return [
					yield* context.fileExists(new URL(import.meta.url).pathname),
					yield* context.fileExists("/no/such/file"),
				];
			}).pipe(Effect.provide(ProviderAuthContext.layer)),
		);
		expect(result).toEqual([true, false]);
	});
});

describe("toPiAuthContext", () => {
	it("gives pi-ai the values in the clear", async () => {
		const result = await runTest(
			Effect.gen(function* () {
				const pi = toPiAuthContext(yield* ProviderAuthContext, yield* currentRunner<never>());
				return yield* Effect.promise(async () => [await pi.env("SET"), await pi.env("MISSING")]);
			}).pipe(Effect.provide(ProviderAuthContext.layer), Effect.provide(ENV)),
		);
		expect(result).toEqual(["value", undefined]);
	});
});
