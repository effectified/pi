import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import type { Report } from "@earendil-works/pi-durable";
import { Context, Effect, Layer, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { BuiltinDoc, Extension, Harness, Section } from "../src/index.ts";
import { answer, TestHarness } from "../src/testing/index.ts";

/** What a section renders from in these tests: a service, so a test sees the render ran with it. */
class Motto extends Context.Service<Motto, { readonly text: string }>()("test/Motto") {}

/** The sections of a request: Pi sends them in its system messages, by key. */
type Sections = Readonly<Record<string, string>>;

/** A response that records the sections of its request, then answers. */
function recording(requests: Array<Sections>): FauxResponseFactory {
	return (context) => {
		requests.push(
			Object.assign(
				{},
				...context.messages.flatMap((message) => (message.role === "system" ? [message.sections] : [])),
			),
		);
		return answer("Done.");
	};
}

/** Prompts the root conversation once and gives the system prompt its request had, and the harness's reports. */
const promptOnce = <const X extends ReadonlyArray<Extension.Extension>>(
	extensions: X,
	provided: Layer.Layer<Extension.Services<X[number]>>,
) =>
	Effect.gen(function* () {
		const requests: Array<Sections> = [];
		const reports: Array<Report> = [];
		yield* Effect.gen(function* () {
			yield* Effect.forkChild(
				Stream.runForEach(Harness.reports, (report) => Effect.sync(() => reports.push(report))),
				{
					startImmediately: true,
				},
			);
			const agent = yield* TestHarness.agent;
			const root = yield* Harness.rootWith({ agent: { ...agent, extensions } });
			yield* root.prompt("Hello.");
		}).pipe(
			Effect.provide(TestHarness.layer({ extensions, responses: [recording(requests)] })),
			Effect.provide(provided),
			Effect.scoped,
		);
		return { sections: requests[0], reports };
	});

describe("Section.make", () => {
	it("renders into the system prompt with the services of the registry, tagged unless told not to", async () => {
		const seen = await Effect.runPromise(
			promptOnce(
				[
					Extension.make({
						name: "app",
						sections: [
							Section.make("motto", () => Motto.use(({ text }) => Effect.succeed(Option.some(text)))),
							Section.make("plain", () => Effect.succeedSome("No tag."), { tag: false }),
							Section.make("absent", () => Effect.succeedNone),
						],
					}),
				],
				Layer.succeed(Motto, { text: "Be brief." }),
			),
		);
		expect(seen.sections).toEqual({ motto: "<motto>\nBe brief.\n</motto>", plain: "No tag." });
	});

	it("reads committed documents and the conversation it renders for", async () => {
		const seen = await Effect.runPromise(
			promptOnce(
				[
					Extension.make({
						name: "app",
						sections: [
							Section.make("model", (input) =>
								Effect.map(input.read.snapshot(BuiltinDoc.agent, input.conversationId), (agent) =>
									Option.map(agent, (state) => `${input.conversationId} ${state.model?.provider}`),
								),
							),
						],
					}),
				],
				Layer.empty,
			),
		);
		expect(seen.sections.model).toMatch(/^<model>\n\d+ faux/);
	});

	it("leaves a failing section out and reports it, and the request goes on", async () => {
		const seen = await Effect.runPromise(
			promptOnce(
				[
					Extension.make({
						name: "app",
						sections: [
							Section.make("broken", () => Effect.die(new Error("no motto"))),
							Section.make("kept", () => Effect.succeedSome("Kept.")),
						],
					}),
				],
				Layer.empty,
			),
		);
		expect(seen.sections).toEqual({ kept: "<kept>\nKept.\n</kept>" });
		expect(seen.reports.map((report) => [report.kind, String(report.error)])).toContainEqual([
			"extension_error",
			"Error: no motto",
		]);
	});
});

describe("Section.wrap", () => {
	it("replaces the render of another extension's section where its extension is selected", async () => {
		const base = Extension.make({
			name: "base",
			sections: [Section.make("motto", () => Effect.succeedSome("be brief"))],
		});
		const loud = Extension.make({
			name: "loud",
			wraps: [
				Section.wrap("motto", (section) => ({
					tag: false,
					render: (input) =>
						Effect.flatMap(section.render(input), (text) =>
							Motto.use(({ text: suffix }) =>
								Effect.succeed(Option.map(text, (shown) => `${shown.toUpperCase()}${suffix}`)),
							),
						),
				})),
			],
		});
		const seen = await Effect.runPromise(promptOnce([base, loud], Layer.succeed(Motto, { text: "!" })));
		expect(seen.sections).toEqual({ motto: "BE BRIEF!" });
	});
});
