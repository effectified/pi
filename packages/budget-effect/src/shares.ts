// Shares: what one conversation has settled of the harness's lease, and a cap of its own, kept in the harness storage.

import { SessionId } from "@effectified/pi-ai";
import type { ConversationId } from "@effectified/pi-durable";
import { BuiltinDoc, Conversation, Doc, Harness, type Tx } from "@effectified/pi-durable";
import { Context, Deferred, Effect, Layer, Option, Schema } from "effect";

/** An amount in micro units as stored: a decimal text, since a document is JSON. */
const StoredMicros = Schema.BigIntFromString.check(Schema.isGreaterThanOrEqualToBigInt(0n));

/**
 * What a conversation's requests have settled so far, and its cap when it has one, in micro units of the budget's
 * currency. A share without a cap only counts.
 *
 * `settled` is what this harness storage settled. `inherited` is there only in a storage that was copied from another
 * one (`onStorageFork`): what the conversation had settled before the copy, in the storages this one descends from.
 * A cap counts both; money summed over storages counts `settled` alone.
 */
export const Share = Schema.Struct({
	conversation: Conversation.Id,
	// Any sign: `setCap` takes any amount, and a cap below zero refuses every request of the conversation. Shares
	// stored before 0.3.0 may hold one.
	cap: Schema.optional(Schema.BigIntFromString),
	settled: StoredMicros,
	inherited: Schema.optional(StoredMicros),
});

/** What a conversation's requests have settled so far, and its cap when it has one. */
export type Share = typeof Share.Type;

/** The conversation does not exist, or Pi has given it no provider session, so no request can be attributed to it. */
export class NoProviderSession extends Schema.TaggedError<NoProviderSession, { readonly brand: unique symbol }>()(
	"NoProviderSession",
	{ conversation: Conversation.Id },
) {
	override get message(): string {
		return `Conversation ${this.conversation} has no provider session`;
	}
}

/**
 * The shares of one budget. `setCap`, `track` and `get` wait until `Shares.attach` has given them the open harness;
 * `setCapIn` and `trackIn` write through the commit they are given.
 */
export interface SharesService {
	/**
	 * Gives `conversation` a cap of `cap` micro units, or changes its cap, in one commit; what it has settled stays.
	 * From then on a request of the conversation is refused with `ShareExhausted` once it has settled at least `cap`,
	 * counting what a copied conversation had settled before the copy (`Share.inherited`).
	 */
	readonly setCap: (
		conversation: ConversationId,
		cap: bigint,
	) => Effect.Effect<Share, Doc.Failure | NoProviderSession>;
	/**
	 * `setCap` inside the commit of `tx`: the cap is stored with that commit or not at all. In the commit that creates
	 * `conversation`, the conversation never exists without its cap, and its first request counts against it. Fails,
	 * and so fails the commit, for a conversation that does not exist.
	 */
	readonly setCapIn: (tx: Tx.Tx, conversation: ConversationId, cap: bigint) => Effect.Effect<Share, Doc.Failure>;
	/**
	 * Gives `conversation` a share without a cap, in one commit, so that what it settles is counted and stored: the
	 * way to read what a conversation that needs no cap has spent. A share it already has stays as it is, cap included.
	 */
	readonly track: (conversation: ConversationId) => Effect.Effect<Share, Doc.Failure | NoProviderSession>;
	/** `track` inside the commit of `tx`, as `setCapIn` is to `setCap`. */
	readonly trackIn: (tx: Tx.Tx, conversation: ConversationId) => Effect.Effect<Share, Doc.Failure>;
	/**
	 * What `conversation` has settled in this storage, its cap if it has one, and in a copied storage what it had
	 * settled before the copy (`inherited`), as stored: one committed read. None for a conversation that was given no
	 * share, whose requests are counted nowhere.
	 */
	readonly get: (conversation: ConversationId) => Effect.Effect<Option.Option<Share>, Doc.Failure>;
}

/**
 * Shares for single conversations of a harness: every conversation draws on the harness's lease, what one with a
 * share settles is counted and stored, and one with a cap (a subagent) stops when it has settled that much while the
 * others go on.
 */
export class Shares extends Context.Service<Shares, SharesService>()("@effectified/pi-budget/shares") {
	/**
	 * The shares of a budget, before its harness is open: `BudgetedModels.layerWithShares` needs them to build the
	 * `Models` the harness is opened with. Every request that names a session, and every Effect of the service that
	 * takes no commit, waits until `attach` has run.
	 */
	static readonly layer: Layer.Layer<Shares> = Layer.effect(
		Shares,
		Effect.gen(function* () {
			const ledger: Ledger = {
				store: yield* Deferred.make<Harness.Open>(),
				bySession: new Map(),
				changed: new Set(),
			};
			const service = Shares.of({
				setCap: Effect.fn("Shares.setCap")(function* (conversation, cap) {
					return yield* stored(ledger, share(ledger, conversation, cap));
				}),
				setCapIn: Effect.fn("Shares.setCapIn")(function* (tx, conversation, cap) {
					return yield* shareIn(ledger, tx, conversation, cap);
				}),
				track: Effect.fn("Shares.track")(function* (conversation) {
					return yield* stored(ledger, share(ledger, conversation, undefined));
				}),
				trackIn: Effect.fn("Shares.trackIn")(function* (tx, conversation) {
					return yield* shareIn(ledger, tx, conversation, undefined);
				}),
				get: Effect.fn("Shares.get")(function* (conversation) {
					const session = yield* stored(ledger, sessionOf(conversation));
					if (Option.isNone(session)) return Option.none();
					return yield* stored(ledger, Harness.snapshot(ShareDocument, session.value));
				}),
			});
			ledgers.set(service, ledger);
			return service;
		}),
	);

