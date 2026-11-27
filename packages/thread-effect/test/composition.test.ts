// The composition as one Layer: the order of its extensions, Pi's telemetry on the product's tracer, the evidence of
// a search, and a setup port that takes the guard from its context.

import { Storage } from "@effectified/pi-durable";
import { answer, toolCall } from "@effectified/pi-durable/testing";
import { Conversations, Guard } from "@effectified/pi-guard";
import { Evidence } from "@effectified/pi-search";
import { ChildSetup, ChildSetupFailed, Subagents } from "@effectified/pi-subagent";
import { Context, Effect, Layer, Tracer } from "effect";
import { describe, expect, it } from "vitest";
import { Composition, ThreadKey, Threads } from "../src/index.ts";
import { committed, config, GUARD_POLICY, outside, ports, providers, Researcher, run, work } from "./world.ts";

describe("the composition", () => {
	it("opens as one Layer, with the guard asked first and the recorder last", async () => {
		const state = outside();
		const labs = providers({ author: [answer("Hi.")], reviewer: [answer('{"findings":[]}')] });
		const spans: Array<string> = [];
		const tracer = Tracer.make({
			span: (options) => {
				spans.push(options.name);
				return new Tracer.NativeSpan(options);
			},
		});
		const live = Composition.open(config(state, labs)).pipe(
			Layer.provide(Storage.memory),
			Layer.provide(ports(state, { tracer })),
		);
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const outcome = yield* threads.work(work("t1", "Say hi."));
				const agent = yield* (yield* threads.conversation(ThreadKey.make("t1"))).agent;
				return { outcome: outcome._tag, extensions: agent.extensions.map((extension) => extension.name) };
			}).pipe(Effect.provide(live)),
		);
		expect(result).toEqual({
			outcome: "Reviewed",
			extensions: ["guard", "app", "search", "approvals", "review", "subagent", "swarm", "thread", "recorder"],
		});
		// Pi's spans are spans of the tracer the product's `PiTelemetry` was built with.
		expect([...new Set(spans)].sort()).toEqual(["pi.ai.request", "pi.durable.phase", "pi.durable.submit"]);
	});

	it("keeps the evidence of a search in the tool result the sink takes", async () => {
		const state = outside();
		const labs = providers({
			author: [toolCall("web_search", { query: "record 42" }, { id: "call-1" }), answer("It is called Answer.")],
			reviewer: [answer('{"findings":[]}')],
		});
		const evidence = await run(
			state,
			labs,
			Effect.gen(function* () {
				yield* Threads.Threads.use((threads) => threads.work(work("t1", "Search for record 42.", ["web_search"])));
				const [result] = committed(state).flatMap((record) => (record._tag === "ToolCallResult" ? [record] : []));
				return yield* Evidence.fromJson(result?.details);
			}),
		);
		expect(evidence).toMatchObject({
			provider: "scripted",
			request: { method: "POST", body: { query: "record 42" } },
			raw: JSON.stringify({ results: [{ url: "https://example.test/answer", title: "Answer" }] }),
		});
	});

	it("builds a child setup that takes the guard from its context, on the guard's two parts and not on one", async () => {
		// The setup of the subagent README: it reads the `Guard` when its Layer is built.
		const Setup = Layer.effect(
			ChildSetup.ChildSetup,
			Effect.gen(function* () {
				const guard = yield* Guard.Guard;
				return {
					created: (tx, child) =>
						Conversations.grantIn(tx, child.conversationId, { tools: [] }, { mode: "narrow" }).pipe(
							Effect.provideService(Guard.Guard, guard),
							Effect.mapError((cause) => new ChildSetupFailed({ reason: "No grant.", cause })),
						),
					beforeStart: () => Effect.void,
				};
			}),
		);
		const extensions = [Subagents.extension({ subagents: [Researcher], maxDepth: 1, maxLive: 1 })] as const;
		// `Guard.fromPolicy` gives the guard without a registry, and `Guard.registry` requires it: the setup and the
		// registry get the same one, and nothing is deferred.
		const parts = Guard.registry({ extensions }).pipe(
			Layer.provide(Setup),
			Layer.provideMerge(Guard.fromPolicy(GUARD_POLICY)),
		);
		const built = await Effect.runPromise(
			Effect.scoped(Effect.map(Layer.build(parts), (context) => Context.get(context, Guard.Guard).policy)),
		);
		expect(built.classifications).toEqual(GUARD_POLICY.classifications);
		// `Guard.layer` is both parts in one, so it provides the `Guard` and requires the `ChildSetup` that needs it:
		// a cycle, which is what the two parts are for.
		const whole = Guard.layer({ policy: GUARD_POLICY, extensions }).pipe(Layer.provide(Setup));
		const exit = await Effect.runPromiseExit(
			// @ts-expect-error The registry still requires the `Guard` it provides, so it cannot be built.
			Effect.scoped(Layer.build(whole)),
		);
		expect(String(exit)).toContain("Service not found: @effectified/pi-guard/guard");
	});
});
