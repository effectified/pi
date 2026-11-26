import { Context, Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { runner } from "../src/runner.ts";

class Name extends Context.Service<Name, string>()("test/Name") {}

class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

const run = runner(Context.make(Name, "pi"));

describe("runner", () => {
	it("runs an Effect with the services it was given and resolves with its value", async () => {
		await expect(run(Effect.map(Name, (name) => `hello ${name}`))).resolves.toBe("hello pi");
	});

	it("rejects with the failure itself when it has a message", async () => {
		await expect(run(Effect.fail(new Error("broken")))).rejects.toThrow("broken");
	});

	it("rejects with a formatted error when the failure's own message is empty", async () => {
		await expect(run(Effect.fail(new Refused()))).rejects.toThrow("Refused");
	});

	it("interrupts the fiber when Pi's signal aborts", async () => {
		const controller = new AbortController();
		const pending = run(Effect.never, controller.signal);
		controller.abort();
		await expect(pending).rejects.toBeDefined();
	});
});