	/**
	 * Gives the shares the open harness, where they are stored: build it on top of `Harness.layer`. A harness that
	 * continues unfinished work as it opens may send a request before this ran; that request waits for it, so no cap
	 * is skipped after a restart.
	 */
	static readonly attach: Layer.Layer<never, never, Shares | Harness.Harness> = Layer.effectDiscard(
		Effect.gen(function* () {
			const harness = yield* Harness.Harness;
			const shares = yield* Shares;
			yield* Deferred.succeed(ledgerOf(shares).store, harness);
		}),
	);
}

/** What the budget knows of one session while it runs: its conversation's share, counted up as requests settle. */
export interface ShareState {
	readonly conversation: ConversationId;
	/** Undefined for a share that only counts. */
	cap: bigint | undefined;
	settled: bigint;
	/** What the conversation had settled before its storage was copied; zero in a storage that was never copied. */
	inherited: bigint;
}

/** What counts against the cap of `share`: what this storage settled, and what was settled before it was copied. */
export function counted(share: ShareState): bigint {
	return share.inherited + share.settled;
}

/**
 * The share of the conversation `session` belongs to; none when it has none. Read from the harness storage the first
 * time a session is seen, and again after its share was written, then kept in memory, where `addSettled` counts.
 */
export const shareOfSession = Effect.fn("Shares.shareOfSession")(function* (
	shares: SharesService,
	session: SessionId,
): Effect.fn.Return<Option.Option<ShareState>, Doc.Failure> {
	const ledger = ledgerOf(shares);
	const known = ledger.bySession.get(session);
	// A mark set while this read is under way stays for the next request: it is taken off before the read.
	const written = ledger.changed.delete(session);
	if (known !== undefined && !written) return known;
	const found = yield* stored(ledger, Harness.snapshot(ShareDocument, session)).pipe(
		// The share is still to be read: a failed read must not leave the old one in force.
		Effect.tapCause(() => Effect.sync(() => ledger.changed.add(session))),
	);
	return adopt(ledger, session, found);
});

/**
 * Takes the stored share of `session` into memory. What memory counted stays: of two requests of one session, the
 * second may have read while the first settled, and a stored total may lag behind by a commit. The cap and what was
 * inherited are the stored ones.
 */
function adopt(ledger: Ledger, session: SessionId, found: Option.Option<Share>): Option.Option<ShareState> {
	const current = ledger.bySession.get(session);
	const counting = current === undefined ? undefined : Option.getOrUndefined(current);
	if (counting === undefined) {
		const state = Option.map(found, ({ conversation, cap, settled, inherited }): ShareState => ({
			conversation,
			cap,
			settled,
			inherited: inherited ?? 0n,
		}));
		ledger.bySession.set(session, state);
		return state;
	}
	if (Option.isSome(found)) {
		counting.cap = found.value.cap;
		counting.inherited = found.value.inherited ?? 0n;
	}
	return Option.some(counting);
}

/**
 * Adds the cost of a settled request to the session's share and stores the new total in one commit. A request's
 * settlement must not fail for it: a commit that fails (the harness closed meanwhile) is logged, and the stored
 * total then lacks this request until the session's next one settles.
 */
export const addSettled = Effect.fn("Shares.addSettled")(function* (
	shares: SharesService,
	session: SessionId,
	state: ShareState,
	cost: bigint,
) {
	if (cost === 0n) return;
	state.settled += cost;
	const store = Harness.commit((tx) =>
		Effect.flatMap(tx.doc(ShareDocument, session, seedOf(state)), (share) =>
			// Read as the body runs: of two commits in a row, the later one stores the newer total.
			share.update((current) => ({ ...current, settled: state.settled })),
		),
	);
	yield* Effect.catchCause(stored(ledgerOf(shares), store), (cause) =>
		Effect.logWarning("A conversation's settled budget was not stored", cause),
	);
});

/**
 * The state of one `Shares`: the harness once attached, and the shares of the sessions seen so far. Keyed by the
 * session's text, which a native `Map` already compares by value.
 */
interface Ledger {
	readonly store: Deferred.Deferred<Harness.Open>;
	/** A session read and found without a share holds none, so it is not read for every request. */
	readonly bySession: Map<string, Option.Option<ShareState>>;
	/**
	 * The sessions whose share a commit wrote since it was last read. The next request of such a session reads the
	 * stored share again, so it sees what the commit stored, and nothing when the commit was rolled back.
	 */
	readonly changed: Set<string>;
}

