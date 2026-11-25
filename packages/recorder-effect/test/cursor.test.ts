import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { Harness } from "@gunta/pi-durable-effect";
import { answer, TestHarness } from "@gunta/pi-durable-effect/testing";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import * as Cursors from "../src/cursor.ts";

const harness = TestHarness.layer({ responses: [answer("Hi."), answer("Bye.")] });

describe("Cursor", () => {
	it("is a session document of this plugin, created once and empty at first", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const before = yield* Harness.snapshot(Cursors.Cursor);
				yield* Cursors.ensure;
				yield* Cursors.ensure;
				return { before, after: yield* Harness.snapshot(Cursors.Cursor) };
			}).pipe(Effect.provide(harness)),
		);
		expect(Cursors.Cursor.kind).toBe("recorder.cursor");
		expect(Cursors.Cursor.scope).toBe("session");
		expect(Option.isNone(result.before)).toBe(true);
		expect(result.after).toEqual(Option.some({}));
	});

	it("starts at the first entry of a conversation that is no fork, and of one that does not exist", async () => {
		const starts = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Say hi.", { requestId: "one" });
				return [yield* Cursors.start(root.id), yield* Cursors.start(999 as ConversationId)];
			}).pipe(Effect.provide(harness)),
		);
		expect(starts).toEqual([Option.none(), Option.none()]);
	});

	it("starts a fork at the entry it was forked at, until the fork has a cursor of its own", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Say hi.", { requestId: "one" });
				const at = Option.getOrThrow(yield* root.head);
				yield* root.prompt("Say bye.", { requestId: "two" });
				// The parent went on: its cursor and its newer entries are nothing to the fork.
				yield* Cursors.advance(root.id, Option.getOrThrow(yield* root.head));
				const fork = yield* root.fork({ at, ownership: { kind: "ownerless" } });
				const fresh = yield* Cursors.start(fork.id);
				// Pi brands entry ids in its types only: at run time an entry id is a number.
				yield* Cursors.advance(fork.id, (at + 100) as EntryId);
				return { at, fresh, moved: yield* Cursors.start(fork.id), root: yield* Cursors.start(root.id) };
			}).pipe(Effect.provide(harness)),
		);
		expect(result.fresh).toEqual(Option.some(result.at));
		expect(result.moved).toEqual(Option.some(result.at + 100));
		expect(Option.getOrThrow(result.root)).toBeGreaterThan(result.at);
	});

	it("advances one conversation's key and leaves the others", async () => {
		const stored = await Effect.runPromise(
			Effect.gen(function* () {
				yield* Cursors.advance(1 as ConversationId, 7 as EntryId);
				yield* Cursors.advance(5 as ConversationId, 30 as EntryId);
				yield* Cursors.advance(1 as ConversationId, 12 as EntryId);
				return yield* Harness.snapshot(Cursors.Cursor);
			}).pipe(Effect.provide(harness)),
		);
		expect(stored).toEqual(Option.some({ "1": 12, "5": 30 }));
	});
});
