// Stored history as a Stream: Pi Durable's paged entry reads, pulled page by page.

import type { Context } from "@earendil-works/chord/context";
import type { Cursor, EntryQuery, EntryRecord, Page } from "@earendil-works/pi-durable";
import { Effect, Option, Stream } from "effect";
import { call } from "./call.ts";
import type { DurableError } from "./errors.ts";

/** Which entries a stream reads, and how many per storage read. */
export interface EntriesQuery extends Omit<EntryQuery, "conversationId"> {
	/** Entries per page read from storage. Default 100. */
	readonly pageSize?: number;
}

/** One paged read of Pi: a conversation's `entries`, or a hook api's. */
export type ReadPage = (
	query: Omit<EntryQuery, "conversationId">,
	limit: number,
	cursor: Cursor | undefined,
	context: Context,
) => Promise<Page<EntryRecord, Cursor>>;

const DEFAULT_PAGE_SIZE = 100;

/** The entries `read` gives for `query`, one page per pull; `parent` as for `call`. */
export function stream(
	read: ReadPage,
	{ pageSize = DEFAULT_PAGE_SIZE, ...query }: EntriesQuery = {},
	parent?: Context,
): Stream.Stream<EntryRecord, DurableError> {
	return Stream.paginate(undefined as Cursor | undefined, (cursor) =>
		Effect.map(
			call((context) => read(query, pageSize, cursor, context), parent),
			(page) => [page.items, Option.fromNullishOr(page.next)] as const,
		),
	);
}
