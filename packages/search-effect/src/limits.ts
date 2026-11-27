// The limits a product fixes for the tools, and how a model's request is brought within them: a number above
// its cap becomes the cap, and a request no limit lets through is refused in words the model can act on.

import { Array as Arr, DateTime, Effect, Option, pipe, Schema, String as Str, Struct } from "effect";
import { Count, SearchOptions, Unfetched } from "./provider/index.ts";

/** What the tools may ask of the provider at most. Fixed when the tools are made; no call can widen it. */
export const Limits = Schema.Struct({
	/** The most hits one search asks for. */
	maxResults: Count,
	/** The hits a search asks for when the model names no count; never above `maxResults`. */
	defaultResults: Count,
	/** The most characters of each hit's snippet: asked of the provider, and shown at most. */
	snippetCharacters: Count,
	/** The most pages one fetch reads. */
	maxUrls: Count,
	/** The most characters of each page's text: asked of the provider, and shown at most. */
	maxCharacters: Count,
	/** When given, the only domains searched and fetched (`example.com` covers its subdomains). */
	allowedDomains: Schema.optional(Schema.Array(Schema.String)),
	/** Domains never searched or fetched, also inside an allowed one. */
	blockedDomains: Schema.optional(Schema.Array(Schema.String)),
	/** When given, a search finds only pages published after this instant. */
	publishedAfter: Schema.optional(Schema.DateTimeUtc),
	/** When given, a search finds only pages published before this instant. */
	publishedBefore: Schema.optional(Schema.DateTimeUtc),
});

/** What the tools may ask of the provider at most. */
export type Limits = typeof Limits.Type;

/** The limits of tools made without any: enough for a model to read a topic up, small enough for its context. */
export const defaultLimits: Limits = Limits.make({
	maxResults: 10,
	defaultResults: 5,
	snippetCharacters: 500,
	maxUrls: 5,
	maxCharacters: 10_000,
});

/** A request no limit lets through. `reason` is what the model reads. */
export class SearchRefused extends Schema.TaggedError<SearchRefused, { readonly brand: unique symbol }>()(
	"SearchRefused",
	{ reason: Schema.String },
) {
	override get message(): string {
		return this.reason;
	}
}

/** What a model may ask of a search besides its query: the provider's options, but the snippet length. */
export const SearchAsk = Schema.Struct(Struct.omit(SearchOptions.fields, ["snippetCharacters"]));

/** What a model may ask of a search besides its query. */
export type SearchAsk = typeof SearchAsk.Type;

/**
 * The provider options of a search within `limits`: the count capped, the domains narrowed to the allowed ones
 * and widened by the blocked ones, the dates moved inside the fixed range. Fails when nothing could match.
 */
export const capSearch: (limits: Limits, asked: SearchAsk) => Effect.Effect<SearchOptions, SearchRefused> = Effect.fn(
	"Limits.capSearch",
)(function* (limits, asked) {
	const permit = permitted(limits);
	const wanted = asked.includeDomains ?? [];
	const includeDomains = Arr.isReadonlyArrayEmpty(wanted)
		? (limits.allowedDomains ?? [])
		: Arr.filter(wanted, (domain) => permit(hostOf(domain)));
	// An empty filter would search everywhere: with an allow-list, or with domains asked for, that is never meant.
	if (
		Arr.isReadonlyArrayEmpty(includeDomains) &&
		(Arr.isReadonlyArrayNonEmpty(wanted) || limits.allowedDomains !== undefined)
	) {
		const reason = Arr.isReadonlyArrayEmpty(wanted)
			? "No domain may be searched."
			: `None of these domains may be searched: ${Arr.join(wanted, ", ")}.`;
		return yield* SearchRefused.make({ reason });
	}
	const publishedAfter = later(limits.publishedAfter, asked.publishedAfter);
	const publishedBefore = earlier(limits.publishedBefore, asked.publishedBefore);
	if (
		publishedAfter !== undefined &&
		publishedBefore !== undefined &&
		!DateTime.isLessThan(publishedAfter, publishedBefore)
	) {
		const after = DateTime.formatIso(publishedAfter);
		const before = DateTime.formatIso(publishedBefore);
		return yield* SearchRefused.make({ reason: `No page is published after ${after} and before ${before}.` });
	}
	const excludeDomains = Arr.dedupe([...(asked.excludeDomains ?? []), ...(limits.blockedDomains ?? [])]);
	return SearchOptions.make({
		maxResults: Math.min(asked.maxResults ?? limits.defaultResults, limits.maxResults),
		snippetCharacters: limits.snippetCharacters,
		...(Arr.isReadonlyArrayEmpty(includeDomains) ? {} : { includeDomains }),
		...(Arr.isReadonlyArrayEmpty(excludeDomains) ? {} : { excludeDomains }),
		...(publishedAfter === undefined ? {} : { publishedAfter }),
		...(publishedBefore === undefined ? {} : { publishedBefore }),
	});
});

