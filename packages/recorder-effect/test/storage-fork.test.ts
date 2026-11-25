import { Harness } from "@gunta/pi-durable-effect";
import { answer, TestHarness } from "@gunta/pi-durable-effect/testing";
import { Effect, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { fromEntry } from "../src/from-entry.ts";
import { Cursor, onStorageFork, Recorder } from "../src/index.ts";
import { App, testSink } from "./support.ts";

// The copy of a storage on a file, with both storages running on, is in sqlite-suites.ts.
describe("onStorageFork", () => {
	it("moves every conversation's cursor to its newest entry, so only what comes later is delivered", async () => {
		const sink = testSink();
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				// What a copied storage holds: a run and a fork of it, delivered by nobody here.
				const root = yield* TestHarness.root;
				yield* root.prompt("Say hi.", { requestId: "one" });
				const at = Option.getOrThrow(yield* root.head);
				const fork = yield* root.fork({ at, ownership: { kind: "ownerless" } });
				yield* fork.prompt("And bye.", { requestId: "two" });
				const forkHead = Option.getOrThrow(yield* fork.head);
				const empty = yield* root.fork({ at, ownership: { kind: "ownerless" } });
				yield* onStorageFork;
				const cursors = Option.getOrThrow(yield* Harness.snapshot(Cursor));
				return yield* Effect.gen(function* () {
					yield* Recorder.flushAll;
					const inherited = sink.attempts.length;
					yield* root.prompt("Something new.", { requestId: "three" });
					yield* Recorder.flushAll;
					const entries = yield* Stream.runCollect(root.entries({ order: "ascending", minEntryId: forkHead }));
					return { root: root.id, fork: fork.id, empty: empty.id, at, forkHead, cursors, inherited, entries };
				}).pipe(Effect.provide(Recorder.layer()));
			}).pipe(
				Effect.provide(
					TestHarness.layer({ extensions: [App], responses: [answer("Hi."), answer("Bye."), answer("New.")] }),
				),
				Effect.provide(sink.layer),
			),
		);
		expect(result.cursors).toEqual({
			[result.root]: result.at,
			[result.fork]: result.forkHead,
			// A fork without entries of its own: the newest entry it sees is its parent's.
			[result.empty]: result.at,
		});
		expect(result.inherited).toBe(0);
		const later = result.entries.filter((entry) => entry.conversationId === result.root);
		expect(sink.stored).toEqual(later.flatMap(fromEntry));
		expect(sink.stored.map((record) => record._tag)).toEqual(["Message", "ModelCall", "Message"]);
	});

	it("leaves an empty storage with an empty cursor document", async () => {
		const cursors = await Effect.runPromise(
			Effect.andThen(onStorageFork, Harness.snapshot(Cursor)).pipe(Effect.provide(TestHarness.layer())),
		);
		expect(cursors).toEqual(Option.some({}));
	});
});
