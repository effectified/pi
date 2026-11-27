import { Registry, SchemaConversionError } from "@effectified/pi-durable";
import { Effect, HashMap, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as Declared from "../src/declared.ts";
import { ChildSetup, Subagent, Subagents, UnknownSubagent } from "../src/index.ts";
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
		expect(HashMap.size(declared.entries)).toBe(2);
		const plain = Option.getOrThrow(HashMap.get(declared.entries, Subagent.Name.make("plain")));
		const withResult = Option.getOrThrow(HashMap.get(declared.entries, Subagent.Name.make("typed")));
		expect([plain.corrections, Option.isNone(plain.typed)]).toEqual([2, true]);
		expect([withResult.corrections, Option.isSome(withResult.typed)]).toEqual([5, true]);
	});

	it("finds a declaration by name, and fails with the names there are, in order, otherwise", async () => {
		const subagents = [worker("plain"), worker("other")];
		const declared = await Effect.runPromise(Declared.make({ ...limits, subagents }));
		const found = await Effect.runPromise(Declared.find(declared, Subagent.Name.make("plain")));
		const missing = await Effect.runPromise(Effect.flip(Declared.find(declared, Subagent.Name.make("third"))));
		expect(found.subagent.name).toBe("plain");
		expect(missing).toEqual(
			UnknownSubagent.make({
				subagent: Subagent.Name.make("third"),
				declared: [Subagent.Name.make("plain"), Subagent.Name.make("other")],
			}),
		);
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

	it("does not build with a limit that is not a whole number of 0 or more, which a refusal could not report", async () => {
		for (const bad of [{ maxDepth: 0.5 }, { maxLive: -1 }]) {
			const failed = await Effect.runPromise(Effect.flip(Declared.make({ ...limits, ...bad, subagents: [] })));
			expect(failed).toBeInstanceOf(SchemaConversionError);
			expect(failed.reason).toContain("maxDepth and maxLive");
		}
	});
});
