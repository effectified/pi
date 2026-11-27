import type { ConversationId } from "@earendil-works/pi-durable";
import { SchemaConversionError } from "@effectified/pi-durable";
import { answer, toolCall } from "@effectified/pi-durable/testing";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ResultMismatch, Subagent, Subagents } from "../src/index.ts";
import * as Result from "../src/result.ts";
import {
	childOf,
	children,
	conversation,
	entriesOf,
	harness,
	parent,
	routed,
	said,
	toolResults,
	worker,
} from "./scene.ts";

const City = Schema.Struct({ capital: Schema.String, landlocked: Schema.Boolean });
const cities = worker("cities", { result: City });
const { foreground } = Subagents.TOOLS;

const CONTRACT =
	"Your final answer must be one JSON value that matches this JSON Schema, with no other text:\n" +
	'{"type":"object","properties":{"capital":{"type":"string"},"landlocked":{"type":"boolean"}},' +
	'"required":["capital","landlocked"],"additionalProperties":true}';

describe("Result.compile", () => {
	const compiled = Effect.runSync(Result.compile(cities, City));

	it("tells the child the JSON Schema its final answer must match", () => {
		expect(compiled.contract).toBe(CONTRACT);
	});

	it("decodes an answer that is the JSON value, bare or in a fenced block, to the schema's JSON form", async () => {
		const bare = await Effect.runPromise(compiled.decode('{"capital":"Paris","landlocked":true}'));
		const fenced = await Effect.runPromise(
			compiled.decode('Here it is:\n```json\n{ "landlocked": true, "capital": "Paris" }\n```'),
		);
		expect(bare).toEqual({ capital: "Paris", landlocked: true });
		expect(fenced).toEqual(bare);
	});

	it("fails with what to tell the child for text that is no JSON, and for JSON of another shape", async () => {
		const prose = await Effect.runPromise(Effect.flip(compiled.decode("Paris, by the Seine.")));
		const shape = await Effect.runPromise(Effect.flip(compiled.decode('{"capital":"Paris"}')));
		expect(prose).toEqual(ResultMismatch.make({ subagent: Subagent.Name.make("cities"), issues: "it is not JSON" }));
		expect(shape).toBeInstanceOf(ResultMismatch);
		expect(shape.issues).toContain('["landlocked"]');
		expect(Result.correction(prose)).toBe(
			"Your answer is not the JSON value that was asked for: it is not JSON\nAnswer again with only the JSON value.",
		);
	});

	it("fails for a result that has no JSON Schema", async () => {
		const unsupported = Schema.Struct({ [Symbol.for("key")]: Schema.String });
		const failed = await Effect.runPromise(Effect.flip(Result.compile(cities, unsupported)));
		expect(failed).toBeInstanceOf(SchemaConversionError);
		expect(failed.reason).toContain("Subagent cities: its result has no JSON Schema");
	});
});

describe("a subagent with a declared result", () => {
	/** One delegation to `subagent`, whose child answers with `answers` in order, and what it left. */
	const delegate = (subagent: Subagent.Subagent, answers: ReadonlyArray<string>) => {
		const asked: string[] = [];
		const { layer } = harness({
			config: { subagents: [subagent], maxDepth: 1, maxLive: 1 },
			responses: routed(
				{
					parent: [toolCall(foreground, { subagent: subagent.name, task: "Describe Paris." }), answer("Done.")],
					child: answers.map(answer),
				},
				asked,
			),
		});
		return Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* parent;
				yield* root.prompt("Delegate.");
				yield* root.waitForIdle;
				const [child] = yield* children;
				const id = child?.id as ConversationId;
				return {
					id,
					asked,
					results: toolResults(yield* entriesOf(root)),
					record: yield* childOf(id),
					child: said(yield* entriesOf(yield* conversation(id))),
				};
			}).pipe(Effect.provide(layer)),
		);
	};
	const details = (id: ConversationId) => ({
		conversationId: id,
		handle: String(id),
		subagent: "cities",
		mode: "foreground",
	});

	it("gives the parent's model the result as JSON text, and the host the value in the details", async () => {
		const seen = await delegate(cities, ['```json\n{"landlocked":true,"capital":"Paris","mayor":"unknown"}\n```']);
		const result = { capital: "Paris", landlocked: true };
		expect(seen.child[0]).toBe(`user: Describe Paris.\n\n${CONTRACT}`);
		expect(seen.results).toEqual([
			{
				tool: "subagent",
				isError: false,
				// The schema's own form: its field order, and nothing the schema does not know.
				text: '{"capital":"Paris","landlocked":true}',
				details: { ...details(seen.id), status: "answered", result },
			},
		]);
		expect(seen.record.state).toMatchObject({ _tag: "Typed", result });
		// The host decodes what the details hold with the declaration.
		const kept = seen.results[0]?.details as { readonly result: unknown } | undefined;
		expect(await Effect.runPromise(Subagent.result(cities, kept?.result))).toEqual(result);
		// Data-last, in a pipe of what a host found.
		expect(await Effect.runPromise(Subagent.result(kept?.result)(cities))).toEqual(result);
		expect(seen.asked).toEqual(["parent", "child", "parent"]);
	});

	it("sends an answer that does not match back to the child, and takes the corrected one", async () => {
		const seen = await delegate(cities, ["Paris, by the Seine.", '{"capital":"Paris","landlocked":true}']);
		expect(seen.child).toEqual([
			`user: Describe Paris.\n\n${CONTRACT}`,
			"assistant: Paris, by the Seine.",
			"user: Your answer is not the JSON value that was asked for: it is not JSON\nAnswer again with only the JSON value.",
			'assistant: {"capital":"Paris","landlocked":true}',
		]);
		expect(seen.results.map((result) => [result.isError, result.text])).toEqual([
			[false, '{"capital":"Paris","landlocked":true}'],
		]);
		expect(seen.asked).toEqual(["parent", "child", "child", "parent"]);
	});

	it("gives up after the declared number of corrections, with an error result that keeps the last answer", async () => {
		const seen = await delegate(worker("cities", { result: City, corrections: 1 }), [
			"Paris.",
			'{"capital":"Paris"}',
		]);
		expect(seen.asked).toEqual(["parent", "child", "child", "parent"]);
		expect(seen.child).toHaveLength(4);
		const [result] = seen.results;
		expect(result?.isError).toBe(true);
		expect(result?.text).toMatch(
			/^The result of subagent "cities" does not match its declared schema: [\s\S]*, after 1 corrections\.\nIts last answer was:\n\{"capital":"Paris"\}$/,
		);
		expect(result?.details).toEqual({ ...details(seen.id), status: "failed", reason: "invalid_result" });
		expect(seen.record.state).toMatchObject({ _tag: "Failed", reason: "invalid_result" });
	});

	it("asks twice at most when the declaration does not say", () => {
		expect(Subagent.DEFAULT_CORRECTIONS).toBe(2);
	});
});
