// The typed failures of this package: a route table that cannot be used, and a request no route served.

import { type AssistantMessage, ModelId, type ModelRequestError, ProviderId } from "@effectified/pi-ai";
import { Array as Arr, Predicate, Schema } from "effect";
import { ConcurrencyKey, RouterRequestId } from "./ids.ts";

/**
 * One reason a route table cannot be used, naming the entry it is about. `RouteTableIssue.match` picks a handler per
 * tag and `RouteTableIssue.guards` tests for one.
 */
export const RouteTableIssue = Schema.TaggedUnion({
	/** The value is not the shape of a route table. */
	Malformed: { message: Schema.String },
	DuplicateClassification: { label: Schema.String },
	DuplicateAlias: { alias: ModelId },
	/** An alias with no route. */
	EmptyAlias: { alias: ModelId },
	/** The default classification of an alias is not one of the table's labels. */
	UnknownDefaultClassification: { alias: ModelId, label: Schema.String },
	/** An alias names the same provider and model twice. */
	DuplicateRoute: { alias: ModelId, provider: ProviderId, model: ModelId },
	/** The classification ceiling of a route is not one of the table's labels. */
	UnknownCeiling: { alias: ModelId, provider: ProviderId, model: ModelId, label: Schema.String },
	/** The concurrency key of a route has no entry in the table's limits. */
	UnknownConcurrencyKey: { alias: ModelId, provider: ProviderId, model: ModelId, key: ConcurrencyKey },
	/** No provider with this id is registered in `Models`. */
	UnknownProvider: { alias: ModelId, provider: ProviderId },
	/** The provider is registered and lists no chat model with this id. */
	UnknownModel: { alias: ModelId, provider: ProviderId, model: ModelId },
});

/** One reason a route table cannot be used. */
export type RouteTableIssue = typeof RouteTableIssue.Type;

/** A route table cannot be used. `issues` lists every reason, in table order. */
export class RouteTableError extends Schema.TaggedError<RouteTableError, { readonly brand: unique symbol }>()(
	"RouteTableError",
	{ issues: Schema.NonEmptyArray(RouteTableIssue) },
) {
	override get message(): string {
		return Arr.join(Arr.map(this.issues, describeIssue), "; ");
	}
}

function describeIssue(issue: RouteTableIssue): string {
	const route = (entry: { alias: string; provider: string; model: string }): string =>
		`Route ${entry.provider}/${entry.model} of alias "${entry.alias}"`;
	return RouteTableIssue.match(issue, {
		Malformed: ({ message }) => message,
		DuplicateClassification: ({ label }) => `Classification "${label}" is listed twice`,
		DuplicateAlias: ({ alias }) => `Alias "${alias}" is defined twice`,
		EmptyAlias: ({ alias }) => `Alias "${alias}" has no route`,
		UnknownDefaultClassification: ({ alias, label }) =>
			`Alias "${alias}" defaults to the unknown classification "${label}"`,
		DuplicateRoute: ({ alias, provider, model }) => `Alias "${alias}" names ${provider}/${model} twice`,
		UnknownCeiling: (entry) => `${route(entry)} has the unknown ceiling "${entry.label}"`,
		UnknownConcurrencyKey: (entry) => `${route(entry)} has the concurrency key "${entry.key}", which has no limit`,
		UnknownProvider: ({ alias, provider }) =>
			`Alias "${alias}" names the provider "${provider}", which is not registered`,
		UnknownModel: ({ alias, provider, model }) =>
			`Alias "${alias}" names ${provider}/${model}, which the provider does not list`,
	});
}

/** The router has no alias with this name. */
export class UnknownAlias extends Schema.TaggedError<UnknownAlias, { readonly brand: unique symbol }>()(
	"UnknownAlias",
	{ alias: ModelId },
) {
	override get message(): string {
		return `The route table has no alias "${this.alias}"`;
	}
}

/** The constraints of a request cannot be read, or name a classification the table does not list. */
export class InvalidConstraints extends Schema.TaggedError<InvalidConstraints, { readonly brand: unique symbol }>()(
	"InvalidConstraints",
	{ alias: ModelId, reason: Schema.String },
) {
	override get message(): string {
		return `The constraints of a request to alias "${this.alias}" are not usable: ${this.reason}`;
	}
}

/**
 * The product's `ConstraintSource` could not say what constrains a request, so the request was refused: nothing was
 * sent to any route. `reason` is the source's own text, or the defect it died with, which `cause` then holds as it
 * was. The message leaves both out, because Pi decides from an error's text whether to send a request again, and this
 * one must not be sent again unasked.
 */
export class ConstraintsUnavailable extends Schema.TaggedError<
	ConstraintsUnavailable,
	{ readonly brand: unique symbol }
>()("ConstraintsUnavailable", {
	alias: ModelId,
	reason: Schema.String,
	cause: Schema.optionalKey(Schema.Defect()),
}) {
	override get message(): string {
		return `The constraints of a request to alias "${this.alias}" are not known, so it was not sent to any route`;
	}
}

/** The route an exclusion is about. */
const Excluded = { provider: ProviderId, model: ModelId };

