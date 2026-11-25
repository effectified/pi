// The lease port: the money a product reserves for each provider request and settles after it.

import { Context, type Effect, Schema } from "effect";
import { TokenUsage } from "./price-table.ts";

/** One provider request as the budget sees it: what it asks of which model, and for whom. Never its content. */
export const BudgetRequest = Schema.Struct({
	/**
	 * `chat` is a response of a chat model; `deferred` fetches a response the provider finished later; `images` and
	 * `classifier` are pi-ai's one-shot requests.
	 */
	kind: Schema.Literals(["chat", "deferred", "images", "classifier"]),
	provider: Schema.String,
	model: Schema.String,
	/** pi-ai's `sessionId` of the request: Pi Durable sends a conversation's provider session with each request. */
	session: Schema.optional(Schema.String),
	/** The conversation the session belongs to, known when the conversation has a share (see `Shares`). */
	conversation: Schema.optional(Schema.Number),
	/**
	 * The key of what a chat request with a session asks: a digest of the session and the whole context, which the
	 * router's route events of the request carry too. Every send of one request has it, by this process or a later
	 * one: the resend of a request a crash cut off, and Pi's retry after a provider error, whose context is the same.
	 * Every other request has another. So a lease that finds a reservation of the key still open knows the process
	 * that made it died in the request: it can release that one, or refuse this one. One that finds it settled sees a
	 * retry. Copies of a storage repeat it (the lease tells them apart by who asks). It is no charge's identity: every
	 * send is billed. A spend recorded for a request's failed route attempt carries the request's key too.
	 */
	requestKey: Schema.optional(Schema.String),
	/**
	 * The caller's key of a spend recorded through `Spend`; absent for a request of the budgeted `Models`. It is the
	 * same when the same spend is told again, also by a later process, so a lease can refuse to charge it twice.
	 */
	key: Schema.optional(Schema.String),
});

/** One provider request as the budget sees it. */
export type BudgetRequest = typeof BudgetRequest.Type;

/**
 * How a reserved request ended: `returned` with a response, `failed` in an error of the provider, or `aborted` by
 * the caller, by the provider (a timeout, a closed connection) or by an interruption.
 */
export const Outcome = Schema.Literals(["returned", "failed", "aborted"]);

/** How a reserved request ended. */
export type Outcome = typeof Outcome.Type;

/** What a reserved request really used. */
export const Settlement = Schema.Struct({
	/** What the provider reported, also for a failed or aborted request; zeros when it reported nothing. */
	usage: TokenUsage,
	/** `usage` at the price table, in micro units of its currency. */
	cost: Schema.BigInt,
	outcome: Outcome,
});

/** What a reserved request really used. */
export type Settlement = typeof Settlement.Type;

/**
 * The lease no longer covers a request: it is gone, it expired, or it is out of money. `reason` is the product's own
 * label for which.
 */
export class LeaseFenced extends Schema.TaggedError<LeaseFenced>()("LeaseFenced", {
	reason: Schema.String,
}) {
	override get message(): string {
		return `The budget lease is fenced: ${this.reason}`;
	}
}

/** What a product's lease does for the budget. */
export interface LeaseService {
	/**
	 * Sets `estimate` micro units aside for `request` and gives the token of the reservation, or fails with
	 * `LeaseFenced`: the request is then not sent. It runs uninterruptibly, so that a reservation made is never lost:
	 * keep it short, or give it a timeout of its own.
	 */
	readonly reserve: (estimate: bigint, request: BudgetRequest) => Effect.Effect<string, LeaseFenced>;
	/**
	 * Replaces the reservation by what the request really cost. Called exactly once for every token `reserve` gave,
	 * however the request ended, and uninterruptibly.
	 */
	readonly settle: (reservation: string, settlement: Settlement) => Effect.Effect<void>;
}

/** The lease every provider request of a budget draws on. The product provides it. */
export class Lease extends Context.Service<Lease, LeaseService>()("@gunta/pi-budget-effect/Lease") {}
