// `@effectified/pi-durable/storage/indexeddb`: Pi's storage on a browser's IndexedDB, as a storage Layer.

import { IndexedDbStorage, type IndexedDbStorageOptions } from "@earendil-works/pi-durable/storage/indexeddb";
import type { Layer } from "effect";
import { call } from "../call.ts";
import type { DurableError } from "../errors.ts";
import { custom, type HarnessStorage } from "../storage.ts";

export type { IndexedDbStorageOptions } from "@earendil-works/pi-durable/storage/indexeddb";

/**
 * Pi's storage on the IndexedDB database `name`, created on first use, of the page's `indexedDB` or of the factory
 * `options.indexedDB` gives. Closing the harness or the Layer's scope closes the database. Fails with
 * `UnexpectedError` where IndexedDB is not available.
 */
export function indexedDb(name: string, options?: IndexedDbStorageOptions): Layer.Layer<HarnessStorage, DurableError> {
	return custom(call(() => IndexedDbStorage.open(name, options)));
}
