import type { EntryId, LiveState, SubmissionId, TaskId } from "@earendil-works/pi-durable";
import { Option } from "effect";
import { describe, expect, it } from "vitest";
import * as Run from "../src/run.ts";

// Pi brands its ids in the type system only: at run time they are the numbers stored.
const entry = (id: number) => id as EntryId;
const run = { taskId: 7 as TaskId, inputs: [1 as SubmissionId], turns: 0 };

describe("Run.view", () => {
	it("reads a conversation that never ran, and an idle one, as not working", () => {
		const idle = { working: false, yielded: Option.none(), first: Option.none() };
		expect(Run.view(Option.none())).toEqual(idle);
		expect(Run.view(Option.some<LiveState>({}))).toEqual(idle);
	});

	it("reads a live run as working, with its first entry", () => {
		expect(Run.view(Option.some<LiveState>({ run: { ...run, first: entry(4) } }))).toEqual({
			working: true,
			yielded: Option.none(),
			first: Option.some(4),
		});
	});

	it("reads the answer the run's onYield tasks decide about", () => {
		const live: LiveState = { run: { ...run, first: entry(4), yield: { answer: entry(5), tasks: [8 as TaskId] } } };
		expect(Run.view(Option.some(live))).toEqual({ working: true, yielded: Option.some(5), first: Option.some(4) });
	});

	it("reads a run that only waits for its afterRun tasks as not working", () => {
		expect(Run.view(Option.some<LiveState>({ run: { ...run, inputs: [], afterRun: {} } })).working).toBe(false);
	});
});

describe("Pi's built-in documents as documents of the facade", () => {
	it("carry Pi's own kinds and tokens", () => {
		expect([Run.Live.kind, Run.Provider.kind]).toEqual(["pi.live", "pi.provider"]);
		expect([Run.Live.scope, Run.Provider.scope, Run.Live.family, Run.Provider.family]).toEqual([
			"conversation",
			"conversation",
			false,
			false,
		]);
	});
});
