// Table scans as Streams: Pi Durable's paged scans of conversations and tasks, read page by page as they are pulled.

import type { JsonValue } from "@earendil-works/chord/json";
import type {
	ConversationQuery,
	ConversationRecord,
	Cursor,
	Page,
	Tx as PiTx,
	TaskQuery,
	TaskRecord,
} from "@earendil-works/pi-durable";
import { Effect, Option, Stream } from "effect";
import type { DurableError } from "./errors.ts";

/** Which conversations a scan reads: Pi's filters (an owner task, an owner conversation, the order) and a page size. */
export interface ConversationsQuery extends ConversationQuery {
	/** Conversations per page read from storage. Default 100. */
	readonly pageSize?: number;
}

/**
 * Which tasks a scan reads: Pi's filters (conversation, kind, status, abort mark, background flag, the order) and a
 * page size.
 */
export interface TasksQuery extends TaskQuery {
	/** Tasks per page read from storage. Default 100. */
	readonly pageSize?: number;
}

/**
 * One read on Pi's transaction: Pi has table scans only inside a commit. The harness's scans run each read in a commit
 * of its own that writes nothing, which stores and publishes nothing and waits its turn on the harness's line of
 * commits; a `Tx`'s scans run it in the commit of that `Tx`.
 */
export type Read = <A>(read: (tx: PiTx) => Promise<A>) => Effect.Effect<A, DurableError>;

const DEFAULT_PAGE_SIZE = 100;

/**
 * The conversations `query` selects, in id order, one page per pull. When each page is a commit of its own, the stream
 * is not one point in time: a conversation created while it is read appears when its id is still ahead.
 */
export function conversations(
	read: Read,
	{ pageSize = DEFAULT_PAGE_SIZE, ...query }: ConversationsQuery = {},
): Stream.Stream<ConversationRecord, DurableError> {
	return paged((cursor) => read((tx) => tx.scanConversations(query, pageSize, cursor)));
}

/**
 * The tasks `query` selects, in id order, one page per pull. When each page is a commit of its own, the stream is not
 * one point in time: a task that changes its status while it is read may appear under either status, or not at all.
 */
export function tasks(
	read: Read,
	{ pageSize = DEFAULT_PAGE_SIZE, ...query }: TasksQuery = {},
): Stream.Stream<TaskRecord<JsonValue, JsonValue, JsonValue>, DurableError> {
	return paged((cursor) => read((tx) => tx.scanTasks(query, pageSize, cursor)));
}

/** The items of a paged scan, one page per pull, until a page names no next one. */
function paged<A>(
	page: (cursor: Cursor | undefined) => Effect.Effect<Page<A, Cursor>, DurableError>,
): Stream.Stream<A, DurableError> {
	return Stream.paginate(undefined as Cursor | undefined, (cursor) =>
		Effect.map(page(cursor), ({ items, next }) => [items, Option.fromUndefinedOr(next)] as const),
	);
}
