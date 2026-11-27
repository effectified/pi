import { runTest } from "@effectified/pi-ai/testing";
import { Effect, FileSystem, PlatformError } from "effect";
import { describe, expect, it } from "vitest";
import { type DiscoveredEvalCase, InvalidPlan, Plan } from "../src/index.ts";

const CASES: DiscoveredEvalCase[] = [
	{ file: "evals/a.docs.eval.ts", fullName: "Set > first", evalSet: "Set", caseId: "first" },
	{ file: "evals/a.docs.eval.ts", fullName: "Set > second", evalSet: "Set", caseId: "second" },
];

/** A file system that holds the files `files` names, path to text, and fails to read any other. */
function holding(files: Readonly<Record<string, string>>) {
	return FileSystem.layerNoop({
		readFileString: (path) =>
			path in files
				? Effect.succeed(files[path] ?? "")
				: Effect.fail(
						PlatformError.systemError({
							_tag: "NotFound",
							module: "FileSystem",
							method: "readFileString",
							pathOrDescriptor: path,
						}),
					),
	});
}

describe("readDiscoveredCases", () => {
	it("reads the discovery file, decodes its JSON and checks its cases as parseDiscoveredCases does", async () => {
		const discovered = JSON.stringify([
			{ name: "Set > first", file: "evals/a.docs.eval.ts" },
			{ name: "Set > second", file: "evals/a.docs.eval.ts" },
		]);
		const cases = await runTest(
			Plan.readDiscoveredCases("/out/discovered-tests.json").pipe(
				Effect.provide(holding({ "/out/discovered-tests.json": discovered })),
			),
		);
		expect(cases).toEqual(CASES);
	});

	it("fails with InvalidPlan on a file that is not JSON or holds an invalid case", async () => {
		const files = holding({ "/broken.json": "[{", "/invalid.json": '[{ "name": "Set" }]' });
		const failures = await runTest(
			Effect.all(
				[
					Effect.flip(Plan.readDiscoveredCases("/broken.json")),
					Effect.flip(Plan.readDiscoveredCases("/invalid.json")),
				],
				{
					concurrency: 2,
				},
			).pipe(Effect.provide(files)),
		);
		expect(failures.map((failure) => failure._tag)).toEqual(["InvalidPlan", "InvalidPlan"]);
		expect(failures[0]?.message).toContain("/broken.json");
		expect(failures[1]?.message).toContain("Discovered eval case is invalid");
	});

	it("fails with the PlatformError of a file it cannot read", async () => {
		const failure = await runTest(
			Effect.flip(Plan.readDiscoveredCases("/missing.json")).pipe(Effect.provide(holding({}))),
		);
		expect(failure._tag).toBe("PlatformError");
	});
});

describe("parseDiscoveredCases", () => {
	it("reads Vitest's discovered cases into eval sets and cases", async () => {
		const cases = await runTest(
			Plan.parseDiscoveredCases([
				{ name: "Set > first", file: "evals/a.docs.eval.ts" },
				{ name: "Set > second", file: "evals/a.docs.eval.ts" },
			]),
		);
		expect(cases).toEqual(CASES);
	});

	it.each([
		["not an array", { name: "Set > first" }, "must be an array"],
		["a name without a case", [{ name: "Set", file: "a.ts" }], 'must use "<eval set> > <case>"'],
		[
			"two cases of one identity",
			[
				{ name: "S > c", file: "a.ts" },
				{ name: "S > c", file: "b.ts" },
			],
			"Duplicate",
		],
	])("fails with InvalidPlan on %s, with Pi's message", async (_, value, message) => {
		const failure = await runTest(Effect.flip(Plan.parseDiscoveredCases(value)));
		expect(failure).toBeInstanceOf(InvalidPlan);
		expect(failure.message).toContain(message);
	});
});

describe("createTaskPlan", () => {
	it("plans every case, variant and run, alternating the variants' order by run", async () => {
		const tasks = await runTest(Plan.createTaskPlan(CASES.slice(0, 1), "openai/gpt", 2));
		expect(tasks.map(({ caseId, variant, model, runNumber }) => [caseId, variant, model, runNumber])).toEqual([
			["first", "without_docs", "openai/gpt", 1],
			["first", "with_docs", "openai/gpt", 1],
			["first", "with_docs", "openai/gpt", 2],
			["first", "without_docs", "openai/gpt", 2],
		]);
	});

	it.each([
		["a model without a provider", "gpt", 1, "provider and model"],
		["zero runs", "openai/gpt", 0, "positive integer"],
		["a fractional count", "openai/gpt", 1.5, "positive integer"],
	])("fails with InvalidPlan on %s", async (_, model, runs, message) => {
		const failure = await runTest(Effect.flip(Plan.createTaskPlan(CASES, model, runs)));
		expect(failure._tag).toBe("InvalidPlan");
		expect(failure.message).toContain(message);
	});
});
