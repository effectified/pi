import { defineEntry, type EntryId, type EntryRecord } from "@earendil-works/pi-durable";
import type { SchemaDecodeError } from "@effectified/pi-schema";
import { Effect, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { type DurableError, Entry, Extension, Harness, Hook, Registry } from "../src/index.ts";
import { runBoth } from "./parity.ts";
import { AGENT, answer, harnessLayer } from "./scripted.ts";

const Receipt = Entry.make("app.receipt", Schema.Struct({ paidAt: Schema.Date, cents: Schema.Number }));
const PiReceipt = defineEntry<{ paidAt: string; cents: number }>("app.receipt");

const paidAt = new Date("2026-11-24T10:00:00.000Z");

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** A stored entry of the root conversation, as Pi would have written it. */
function record(kind: string, data: unknown): EntryRecord {
	return { id: 5 as EntryId, conversationId: 1, kind, data } as EntryRecord;
}

describe("make", () => {
	it("types an entry's data by the schema", () => {
		const typed: Equal<
			ReturnType<typeof Receipt.read>,
			Effect.Effect<Option.Option<Entry.Typed<{ readonly paidAt: Date; readonly cents: number }>>, SchemaDecodeError>
		> = true;
		expect(typed).toBe(true);
		expect(Receipt.kind).toBe("app.receipt");
		expect(Receipt.token.kind).toBe("app.receipt");
	});

	it("encodes the data of a draft and keeps Pi's other fields", async () => {
		const draft = await Effect.runPromise(Receipt.draft({ data: { paidAt, cents: 1250 }, head: "self" }));
		expect(draft).toEqual({ data: { paidAt: "2026-11-24T10:00:00.000Z", cents: 1250 }, head: "self" });
	});

	it("reads a stored entry of its kind with the data decoded, and none for another kind", async () => {
		const stored = record("app.receipt", { paidAt: "2026-11-24T10:00:00.000Z", cents: 1250 });
		const read = await Effect.runPromise(Receipt.read(stored));
		expect(Option.getOrThrow(read)).toEqual({ ...stored, data: { paidAt, cents: 1250 } });
		expect(Option.isNone(await Effect.runPromise(Receipt.read(record("app.note", { cents: 1 }))))).toBe(true);
	});

	it("fails with SchemaDecodeError for stored data outside the schema", async () => {
		const failure = await Effect.runPromise(Effect.flip(Receipt.read(record("app.receipt", { cents: "many" }))));
		expect(failure._tag).toBe("SchemaDecodeError");
		expect(failure.issues.map((issue) => issue.path).sort()).toEqual(["/cents", "/paidAt"]);
	});
});

describe("typed", () => {
	it("is none when nothing was found", async () => {
		const found = await Effect.runPromise(Entry.typed(Receipt, Effect.succeedNone));
		expect(Option.isNone(found)).toBe(true);
	});
});

describe("in a commit", () => {
	it("append stores what plain Pi's typed appendEntry stores, and entryOf reads it back typed", async () => {
		const both = await runBoth({
			responses: () => [],
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const appended = yield* root.commit((tx) => tx.append(Receipt, root.id, { data: { paidAt, cents: 1250 } }));
				const read = yield* root.commit((tx) =>
					Effect.all({ typed: tx.entryOf(Receipt, appended.id), raw: tx.entry(appended.id) }),
				);
				expect(appended.data).toEqual({ paidAt, cents: 1250 });
				expect(Option.getOrThrow(read.typed).data).toEqual({ paidAt, cents: 1250 });
				return Option.getOrThrow(read.raw);
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				const data = { paidAt: "2026-11-24T10:00:00.000Z", cents: 1250 };
				const appended = await root.commit((tx) => tx.appendEntry(PiReceipt, root.id, { data }), context);
				return root.commit((tx) => tx.entry(appended.id), context);
			},
		});
		expect(both.effect).toEqual(both.pi);
		expect(both.effect.records.entries).toMatchObject([
			{ kind: "app.receipt", data: { paidAt: "2026-11-24T10:00:00.000Z", cents: 1250 } },
		]);
	});

	it("fails with SchemaDecodeError before anything is appended when the data is outside the schema", async () => {
		const Small = Entry.make("app.small", Schema.Struct({ cents: Schema.Number.check(Schema.isLessThan(100)) }));
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const failure: DurableError | SchemaDecodeError = yield* Effect.flip(
					root.commit((tx) => tx.append(Small, root.id, { data: { cents: 1250 } })),
				);
				return { failure: failure._tag, entries: yield* Stream.runCollect(root.entries()) };
			}).pipe(Effect.provide(harnessLayer({}))),
		);
		expect(outcome).toEqual({ failure: "SchemaDecodeError", entries: [] });
	});
});

describe("from a hook and a conversation", () => {
	it("a hook's entryOf and a conversation's entries read the same typed entry", async () => {
		const seen: unknown[] = [];
		let receipt: EntryId | undefined;
		const Reads = Hook.afterResponse((_message, api) =>
			Effect.gen(function* () {
				const found = yield* api.entryOf(Receipt, receipt as EntryId);
				seen.push(Option.getOrThrow(found).data);
			}),
		);
		const fromEntries = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				receipt = (yield* root.commit((tx) => tx.append(Receipt, root.id, { data: { paidAt, cents: 99 } }))).id;
				yield* root.prompt("Was it paid?");
				const read = yield* Stream.runCollect(Stream.mapEffect(root.entries({ order: "ascending" }), Receipt.read));
				return read.flatMap((found) => Option.toArray(found)).map((entry) => entry.data);
			}).pipe(
				Effect.provide(
					harnessLayer({
						responses: [answer("Yes.")],
						registry: Registry.layer([Extension.make({ name: "app", hooks: [Reads] })]),
					}),
				),
			),
		);
		expect(seen).toEqual([{ paidAt, cents: 99 }]);
		expect(fromEntries).toEqual([{ paidAt, cents: 99 }]);
	});
});

describe("after", () => {
	it("is the smallest entry id after an entry: a read from it starts with the entry that follows", async () => {
		const read = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const [first, second] = yield* root.commit((tx) =>
					Effect.all([
						tx.appendEntry(root.id, { kind: "app.note" }),
						tx.appendEntry(root.id, { kind: "app.note" }),
					]),
				);
				const after = yield* Stream.runCollect(
					root.entries({ order: "ascending", minEntryId: Entry.after(first.id) }),
				);
				return { second: second.id, after: after.map((entry) => entry.id) };
			}).pipe(Effect.provide(harnessLayer({}))),
		);
		expect(read.after).toEqual([read.second]);
	});
});

describe("Id", () => {
	it("is a number in stored JSON and an entry id in the decoded value", async () => {
		const Kept = Schema.Struct({ answers: Schema.Array(Entry.Id) });
		const typed: Equal<(typeof Kept)["Type"]["answers"], ReadonlyArray<EntryId>> = true;
		const stored: Equal<(typeof Kept)["Encoded"]["answers"], ReadonlyArray<number>> = true;
		const decoded = await Effect.runPromise(
			Schema.decodeUnknownEffect(Schema.toCodecJson(Kept))({ answers: [3, 4] }),
		);
		expect([typed, stored]).toEqual([true, true]);
		expect(decoded).toEqual({ answers: [3, 4] });
	});
});