/**
 * Why a route may not serve a request, by `reason`: its ceiling is below the content's classification
 * (`classification`), its region is not allowed (`region`), or it lacks a label the request requires (`label`, with
 * the required labels it does not carry in `missing`, in the order they were required). The first of the three that
 * holds, in this order, is the one given.
 */
export const Exclusion = Schema.Union([
	Schema.Struct({ ...Excluded, reason: Schema.Literal("classification") }),
	Schema.Struct({ ...Excluded, reason: Schema.Literal("region") }),
	Schema.Struct({ ...Excluded, reason: Schema.Literal("label"), missing: Schema.NonEmptyArray(Schema.String) }),
]);

/** Why a route may not serve a request. */
export type Exclusion = typeof Exclusion.Type;

/** Every route of the alias is excluded by the request's constraints. Nothing was sent to any provider. */
export class NoRouteAvailable extends Schema.TaggedError<NoRouteAvailable, { readonly brand: unique symbol }>()(
	"NoRouteAvailable",
	{
		alias: ModelId,
		/** The classification the routes were checked against. */
		classification: Schema.String,
		/** The regions the request allowed; absent when it allowed every region. */
		regions: Schema.optional(Schema.Array(Schema.String)),
		/** The labels a route had to carry; absent when the request required none. */
		requires: Schema.optional(Schema.Array(Schema.String)),
		/** One entry per route of the alias, in table order. */
		excluded: Schema.Array(Exclusion),
	},
) {
	override get message(): string {
		const where =
			this.regions === undefined
				? "any region"
				: Arr.isReadonlyArrayNonEmpty(this.regions)
					? `the regions ${Arr.join(this.regions, ", ")}`
					: "no region";
		const labels = this.requires === undefined ? "" : ` with the labels ${Arr.join(this.requires, ", ")}`;
		return `No route of alias "${this.alias}" may serve content classified "${this.classification}" in ${where}${labels}`;
	}
}

/** One route that failed in a way that let the next route be tried. */
export const RouteFailure = Schema.Struct({
	provider: ProviderId,
	model: ModelId,
	message: Schema.String,
});

/** One route that failed in a way that let the next route be tried. */
export type RouteFailure = typeof RouteFailure.Type;

// pi-ai has no schema for its messages; the role is what tells an assistant message from the other kinds.
const AssistantResponse = Schema.declare(
	(value: unknown): value is AssistantMessage => Predicate.isObject(value) && value.role === "assistant",
);

/**
 * Every route that may serve the request was tried and failed with a retryable error or an unavailable provider.
 * `response` is pi-ai's error message of the last route that answered; absent when no provider was reached. Its
 * `usage` is that of the request's last attempt: zeros when a route tried after it was unavailable, because the usage
 * of every attempt but the last is told by its route event and by nothing else.
 */
export class RoutesExhausted extends Schema.TaggedError<RoutesExhausted, { readonly brand: unique symbol }>()(
	"RoutesExhausted",
	{
		alias: ModelId,
		/** One entry per attempt, in the order the routes were tried. */
		failures: Schema.NonEmptyArray(RouteFailure),
		response: Schema.optional(AssistantResponse),
	},
) {
	override get message(): string {
		const tried = Arr.map(this.failures, (failure) => `${failure.provider}/${failure.model}: ${failure.message}`);
		return `Every route of alias "${this.alias}" failed: ${Arr.join(tried, "; ")}`;
	}
}

/**
 * The product's `AttemptSettlement` could not settle an attempt that another route was about to take over, so no
 * other route was tried and the request ended with that attempt as its last. `requestId` and `attempt` name the
 * attempt as its route event does, which says `fallback: false`. `response` is the failed route's own pi-ai message,
 * with the usage the attempt was billed for: the usage of a request's last attempt is in the message the request ends
 * with, so whatever wraps the router is told it there. `reason` is the port's own text, or the defect it died with;
 * `cause` is what the port failed or died with, as it was. The message leaves both out, because Pi decides from an
 * error's text whether to send a request again, and this one must not be sent again unasked: the first route would be
 * billed again for what still cannot be settled.
 */
export class AttemptUnsettled extends Schema.TaggedError<AttemptUnsettled, { readonly brand: unique symbol }>()(
	"AttemptUnsettled",
	{
		alias: ModelId,
		requestId: RouterRequestId,
		/** The position of the attempt in its request, from 1. */
		attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
		/** The route of the attempt. */
		provider: ProviderId,
		model: ModelId,
		reason: Schema.String,
		response: AssistantResponse,
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {
	override get message(): string {
		return `Attempt ${this.attempt} of a request to alias "${this.alias}" could not be settled, so no other route was tried`;
	}
}

/**
 * How a request to an alias fails. `ModelRequestError` is pi-ai's error of the one route that ended the request: a
 * failure that is not retryable, an abort by the provider, or any failure after output had reached the caller.
 */
export type RouterError =
	| UnknownAlias
	| InvalidConstraints
	| ConstraintsUnavailable
	| NoRouteAvailable
	| RoutesExhausted
	| AttemptUnsettled
	| ModelRequestError;
