import { Effect, Exit, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { defineFacet, Host, invalid, local, method, nul, Reference, str } from "../src/index.ts";
import { run } from "./run.ts";

const Counter = local("example.counter", {
	version: 1,
	params: {},
	members: { add: method(str(), str()), reset: method(nul()) },
});

const counter = defineFacet((host) => {
	host.serve(Counter, () => ({
		add: async (name) => {
			if (name === "") throw invalid("args", "a name");
			return `added ${name}`;
		},
		reset: async () => null,
	}));
});

const host = Effect.gen(function* () {
	const opened = yield* Host.make({});
	yield* opened.load([{ name: "@example/counter", facet: counter }]);
	return yield* opened.get(Counter, {});
});

describe("Reference.call", () => {
	it("calls a method with its arguments, or with none, as an Effect", async () => {
		const answers = await run(
			Effect.gen(function* () {
				const reference = yield* host;
				return [yield* Reference.call(reference.add, "one"), yield* Reference.call(reference.reset)];
			}),
		);
		expect(answers).toEqual(["added one", null]);
	});

	it("fails with what the method declares", async () => {
		const exit = await run(Effect.exit(Effect.flatMap(host, (reference) => Reference.call(reference.add, ""))));
		expect(exit).toMatchObject(Exit.fail({ _tag: "ChordFailed", code: "invalid", reason: "args" }));
	});
});

describe("Reference.state", () => {
	it("gives the reference's state now", async () => {
		const state = await run(Effect.flatMap(host, (reference) => Stream.runHead(Reference.state(reference))));
		expect(state).toMatchObject({ _tag: "Some", value: { kind: "live" } });
	});
});
