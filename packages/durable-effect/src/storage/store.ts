// `@effectified/pi-durable/storage/store`: Pi's storage on a Chord store, as a storage Layer.

import { StoreStorage } from "@earendil-works/pi-durable/storage/store";
import type { Store } from "@effectified/pi-chord";
import type { Layer } from "effect";
import { call } from "../call.ts";
import type { DurableError } from "../errors.ts";
import { custom, type HarnessStorage } from "../storage.ts";

/**
 * Pi's storage on the Chord store `store` (`Store.open` of `@effectified/pi-chord`), under `owner`, a lowercase
 * `[a-z0-9@/._~-]` name: its records as tables of the store, its documents in the store's documents, its ids from the
 * store's allocator, each commit one step of the store's commit queue. Several harnesses share a store under distinct
 * owners; a second claim of one owner fails with `UnexpectedError`. Closing the harness or the Layer's scope releases
 * the claim and leaves the store open: the scope that opened the store closes it.
 */
export function store(store: Store.Store, owner: string): Layer.Layer<HarnessStorage, DurableError> {
	return custom(call((context) => StoreStorage.open(store, owner, context)));
}
