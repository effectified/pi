// A Worker that runs the Cloudflare entries in workerd: Pi's SQLite storage in a SQLite-backed Durable Object, and the
// Photon processor on Wrangler's compiled WebAssembly module. Bundled and served by
// `test/storage/sqlite/cloudflare.node.test.ts` and `test/images/cloudflare.node.test.ts`.

import type { ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@effectified/pi-chord/context";
import { Effect, Layer, Option } from "effect";
import { cloudflarePhoton } from "../../src/images/cloudflare.ts";
import { Storage } from "../../src/index.ts";
import { type DurableObjectSqliteStorage, database, durableObject } from "../../src/storage/sqlite/cloudflare.ts";
import { sqlite } from "../../src/storage/sqlite/index.ts";
import { Benchmark } from "../../src/testing/index.ts";

interface Env {
	readonly STORE: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
}

/** Commits a conversation to the storage of `layer` and reads it back from a second build of it. */
const roundTrip = (layer: Layer.Layer<Storage.HarnessStorage, unknown>, id: ConversationId) =>
	Effect.gen(function* () {
		yield* Effect.provide(Benchmark.commitWrites([{ type: "conversation", value: { id } }]), layer);
		return yield* Effect.provide(
			Storage.HarnessStorage.use((storage) => Effect.promise(() => storage.conversation(id, BACKGROUND_CONTEXT))),
			layer,
		);
	});

/** A SQLite-backed Durable Object: two of Pi's storages in it, under two prefixes, through both entries. */
export class Store {
	readonly #storage: DurableObjectSqliteStorage;

	constructor(state: { readonly storage: DurableObjectSqliteStorage }) {
		this.#storage = state.storage;
	}

	fetch(): Promise<Response> {
		const storage = this.#storage;
		return Effect.runPromise(
			Effect.gen(function* () {
				const direct = yield* roundTrip(durableObject(storage, { prefix: "pi_" }), 1 as ConversationId);
				const chord = yield* roundTrip(
					Layer.unwrap(Effect.map(database(storage), (opened) => sqlite(opened, { prefix: "chord_" }))),
					2 as ConversationId,
				);
				return Response.json({ direct, chord });
			}),
		);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (path === "/storage") return env.STORE.getByName("one").fetch(request);
		const bytes = new Uint8Array(await request.arrayBuffer());
		return Effect.runPromise(
			Effect.gen(function* () {
				const processor = yield* cloudflarePhoton;
				const prepared = yield* processor.prepare(bytes, "image/png", {
					maxWidth: 20,
					maxHeight: 20,
					maxBytes: 100_000,
				});
				return Response.json(
					Option.getOrNull(
						Option.map(prepared, (image) => ({ mimeType: image.mimeType, resized: image.resized })),
					),
				);
			}),
		);
	},
};
