// A client's transcript of one conversation in Effect: Pi's `ConversationTranscript` over the conversation's view,
// with its loads as Effects.

import {
	type ConversationId,
	ConversationTranscript,
	type ConversationTranscriptOptions,
	type ConversationView,
	type ConversationWindow,
	type EntryId,
	type Conversation as PiConversation,
	type TranscriptItem,
	type TranscriptView,
} from "@earendil-works/pi-durable";
import { Effect, Option, Stream } from "effect";
import { call } from "./call.ts";
import type * as Conversation from "./conversation.ts";
import { type DurableError, UnexpectedError } from "./errors.ts";

/** A gap of a transcript: entries strictly between `after` and `upTo` are missing; `fillGap` loads them. */
export type Gap = Extract<TranscriptItem, { readonly kind: "gap" }>;

/**
 * What a client has of one conversation: every entry it got from the conversation's view or loaded, and the gaps
 * between. The transcript only grows: entries never change once committed, and a window that dropped its oldest
 * entries keeps them here. Made by a conversation's `transcript`.
 */
export interface Transcript {
	/** The conversation it belongs to. */
	readonly conversationId: ConversationId;
	/** Takes one value of the view: its window's entries join the transcript, which it returns as `items`. */
	readonly merge: (view: ConversationView) => Effect.Effect<TranscriptView>;
	/** Loads the page before the oldest entry held; without anything earlier, the current view. */
	readonly loadEarlier: Effect.Effect<TranscriptView, DurableError>;
	/** Loads the entries of `gap`, a page at a time. */
	readonly fillGap: (gap: Gap) => Effect.Effect<TranscriptView, DurableError>;
	/** The newest entry the transcript reaches; none before the first merge and for an empty transcript. */
	readonly newest: Effect.Effect<Option.Option<EntryId>>;
	/**
	 * The window that resumes this transcript after a dropped view: give it to the conversation's `changes`, which then
	 * returns only what was missed when it fits its window. None before the first merge.
	 */
	readonly resume: Effect.Effect<Option.Option<ConversationWindow>>;
}

/** Options of a transcript. */
export interface Options {
	/** Entries `loadEarlier` and `fillGap` load per call; Pi's default 50. An integer, `1` or more. */
	readonly pageSize?: ConversationTranscriptOptions["pageSize"];
}

/** Options of `stream`. */
export interface StreamOptions extends Options {
	/** The window of the view, as for `changes`. */
	readonly window?: ConversationWindow;
}

/** One element of `stream`: the transcript, whose loads add to the views that follow, and its view now. */
export interface Element {
	readonly transcript: Transcript;
	readonly view: TranscriptView;
}

/**
 * The conversation's view kept as its whole transcript: a new transcript, and every value of the view
 * (`changes`) merged into it, as Pi's `ConversationTranscript` merges it. Load earlier pages and fill gaps with the
 * element's `transcript`. Closing the stream's scope releases the view.
 */
export function stream(
	conversation: Conversation.Conversation,
	options?: StreamOptions,
): Stream.Stream<Element, DurableError> {
	return Stream.unwrap(
		Effect.map(conversation.transcript(options), (transcript) =>
			Stream.mapEffect(conversation.changes(options?.window), (change) =>
				Effect.map(transcript.merge(change.value), (view) => ({ transcript, view })),
			),
		),
	);
}

/**
 * A new, empty transcript of Pi's conversation, paging its entries. Fails with `UnexpectedError` when `pageSize` is
 * not an integer `1` or more, as Pi's constructor throws.
 */
export function fromPi(conversation: PiConversation, options?: Options): Effect.Effect<Transcript, DurableError> {
	return Effect.map(
		Effect.try({
			try: () =>
				new ConversationTranscript(
					(query, limit, context) => conversation.entries(query, limit, undefined, context),
					options,
				),
			catch: (cause) => new UnexpectedError({ cause }),
		}),
		(transcript): Transcript => ({
			conversationId: conversation.id,
			merge: (view) => Effect.sync(() => transcript.merge(view)),
			loadEarlier: call((context) => transcript.loadEarlier(context)),
			fillGap: (gap) => call((context) => transcript.fillGap(gap, context)),
			newest: Effect.sync(() => Option.fromUndefinedOr(transcript.newest)),
			resume: Effect.sync(() => Option.fromUndefinedOr(transcript.resume)),
		}),
	);
}
