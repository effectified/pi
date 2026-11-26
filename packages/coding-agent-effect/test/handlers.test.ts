import { fauxAssistantMessage, runTest } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Extension, ExtensionApi } from "../src/index.ts";
import { openSession, services, texts } from "./scripted.ts";

describe("Handlers", () => {
	it("takes an input handler's answer: the prompt is rewritten before the model sees it", async () => {
		const users = await runTest(
			Effect.gen(function* () {
				const rewriter = Extension.make("rewriter", {
					on: {
						input: (event) =>
							Effect.succeed(
								event.text === "shorthand"
									? { action: "transform" as const, text: "The long form." }
									: undefined,
							),
					},
				});
				const { session, models } = yield* openSession({ extensions: [rewriter] });
				yield* models.setResponses([fauxAssistantMessage("Understood.")]);
				yield* session.prompt("shorthand");
				return texts(yield* session.messages, "user");
			}).pipe(Effect.provide(services)),
		);
		expect(users).toEqual(["The long form."]);
	});

	it("asks the handlers of an event in the order the extensions were loaded", async () => {
		const order = await runTest(
			Effect.gen(function* () {
				const seen: string[] = [];
				const recorder = (name: string) =>
					Extension.make(name, { on: { agent_start: () => Effect.sync(() => void seen.push(name)) } });
				const { session, models } = yield* openSession({ extensions: [recorder("first"), recorder("second")] });
				yield* models.setResponses([fauxAssistantMessage("Done.")]);
				yield* session.prompt("Go.");
				return seen;
			}).pipe(Effect.provide(services)),
		);
		expect(order).toEqual(["first", "second"]);
	});

	it("gives handlers the extension API of their load", async () => {
		const name = await runTest(
			Effect.gen(function* () {
				const namer = Extension.make("namer", {
					on: { agent_end: () => Effect.flatMap(ExtensionApi, (api) => api.setSessionName("named on agent_end")) },
				});
				const { session, models } = yield* openSession({ extensions: [namer] });
				yield* models.setResponses([fauxAssistantMessage("Done.")]);
				yield* session.prompt("Go.");
				return yield* session.sessionName;
			}).pipe(Effect.provide(services)),
		);
		expect(name).toBe("named on agent_end");
	});
});
