// A client identity for a part of a program: every request of Models inside carries it.

import type { ClientIdentity, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { complete, PI_ATTRIBUTION, withClientIdentity } from "../src/index.ts";
import { fauxAssistantMessage, runTest, ScriptedModels } from "../src/testing/index.ts";

describe("withClientIdentity", () => {
	it("gives requests inside the identity, a request's own fields winning, and leaves requests outside alone", async () => {
		const identities = await runTest(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const seen: Array<ClientIdentity | undefined> = [];
				const record = (_context: unknown, options: SimpleStreamOptions | undefined) => {
					seen.push(options?.identity);
					return fauxAssistantMessage("");
				};
				yield* scripted.setResponses([record, record, record]);
				yield* complete(scripted.model, { messages: [] }).pipe(
					withClientIdentity({ attribution: PI_ATTRIBUTION, userAgent: "short" }),
				);
				yield* complete(scripted.model, { messages: [] }, { identity: { userAgent: { custom: "own" } } }).pipe(
					withClientIdentity({ attribution: PI_ATTRIBUTION, userAgent: "short" }),
				);
				yield* complete(scripted.model, { messages: [] });
				return seen;
			}).pipe(Effect.provide(ScriptedModels.layer())),
		);
		expect(identities).toEqual([
			{ attribution: PI_ATTRIBUTION, userAgent: "short" },
			{ attribution: PI_ATTRIBUTION, userAgent: { custom: "own" } },
			undefined,
		]);
	});
});
