import type { EntryRecord } from "@earendil-works/pi-durable";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { MalformedRefusal, Refused } from "../src/index.ts";

describe("Refused", () => {
	it("is the rule and the name of an argument rule, and holds neither arguments nor a reason", () => {
		expect(Object.keys(Refused.Refused.fields).sort()).toEqual(["name", "rule"]);
		const record = { rule: "argument", name: "no-secrets" };
		expect(Schema.decodeUnknownSync(Refused.Refused)(record)).toEqual(record);
		expect(() => Schema.decodeUnknownSync(Refused.Refused)({ rule: "other" })).toThrow();
		expect(Refused.KEY).toBe("guard");
	});
});

describe("fromDetails", () => {
	const read = (details: unknown) => Effect.runPromise(Refused.fromDetails(details));

	it("reads the record under the guard's key, beside what else the details hold", async () => {
		expect(await read({ guard: { rule: "allow-list" }, approvals: { outcome: "none" } })).toEqual(
			Option.some({ rule: "allow-list" }),
		);
		expect(await read({ guard: { rule: "argument-failed", name: "broken" } })).toEqual(
			Option.some({ rule: "argument-failed", name: "broken" }),
		);
	});

	it("is none for details without the key, and for details that are no object", async () => {
		for (const details of [undefined, null, "text", 3, ["guard"], {}, { other: { rule: "denied" } }]) {
			expect(await read(details)).toEqual(Option.none());
		}
	});

	it("fails with MalformedRefusal for a record that does not decode", async () => {
		const error = await Effect.runPromise(Effect.flip(Refused.fromDetails({ guard: { rule: "something else" } })));
		expect(error).toBeInstanceOf(MalformedRefusal);
		expect(error.message).toMatch(/^details\.guard: /);
	});
});

describe("of", () => {
	it("is none for an entry that is no tool result", async () => {
		// The shape of a custom entry as Pi stores it; `of` reads only its kind and its first model message.
		const note = { id: 1, conversationId: 1, kind: "app.note", data: null, timestamp: 0 } as unknown as EntryRecord;
		expect(await Effect.runPromise(Refused.of(note))).toEqual(Option.none());
	});
});
