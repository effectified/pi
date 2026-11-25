import type { EntryRecord } from "@earendil-works/pi-durable";
import { answer, toolCall } from "@gunta/pi-durable-effect/testing";
import { Effect, Option, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { applied, approve, decide, deny } from "../src/index.ts";
import { HOUR, parked, results, scene, shown, submit } from "./scene.ts";

/** The details Pi stored with a tool result entry. */
function details(entry: EntryRecord | undefined): unknown {
	const message = entry?.model?.[0];
	return message?.role === "toolResult" ? message.details : undefined;
}

describe("the record on the tool result", () => {
	it("names the request and who approved it, once the tool ran", async () => {
		const { published, layer } = scene();
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				yield* TestClock.setTime(5_000);
				const { root, submission } = yield* submit();
				const request = yield* parked(published);
				yield* TestClock.adjust(250);
				yield* decide(request, yield* approve(request, "user:ada"));
				yield* submission.wait;
				yield* root.waitForIdle;
				const [entry] = yield* results(root);
				return { request, entry, record: yield* applied(entry as EntryRecord) };
			}).pipe(Effect.provide(layer), Effect.provide(TestClock.layer())),
		);
		const outcome = { _tag: "Approved", digest: seen.request.digest, by: "user:ada", at: 5_250 };
		expect(seen.record).toEqual(Option.some({ request: seen.request, outcome }));
		// It is plain JSON in the entry, where a recorder reads it without this package.
		expect(details(seen.entry)).toEqual({ approvals: { request: seen.request, outcome } });
		expect(shown(seen.entry)).toEqual({ isError: false, text: "wrote hi" });
	});

	it("names who denied it and the note, on the blocked result", async () => {
		const { published, layer } = scene();
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* submit();
				const request = yield* parked(published);
				const denial = yield* deny(request, "user:bob", "Ask the owner first.");
				yield* decide(request, denial);
				yield* submission.wait;
				yield* root.waitForIdle;
				const [entry] = yield* results(root);
				return { request, denial, entry, record: yield* applied(entry as EntryRecord) };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen.record).toEqual(Option.some({ request: seen.request, outcome: seen.denial }));
		expect(seen.denial).toMatchObject({ _tag: "Denied", by: "user:bob", note: "Ask the owner first." });
		expect(shown(seen.entry)?.isError).toBe(true);
	});

	it("says expired on the result of a request nobody decided in time", async () => {
		const { published, layer } = scene();
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* submit();
				const request = yield* parked(published);
				yield* TestClock.adjust(HOUR);
				yield* submission.wait;
				yield* root.waitForIdle;
				const [entry] = yield* results(root);
				return { request, record: yield* applied(entry as EntryRecord) };
			}).pipe(Effect.provide(layer), Effect.provide(TestClock.layer())),
		);
		expect(seen.record).toEqual(Option.some({ request: seen.request, outcome: { _tag: "Expired" } }));
	});

	it("says undecided on the result of a call aborted while it waited", async () => {
		const { published, layer } = scene();
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { root } = yield* submit();
				const request = yield* parked(published);
				yield* root.abort();
				const [entry] = yield* results(root);
				return { request, entry, record: yield* applied(entry as EntryRecord) };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen.record).toEqual(Option.some({ request: seen.request, outcome: { _tag: "Undecided" } }));
		expect(shown(seen.entry)?.text).toContain("Tool write was aborted");
	});

	it("joins a tool's own object details, and is absent for a call that never asked", async () => {
		const { published, layer } = scene({
			policy: { tools: ["read"], expiresAfter: "1 hour" },
			responses: [
				toolCall("read", { path: "a.txt" }, { id: "call-1" }),
				toolCall("write", { text: "hi" }, { id: "call-2" }),
				answer("Done."),
			],
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* submit("Read, then write.");
				const request = yield* parked(published);
				const approval = yield* approve(request, "ada");
				yield* decide(request, approval);
				yield* submission.wait;
				yield* root.waitForIdle;
				const entries = yield* results(root);
				const records = yield* Effect.forEach(entries, applied);
				return { request, approval, entries, records };
			}).pipe(Effect.provide(layer)),
		);
		expect(details(seen.entries[0])).toEqual({
			source: "disk",
			approvals: { request: seen.request, outcome: seen.approval },
		});
		expect(seen.records).toEqual([Option.some({ request: seen.request, outcome: seen.approval }), Option.none()]);
		expect(details(seen.entries[1])).toBeUndefined();
	});

	it("leaves details that are no object as the tool reported them, without a record", async () => {
		const { published, layer } = scene({
			policy: { tools: ["list"], expiresAfter: "1 hour" },
			responses: [toolCall("list", { path: "." }, { id: "call-1" }), answer("Done.")],
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* submit("List.");
				const request = yield* parked(published);
				yield* decide(request, yield* approve(request, "ada"));
				yield* submission.wait;
				yield* root.waitForIdle;
				const [entry] = yield* results(root);
				return { entry, record: yield* applied(entry as EntryRecord) };
			}).pipe(Effect.provide(layer)),
		);
		expect(details(seen.entry)).toEqual(["a", "b"]);
		expect(seen.record).toEqual(Option.none());
		expect(shown(seen.entry)).toEqual({ isError: false, text: "listed ." });
	});
});

describe("applied", () => {
	it("is none for every entry that is no tool result", async () => {
		const { layer } = scene({ responses: [answer("Hello.")] });
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* submit("Hi.");
				yield* submission.wait;
				yield* root.waitForIdle;
				const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
				return { kinds: entries.map((entry) => entry.kind), records: yield* Effect.forEach(entries, applied) };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen.kinds).toEqual(["pi.user", "pi.system", "pi.assistant"]);
		expect(seen.records).toEqual([Option.none(), Option.none(), Option.none()]);
	});

	it("fails with MalformedState for a record that is not one of this package", async () => {
		const entry = {
			id: 7,
			conversationId: 1,
			kind: "pi.tool-result",
			model: [
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "write",
					content: [],
					details: { approvals: { request: "r1" } },
					isError: false,
					timestamp: 0,
				},
			],
			data: { diagnostics: [] },
		} as unknown as EntryRecord;
		const error = await Effect.runPromise(Effect.flip(applied(entry)));
		expect(error).toMatchObject({ _tag: "MalformedState", where: "details.approvals" });
		expect(error.message).toContain("details.approvals: ");
	});
});
