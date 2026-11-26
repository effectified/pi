import type { TranscriptItem } from "@earendil-works/pi-durable";
import { runTest } from "@effectified/pi-ai/testing";
import { Effect, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { Harness, Transcript } from "../src/index.ts";
import { AGENT, answer, harnessLayer } from "./scripted.ts";

/** What an item of a transcript shows: an entry's kind, or the placeholder's. */
function shown(items: ReadonlyArray<TranscriptItem>): ReadonlyArray<string> {
	return items.map((item) => (item.kind === "entry" ? item.entry.kind : item.kind));
}

describe("a conversation's transcript", () => {
	it("keeps the whole transcript of a window that shows the newest entries, and loads the earlier ones", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				yield* root.prompt("One.");
				yield* root.prompt("Two.");
				// A window of the newest entry: the three entries before it are not in the view.
				const first = yield* Stream.runHead(Transcript.stream(root, { window: { min: 1 }, pageSize: 2 }));
				const { transcript, view } = Option.getOrThrow(first);
				const newest = yield* transcript.newest;
				const earlier = yield* transcript.loadEarlier;
				const all = yield* transcript.loadEarlier;
				const resume = yield* transcript.resume;
				return { view: shown(view.items), earlier: shown(earlier.items), all: shown(all.items), newest, resume };
			}).pipe(Effect.provide(harnessLayer({ responses: [answer("A."), answer("B.")] }))),
		);
		expect(seen.view).toEqual(["earlier", "pi.assistant"]);
		expect(seen.earlier).toEqual(["earlier", "pi.assistant", "pi.user", "pi.assistant"]);
		expect(seen.all).toEqual(["pi.user", "pi.assistant", "pi.user", "pi.assistant"]);
		expect(Option.isSome(seen.newest)).toBe(true);
		// After the newest entry: a new view continues the transcript from there.
		expect(seen.resume).toEqual(Option.map(seen.newest, (newest) => ({ from: newest + 1 })));
	});

	it("is empty before the first merge, and fails for a page size Pi refuses", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const transcript = yield* root.transcript();
				const failure = yield* Effect.flip(root.transcript({ pageSize: 0 }));
				return {
					id: transcript.conversationId === root.id,
					newest: yield* transcript.newest,
					resume: yield* transcript.resume,
					failure: failure._tag,
				};
			}).pipe(Effect.provide(harnessLayer({}))),
		);
		expect(seen).toEqual({ id: true, newest: Option.none(), resume: Option.none(), failure: "UnexpectedError" });
	});
});
