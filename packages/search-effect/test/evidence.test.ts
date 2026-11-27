import { DateTime, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Evidence, ProviderName, type Retrieval } from "../src/provider/index.ts";

const RAW = '{"results": [ {"url":"https://a.example/","score":1.0} ]}';

const retrieval: Retrieval = {
	provider: ProviderName.make("exa"),
	request: { method: "POST", url: "https://api.exa.ai/search", body: { query: "q", numResults: 3 } },
	retrievedAt: DateTime.makeUnsafe("2026-11-25T12:00:00.000Z"),
	raw: RAW,
	hits: [{ url: "https://a.example/", score: 1 }],
	unfetched: [],
};

describe("Evidence", () => {
	it("has a JSON form with the body as it came and the time as ISO 8601, without the hits", async () => {
		expect(await Effect.runPromise(Evidence.toJson(retrieval))).toStrictEqual({
			provider: ProviderName.make("exa"),
			request: { method: "POST", url: "https://api.exa.ai/search", body: { query: "q", numResults: 3 } },
			retrievedAt: "2026-11-25T12:00:00.000Z",
			raw: RAW,
		});
	});

	it("reads its JSON form back, after a trip through text as a store makes it", async () => {
		const stored = JSON.stringify(await Effect.runPromise(Evidence.toJson(retrieval)));
		const evidence = await Effect.runPromise(Evidence.fromJson(JSON.parse(stored)));
		expect(evidence.raw).toBe(RAW);
		expect(DateTime.toEpochMillis(evidence.retrievedAt)).toBe(Date.UTC(2026, 10, 25, 12));
		expect(evidence.request).toStrictEqual(retrieval.request);
		expect(evidence.provider).toBe("exa");
	});

	it("fails on JSON that is not evidence", async () => {
		const error = await Effect.runPromise(
			Effect.flip(Evidence.fromJson({ provider: ProviderName.make("exa"), raw: 1 })),
		);
		expect(error._tag).toBe("SchemaError");
		expect((await Effect.runPromise(Effect.flip(Evidence.fromJson(undefined))))._tag).toBe("SchemaError");
	});
});
