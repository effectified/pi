// `@effectified/pi-durable/storage/jsonl`: Pi's JSONL storage as a storage Layer, on any environment's file system.

export type { JsonlStorage, JsonlStorageOptions } from "@earendil-works/pi-durable/storage/jsonl";
export { JsonlCorrupted, type JsonlError, JsonlPoisoned, JsonlReadOnly, jsonl } from "./storage.ts";
