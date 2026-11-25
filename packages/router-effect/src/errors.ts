// The typed failures of this package: a route table that cannot be used, and a request no route served.

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelRequestError } from "@gunta/pi-ai-effect";
import { Predicate, Schema } from "effect";

/** One reason a route table cannot be used, naming the entry it is about. */
export const RouteTableIssue = Schema.Union([
	/** The value is not the shape of a route table. */
	Schema.TaggedStruct("Malformed", { message: Schema.String }),
	Schema.TaggedStruct("DuplicateClassification", { label: Schema.String }),
	Schema.TaggedStruct("DuplicateAlias", { alias: Schema.String }),
	/** An alias with no route. */
	Schema.TaggedStruct("EmptyAlias", { alias: Schema.String }),
	/** The default classification of an alias is not one of the table's labels. */
	Schema.TaggedStruct("UnknownDefaultClassification", { alias: Schema.String, label: Schema.String }),
	/** An alias names the same provider and model twice. */
	Schema.TaggedStruct("DuplicateRoute", { alias: Schema.String, provider: Schema.String, model: Schema.String }),
	/** The classification ceiling of a route is not one of the table's labels. */
	Schema.TaggedStruct("UnknownCeiling", {
		alias: Schema.String,
		provider: Schema.String,
		model: Schema.String,
		label: Schema.String,
	}),
	/** The concurrency key of a route has no entry in the table's limits. */
	Schema.TaggedStruct("UnknownConcurrencyKey", {
		alias: Schema.String,
		provider: Schema.String,
		model: Schema.String,
		key: Schema.String,
	}),
	/** No provider with this id is registered in `Models`. */
	Schema.TaggedStruct("UnknownProvider", { alias: Schema.String, provider: Schema.String }),
	/** The provider is registered and lists no chat model with this id. */
	Schema.TaggedStruct("UnknownModel", { alias: Schema.String, provider: Schema.String, model: Schema.String }),
]);

/** One reason a route table cannot be used. */
export type RouteTableIssue = typeof RouteTableIssue.Type;

/** A route table cannot be used. `issues` lists every reason, in table order. */
export class RouteTableError extends Schema.TaggedError<RouteTableError>()("RouteTableError", {
	issues: Schema.NonEmptyArray(RouteTableIssue),
}) {
	override get message(): string {
		return this.issues.map(describeIssue).join("; ");
	}
}

function describeIssue(issue: RouteTableIssue): string {
	const route = (entry: { alias: string; provider: string; model: string }): string =>
		`Route ${entry.provider}/${entry.model} of alias "${entry.alias}"`;
	switch (issue._tag) {
		case "Malformed":
			return issue.message;
		case "DuplicateClassification":
			return `Classification "${issue.label}" is listed twice`;
		case "DuplicateAlias":
			return `Alias "${issue.alias}" is defined twice`;
		case "EmptyAlias":
			return `Alias "${issue.alias}" has no route`;
		case "UnknownDefaultClassification":
			return `Alias "${issue.alias}" defaults to the unknown classification "${issue.label}"`;
		case "DuplicateRoute":
			return `Alias "${issue.alias}" names ${issue.provider}/${issue.model} twice`;
		case "UnknownCeiling":
			return `${route(issue)} has the unknown ceiling "${issue.label}"`;
		case "UnknownConcurrencyKey":
			return `${route(issue)} has the concurrency key "${issue.key}", which has no limit`;
		case "UnknownProvider":
			return `Alias "${issue.alias}" names the provider "${issue.provider}", which is not registered`;
		case "UnknownModel":
			return `Alias "${issue.alias}" names ${issue.provider}/${issue.model}, which the provider does not list`;
	}
}

/** The router has no alias with this name. */
export class UnknownAlias extends Schema.TaggedError<UnknownAlias>()("UnknownAlias", {
	alias: Schema.String,
}) {
	override get message(): string {
		return `The route table has no alias "${this.alias}"`;
	}
}

/** The constraints of a request cannot be read, or name a classification the table does not list. */
export class InvalidConstraints extends Schema.TaggedError<InvalidConstraints>()("InvalidConstraints", {
	alias: Schema.String,
	reason: Schema.String,
}) {
	override get message(): string {
		return `The constraints of a request to alias "${this.alias}" are not usable: ${this.reason}`;
	}
}