/** What a model may ask of a fetch. */
export const FetchAsk = Schema.Struct({
	urls: Schema.Array(Schema.String),
	maxCharacters: Schema.optional(Count),
});

/** What a model may ask of a fetch. */
export type FetchAsk = typeof FetchAsk.Type;

/** A fetch within the limits: the pages to read, how, and the pages left out with the reason for each. */
export const FetchPlan = Schema.Struct({
	urls: Schema.Array(Schema.String),
	/** The most characters of each page: what the provider is asked for, and what the model is shown. */
	maxCharacters: Count,
	skipped: Schema.Array(Unfetched),
});

/** A fetch within the limits. */
export type FetchPlan = typeof FetchPlan.Type;

/**
 * The fetch `limits` allow of what was asked: web addresses on permitted domains, the first `maxUrls` of them, with
 * the text length capped. Fails when no page is left.
 */
export const capFetch: (limits: Limits, asked: FetchAsk) => Effect.Effect<FetchPlan, SearchRefused> = Effect.fn(
	"Limits.capFetch",
)(function* (limits, asked) {
	const permit = permitted(limits);
	const whyNot = (url: string, taken: number): Option.Option<string> => {
		if (!isWebAddress(url)) return Option.some("not a web address");
		if (!permit(hostOf(url))) return Option.some("this domain may not be fetched");
		if (taken >= limits.maxUrls) return Option.some(`over the limit of ${limits.maxUrls} pages`);
		return Option.none();
	};
	// In the order asked: the limit on pages counts the addresses taken before each one.
	const { urls, skipped } = Arr.reduce(
		asked.urls,
		{ urls: Arr.empty<string>(), skipped: Arr.empty<Unfetched>() },
		(plan, url) =>
			Option.match(whyNot(url, plan.urls.length), {
				onNone: () => ({ ...plan, urls: Arr.append(plan.urls, url) }),
				onSome: (reason) => ({ ...plan, skipped: Arr.append(plan.skipped, Unfetched.make({ url, reason })) }),
			}),
	);
	if (Arr.isReadonlyArrayEmpty(urls)) {
		const reasons = Arr.join(
			Arr.map(skipped, ({ url, reason }) => `${url} (${reason})`),
			"; ",
		);
		const why = reasons === "" ? "no address was given" : reasons;
		return yield* SearchRefused.make({ reason: `No page can be fetched: ${why}.` });
	}
	const maxCharacters = Math.min(asked.maxCharacters ?? limits.maxCharacters, limits.maxCharacters);
	return FetchPlan.make({ urls, maxCharacters, skipped });
});

/** Whether a host lies on a permitted domain: inside the allowed ones, if any, and outside the blocked ones. */
function permitted(limits: Limits): (host: string | undefined) => boolean {
	const allowed = Option.map(Option.fromUndefinedOr(limits.allowedDomains), Arr.map(hostOf));
	const blocked = Arr.map(limits.blockedDomains ?? [], hostOf);
	return (host) => {
		const within = (domain: string | undefined) =>
			host !== undefined && domain !== undefined && (host === domain || pipe(host, Str.endsWith(`.${domain}`)));
		const inAllowed = Option.match(allowed, { onNone: () => true, onSome: Arr.some(within) });
		return inAllowed && !Arr.some(blocked, within);
	};
}

/**
 * The host of a URL, or of a domain as a model or a product writes one (`Docs.Example.com`, `*.example.com`,
 * `https://example.com/a`), read by the platform's URL parser: a page is checked as a fetcher will read it, whatever
 * its spelling. None when there is no host to read.
 */
function hostOf(domainOrUrl: string): string | undefined {
	const text = pipe(domainOrUrl, Str.trim, Str.replace(/^\*\./, ""));
	const url = HAS_SCHEME.test(text) ? text : `https://${text}`;
	// A trailing dot names the same host.
	return URL.canParse(url) ? pipe(new URL(url).hostname, Str.replace(/\.$/, "")) : undefined;
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Whether `url` is an absolute `http` or `https` URL: the only kind a provider reads. */
function isWebAddress(url: string): boolean {
	return URL.canParse(url) && Arr.contains(["http:", "https:"], new URL(url).protocol);
}

/** The later of a fixed bound and an asked one: the narrower start of a range. */
function later(fixed: DateTime.Utc | undefined, asked: DateTime.Utc | undefined): DateTime.Utc | undefined {
	return fixed === undefined || asked === undefined ? (fixed ?? asked) : DateTime.max(fixed, asked);
}

/** The earlier of a fixed bound and an asked one: the narrower end of a range. */
function earlier(fixed: DateTime.Utc | undefined, asked: DateTime.Utc | undefined): DateTime.Utc | undefined {
	return fixed === undefined || asked === undefined ? (fixed ?? asked) : DateTime.min(fixed, asked);
}
