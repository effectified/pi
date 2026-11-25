import { Registry, SchemaConversionError } from "@gunta/pi-durable-effect";
import { Effect, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as Declared from "../src/declared.ts";
import { ChildSetup, Subagents, UnknownSubagent } from "../src/index.ts";
import { worker } from "./scene.ts";

const limits = { maxDepth: 1, maxLive: 1 };

/** What building a registry with the extension for `subagents` fails with. */
const refused = (subagents: Subagents.Config["subagents"]) =>
	Effect.runPromise(
		Effect.flip(
			Layer.build(Registry.layer([Subagents.extension({ ...limits, subagents })])).pipe(
				Effect.provide(ChildSetup.none),
				Effect.scoped,
			),
		),
	);

describe("Declared.make", () => {
	it("makes each declaration ready under its name, with its result compiled and its corrections decided", async () => {
		const typed = worker("typed", { result: Schema.Struct({ ok: Schema.Boolean }), corrections: 5 });
		const declared = await Effect.runPromise(Declared.make({ ...limits, subagents: [worker("plain"), typed] }));
		expect([...declared.entries.keys()]).toEqual(["plain", "typed"]);
		const plain = declared.entries.get("plain");
		const withResult = declared.entries.get("typed");
		expect([plain?.corrections, Option.isNone(plain?.typed ?? Option.none())]).toEqual([2, true]);
		expect([withResult?.corrections, Option.isSome(withResult?.typed ?? Option.none())]).toEqual([5, true]);
	});

	it("finds a declaration by name, and fails with the names there are otherwise", async () => {
		const declared = await Effect.runPromise(Declared.make({ ...limits, subagents: [worker("plain")] }));
		const found = await Effect.runPromise(Declared.find(declared, "plain"));
		const missing = await Effect.runPromise(Effect.flip(Declared.find(declared, "other")));
		expect(found.subagent.name).toBe("plain");
		expect(missing).toEqual(new UnknownSubagent({ subagent: "other", declared: ["plain"] }));
	});
});

describe("a registry with declarations that cannot work", () => {
	it("does not build when two subagents share a name", async () => {
		const failed = await refused([worker("twin"), worker("twin")]);
		expect(failed).toEqual(new SchemaConversionError({ reason: "Two subagents are named twin" }));
	});

	it("does not build when a declared result has no JSON Schema", async () => {
		const failed = await refused([worker("odd", { result: Schema.Struct({ [Symbol.for("key")]: Schema.String }) })]);
		expect(failed).toBeInstanceOf(SchemaConversionError);
		expect(failed.reason).toContain("Subagent odd: its result has no JSON Schema");
	});
});