/**
 * The product's `ConstraintSource` could not say what constrains a request, so the request was refused: nothing was
 * sent to any route. `reason` is the source's own text, or the defect it died with. The message leaves it out, because
 * Pi decides from an error's text whether to send a request again, and this one must not be sent again unasked.
 */
export class ConstraintsUnavailable extends Schema.TaggedError<ConstraintsUnavailable>()("ConstraintsUnavailable", {
	alias: Schema.String,
	reason: Schema.String,
}) {
	override get message(): string {
		return `The constraints of a request to alias "${this.alias}" are not known, so it was not sent to any route`;
	}
}

/**
 * Why a route may not serve a request: its ceiling is below the content's classification, its region is not allowed,
 * or it lacks a label the request requires. The first of the three that holds, in this order, is the one given.
 */
export const Exclusion = Schema.Struct({
	provider: Schema.String,
	model: Schema.String,
	reason: Schema.Literals(["classification", "region", "label"]),
	/** For `label`: the required labels the route does not carry, in the order they were required. */
	missing: Schema.optional(Schema.Array(Schema.String)),
});

/** Why a route may not serve a request. */
export type Exclusion = typeof Exclusion.Type;

/** Every route of the alias is excluded by the request's constraints. Nothing was sent to any provider. */
export class NoRouteAvailable extends Schema.TaggedError<NoRouteAvailable>()("NoRouteAvailable", {
	alias: Schema.String,
	/** The classification the routes were checked against. */
	classification: Schema.String,
	/** The regions the request allowed; absent when it allowed every region. */
	regions: Schema.optional(Schema.Array(Schema.String)),
	/** The labels a route had to carry; absent when the request required none. */
	requires: Schema.optional(Schema.Array(Schema.String)),
	/** One entry per route of the alias, in table order. */
	excluded: Schema.Array(Exclusion),
}) {
	override get message(): string {
		const where =
			this.regions === undefined
				? "any region"
				: this.regions.length === 0
					? "no region"
					: `the regions ${this.regions.join(", ")}`;
		const labels = this.requires === undefined ? "" : ` with the labels ${this.requires.join(", ")}`;
		return `No route of alias "${this.alias}" may serve content classified "${this.classification}" in ${where}${labels}`;
	}
}

/** One route that failed in a way that let the next route be tried. */
export const RouteFailure = Schema.Struct({
	provider: Schema.String,
	model: Schema.String,
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
export class RoutesExhausted extends Schema.TaggedError<RoutesExhausted>()("RoutesExhausted", {
	alias: Schema.String,
	/** One entry per attempt, in the order the routes were tried. */
	failures: Schema.NonEmptyArray(RouteFailure),
	response: Schema.optional(AssistantResponse),
}) {
	override get message(): string {
		const tried = this.failures.map((failure) => `${failure.provider}/${failure.model}: ${failure.message}`);
		return `Every route of alias "${this.alias}" failed: ${tried.join("; ")}`;
	}
}

/**
 * The product's `AttemptSettlement` could not settle an attempt that another route was about to take over, so no
 * other route was tried and the request ended with that attempt as its last. `requestId` and `attempt` name the
 * attempt as its route event does, which says `fallback: false`. `response` is the failed route's own pi-ai message,
 * with the usage the attempt was billed for: the usage of a request's last attempt is in the message the request ends
 * with, so whatever wraps the router is told it there. `reason` is the port's own text, or the defect it died with.
 * The message leaves it out, because Pi decides from an error's text whether to send a request again, and this one
 * must not be sent again unasked: the first route would be billed again for what still cannot be settled.
 */
export class AttemptUnsettled extends Schema.TaggedError<AttemptUnsettled>()("AttemptUnsettled", {
	alias: Schema.String,
	requestId: Schema.String,
	/** The position of the attempt in its request, from 1. */
	attempt: Schema.Int,
	/** The route of the attempt. */
	provider: Schema.String,
	model: Schema.String,
	reason: Schema.String,
	response: AssistantResponse,
}) {
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
