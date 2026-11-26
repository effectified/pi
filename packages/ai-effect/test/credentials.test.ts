// The credential store as an Effect service, on pi-ai's own memory store, and handed back to pi-ai as its store.

import { type Credential, type CredentialStore, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Effect, Option, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { toPiStore } from "../src/credentials.ts";
import {
	CredentialStoreError,
	Credentials,
	type RedactedOAuthCredential,
	redactCredential,
	revealCredential,
} from "../src/index.ts";
import { currentRunner } from "../src/run-in-pi.ts";
import { runTest } from "../src/testing/index.ts";

class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

const OAUTH: Credential = { type: "oauth", access: "access", refresh: "refresh", expires: 10, accountId: "acct" };

describe("redactCredential and revealCredential", () => {
	it("redact every secret, keep the other fields, and give pi-ai's credential back", () => {
		const apiKey: Credential = { type: "api_key", key: "secret", env: { ACCOUNT: "a" } };
		const redacted = redactCredential(OAUTH) as RedactedOAuthCredential;
		expect(String(redacted.access)).not.toContain("access");
		expect(redacted.accountId).toBe("acct");
		expect(revealCredential(redacted)).toEqual(OAUTH);
		expect(revealCredential(redactCredential(apiKey))).toEqual(apiKey);
		expect(revealCredential(redactCredential({ type: "api_key" }))).toEqual({ type: "api_key" });
	});
});

describe("Credentials.layerMemory", () => {
	it("reads, lists, writes and deletes, with secrets redacted", async () => {
		const result = await runTest(
			Effect.gen(function* () {
				const credentials = yield* Credentials;
				const empty = yield* credentials.read("p");
				const written = yield* credentials.modify("p", () =>
					Effect.succeed(Option.some(redactCredential({ type: "api_key", key: "k" }))),
				);
				const read = yield* credentials.read("p");
				const kept = yield* credentials.modify("p", () => Effect.succeed(Option.none()));
				const listed = yield* credentials.list;
				yield* credentials.delete("p");
				return { empty, written, read, kept, listed, deleted: yield* credentials.read("p") };
			}).pipe(Effect.provide(Credentials.layerMemory)),
		);
		const key = (credential: typeof result.read) =>
			Option.map(credential, (stored) =>
				stored.type === "api_key" && stored.key ? Redacted.value(stored.key) : "",
			);
		expect(result.empty).toEqual(Option.none());
		expect(key(result.written)).toEqual(Option.some("k"));
		expect(key(result.read)).toEqual(Option.some("k"));
		expect(key(result.kept)).toEqual(Option.some("k"));
		expect(result.listed).toEqual([{ providerId: "p", type: "api_key" }]);
		expect(result.deleted).toEqual(Option.none());
	});

	it("fails a write with the failure of its function and keeps the credential", async () => {
		const result = await runTest(
			Effect.gen(function* () {
				const credentials = yield* Credentials;
				yield* credentials.modify("p", () => Effect.succeed(Option.some(redactCredential(OAUTH))));
				const failure = yield* Effect.flip(credentials.modify("p", () => Effect.fail(new Refused())));
				return { failure, still: yield* credentials.read("p") };
			}).pipe(Effect.provide(Credentials.layerMemory)),
		);
		expect(result.failure).toBeInstanceOf(Refused);
		expect(Option.map(result.still, revealCredential)).toEqual(Option.some(OAUTH));
	});
});

describe("Credentials.fromPiStore", () => {
	it("fails with CredentialStoreError when the store rejects", async () => {
		const broken: CredentialStore = {
			read: () => Promise.reject(new Error("disk full")),
			list: () => Promise.reject(new Error("disk full")),
			modify: () => Promise.reject(new Error("disk full")),
			delete: () => Promise.reject(new Error("disk full")),
		};
		const failures = await runTest(
			Effect.gen(function* () {
				const credentials = Credentials.fromPiStore(broken);
				return [
					yield* Effect.flip(credentials.read("p")),
					yield* Effect.flip(credentials.list),
					yield* Effect.flip(credentials.modify("p", () => Effect.succeed(Option.none()))),
					yield* Effect.flip(credentials.delete("p")),
				];
			}),
		);
		for (const failure of failures) {
			expect(failure).toBeInstanceOf(CredentialStoreError);
			expect(failure.message).toBe("disk full");
		}
	});
});

describe("toPiStore", () => {
	it("gives pi-ai the credentials in the clear, and its own failure inside modify as it was thrown", async () => {
		const thrown = new Error("refresh failed");
		const result = await runTest(
			Effect.gen(function* () {
				const store = toPiStore(
					Credentials.fromPiStore(new InMemoryCredentialStore()),
					yield* currentRunner<never>(),
				);
				return yield* Effect.promise(async () => {
					const written = await store.modify("p", async () => OAUTH);
					const failure = await store.modify("p", () => Promise.reject(thrown)).catch((error: unknown) => error);
					return { written, read: await store.read("p"), list: await store.list(), failure };
				});
			}),
		);
		expect(result).toEqual({
			written: OAUTH,
			read: OAUTH,
			list: [{ providerId: "p", type: "oauth" }],
			failure: thrown,
		});
		expect(result.failure).toBe(thrown);
	});
});