// Keyed by the service and held weakly: the service a product sees has only what a product may call.
const ledgers = new WeakMap<SharesService, Ledger>();

function ledgerOf(shares: SharesService): Ledger {
	// Every `SharesService` is made by `Shares.layer`, which registers it; TypeScript cannot say so of a WeakMap.
	return ledgers.get(shares) as Ledger;
}

/**
 * Makes `shares` read the shares of `sessions` from the harness storage again with their next request, and drop what
 * it counted for them in memory: for a writer that replaced their stored totals while no request was under way.
 */
export const forget = Effect.fn("Shares.forget")(function* (shares: SharesService, sessions: ReadonlyArray<string>) {
	const ledger = ledgerOf(shares);
	for (const session of sessions) {
		ledger.bySession.delete(session);
		ledger.changed.delete(session);
	}
});

/** Runs `effect` on the attached harness, waiting for it first. */
function stored<A, E>(ledger: Ledger, effect: Effect.Effect<A, E, Harness.Harness>): Effect.Effect<A, E> {
	return Effect.provideServiceEffect(effect, Harness.Harness, Deferred.await(ledger.store));
}

/**
 * The document of a share, kind `budget.share`: one per conversation with a share, keyed by its provider session
 * (`sessionId` of Pi's `pi.provider`), which is what a request carries. Session scope, so a fork of a conversation
 * starts without a share, as it starts with a provider session of its own.
 *
 * Exported for a host that decides about the shares a copied storage holds, where the service's own Effects do not
 * reach: to read one in a commit, or to retire one (`tx.retireDoc(ShareDocument, session)`). Write and retire only
 * before the storage's first request, as a host's fork hygiene runs: a `Shares` that has counted a session in memory
 * stores its own total again with that session's next settlement.
 */
export const ShareDocument = Doc.family({
	kind: "budget.share",
	version: 1,
	scope: "session",
	schema: Share,
	initial: (seed: { readonly conversation: ConversationId; readonly cap: string | null }) => ({
		conversation: seed.conversation,
		...(seed.cap === null ? {} : { cap: BigInt(seed.cap) }),
		settled: 0n,
	}),
	// Three small fields: every change is stored whole.
	checkpointWhen: () => true,
});

/** What a missing share document is created from: the conversation, and its cap as text, since a seed is JSON. */
export function seedOf(share: { readonly conversation: ConversationId; readonly cap?: bigint | undefined }) {
	return { conversation: share.conversation, cap: share.cap === undefined ? null : String(share.cap) };
}

/**
 * Gives `conversation` a share in a commit of its own: with `cap`, or without one, in which case a share it already
 * has keeps its cap.
 */
const share = Effect.fn("Shares.share")(function* (
	ledger: Ledger,
	conversation: ConversationId,
	cap: bigint | undefined,
) {
	const session = yield* sessionOf(conversation);
	if (Option.isNone(session)) return yield* NoProviderSession.make({ conversation });
	return yield* Harness.commit((tx) => write(ledger, tx, session.value, conversation, cap));
});

/**
 * `share` inside the commit of `tx`. The session is read through the commit: Pi creates a conversation's
 * `pi.provider` in the commit that creates the conversation, so it is there for a conversation `tx` just made, and
 * Pi fails the commit for a conversation that does not exist.
 */
const shareIn = Effect.fn("Shares.shareIn")(function* (
	ledger: Ledger,
	tx: Tx.Tx,
	conversation: ConversationId,
	cap: bigint | undefined,
) {
	const provider = yield* tx.doc(BuiltinDoc.provider, conversation);
	const { sessionId } = yield* provider.get;
	// Pi's provider session is a plain string: branded where it enters the budget.
	return yield* write(ledger, tx, SessionId.make(sessionId), conversation, cap);
});

/** Writes the share of `session` through `tx`, and marks it to be read again by the session's next request. */
const write = Effect.fn("Shares.write")(function* (
	ledger: Ledger,
	tx: Tx.Tx,
	session: SessionId,
	conversation: ConversationId,
	cap: bigint | undefined,
) {
	const opened = yield* tx.doc(ShareDocument, session, seedOf({ conversation, cap }));
	if (cap !== undefined) yield* opened.update((current) => ({ ...current, cap }));
	// Marked while the commit is open: it may still be rolled back, and what is stored is what the next read finds.
	ledger.changed.add(session);
	return yield* opened.get;
});

/** The provider session Pi sends with every request of `conversation`; none when the conversation has none. */
export const sessionOf = Effect.fn("Shares.sessionOf")(function* (
	conversation: ConversationId,
): Effect.fn.Return<Option.Option<SessionId>, Doc.Failure, Harness.Harness> {
	const provider = yield* Harness.snapshot(BuiltinDoc.provider, conversation);
	return Option.map(provider, (state) => SessionId.make(state.sessionId));
});
