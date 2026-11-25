// `onStorageFork` on one storage, which stands in for a copy of itself here: the suites on a copied SQLite file are in
// sqlite-suites.ts.

import type { ConversationId } from "@earendil-works/pi-durable";
import { Harness } from "@gunta/pi-durable-effect";
import { answer, held, toolCall } from "@gunta/pi-durable-effect/testing";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import * as Copy from "../src/copy.ts";
import { onStorageFork, Subagents } from "../src/index.ts";
import { childOf, children, harness, parent, routed, worker } from "./scene.ts";

const config: Subagents.Config = { subagents: [worker("researcher")], maxDepth: 1, maxLive: 2 };
const start = (task: string) => toolCall(Subagents.TOOLS.background, { subagent: "researcher", task });

describe("onStorageFork", () => {
	it("marks the storage through its newest task and ends the live runs, and leaves a later run alone", async () => {
		const asked: string[] = [];
		const cut = held(answer("Never given."));
		const { layer } = harness({
			config,
			responses: routed(
				{
					parent: [start("One."), answer("Started one."), start("Two."), answer("Started two."), answer("Noted.")],
					child: [cut.response, answer("Two is done.")],
				},
				asked,
			),
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* parent;
				yield* root.prompt("Start one.");
				yield* cut.requested;
				const [first] = yield* children;
				const inherited = yield* childOf(first?.id as ConversationId);
				const newest = yield* Harness.commit((tx) => tx.scanTasks({ order: "descending" }, 1));
				yield* onStorageFork;
				const run = yield* Harness.waitForTask(inherited.task);
				const mark = yield* Harness.snapshot(Copy.Document);
				// A run started after the mark is this storage's own.
				yield* root.prompt("Start two.");
				const second = (yield* children).find((record) => record.id !== first?.id);
				const own = yield* childOf(second?.id as ConversationId);
				yield* Harness.waitForTask(own.task);
				yield* root.waitForIdle;
				return {
					newest: newest.items[0]?.id,
					mark,
					run: run.state.outcome,
					inherited: (yield* childOf(inherited.conversation)).state,
					own: { task: own.task, state: (yield* childOf(own.conversation)).state._tag },
				};
			}).pipe(Effect.provide(layer)),
		);
		expect(seen.mark).toEqual(Option.some({ through: seen.newest }));
		expect(seen.run).toEqual({ status: "aborted", reason: "copied" });
		expect(seen.inherited).toMatchObject({ _tag: "Failed", reason: "copied", answer: null });
		expect(seen.own.task).toBeGreaterThan(seen.newest ?? 0);
		expect(seen.own.state).toBe("Answered");
		// The inherited child was asked once, before the step, and never again.
		expect(asked.filter((model) => model === "child")).toHaveLength(2);
	});

	it("marks a storage that holds no run, so nothing older than the mark can start one", async () => {
		const mark = await Effect.runPromise(
			Effect.andThen(onStorageFork, Harness.snapshot(Copy.Document)).pipe(
				Effect.provide(harness({ config, responses: [] }).layer),
			),
		);
		expect(mark).toEqual(Option.some({ through: 0 }));
	});
});
