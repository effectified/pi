// The limits a product fixes for the tools, and how a model's request is brought within them: a number above
// its cap becomes the cap, and a request no limit lets through is refused in words the model can act on.

import { DateTime, Effect, Schema } from "effect";
import { Count, type SearchOptions, type Unfetched } from "./provider/index.ts";

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
export const defaultLimits: Limits = {
	maxResults: 10,
	defaultResults: 5,
	snippetCharacters: 500,
	maxUrls: 5,
	maxCharacters: 10_000,
};

/** A request no limit lets through. `reason` is what the model reads. */
export class SearchRefused extends Schema.TaggedError<SearchRefused>()("SearchRefused", {
	reason: Schema.String,
}) {
	override get message(): string {
		return this.reason;
	}
}

/** What a model may ask of a search besides its query. */
export interface SearchAsk {
	readonly maxResults?: number | undefined;
	readonly includeDomains?: ReadonlyArray<string> | undefined;
	readonly excludeDomains?: ReadonlyArray<string> | undefined;
	readonly publishedAfter?: DateTime.Utc | undefined;
	readonly publishedBefore?: DateTime.Utc | undefined;
}

/**
 * The provider options of a search within `limits`: the count capped, the domains narrowed to the allowed ones
 * and widened by the blocked ones, the dates moved inside the fixed range. Fails when nothing could match.
 */
export function capSearch(limits: Limits, asked: SearchAsk): Effect.Effect<SearchOptions, SearchRefused> {
	const permit = permitted(limits);
	const wanted = asked.includeDomains ?? [];
	const includeDomains =
		wanted.length === 0 ? (limits.allowedDomains ?? []) : wanted.filter((domain) => permit(hostOf(domain)));
	// An empty filter would search everywhere: with an allow-list, or with domains asked for, that is never meant.
	if (includeDomains.length === 0 && (wanted.length > 0 || limits.allowedDomains !== undefined)) {
		const reason =
			wanted.length === 0
				? "No domain may be searched."
				: `None of these domains may be searched: ${wanted.join(", ")}.`;
		return Effect.fail(new SearchRefused({ reason }));
	}
	const publishedAfter = later(limits.publishedAfter, asked.publishedAfter);
	const publishedBefore = earlier(limits.publishedBefore, asked.publishedBefore);
	if (
		publishedAfter !== undefined &&
		publishedBefore !== undefined &&
		!DateTime.isLessThan(publishedAfter, publishedBefore)
	) {
		return Effect.fail(
			new SearchRefused({
				reason: `No page is published after ${DateTime.formatIso(publishedAfter)} and before ${DateTime.formatIso(publishedBefore)}.`,
			}),
		);
	}
	const excludeDomains = [...new Set([...(asked.excludeDomains ?? []), ...(limits.blockedDomains ?? [])])];
	return Effect.succeed({
		maxResults: Math.min(asked.maxResults ?? limits.defaultResults, limits.maxResults),
		snippetCharacters: limits.snippetCharacters,
		...(includeDomains.length === 0 ? {} : { includeDomains }),
		...(excludeDomains.length === 0 ? {} : { excludeDomains }),
		...(publishedAfter === undefined ? {} : { publishedAfter }),
		...(publishedBefore === undefined ? {} : { publishedBefore }),
	});
}

/** What a model may ask of a fetch. */
export interface FetchAsk {
	readonly urls: ReadonlyArray<string>;
	readonly maxCharacters?: number | undefined;
}

/** A fetch within the limits: the pages to read, how, and the pages left out with the reason for each. */
export interface FetchPlan {
	readonly urls: ReadonlyArray<string>;
	/** The most characters of each page: what the provider is asked for, and what the model is shown. */
	readonly maxCharacters: number;
	readonly skipped: ReadonlyArray<Unfetched>;
}

/**
 * The fetch `limits` allow of what was asked: web addresses on permitted domains, the first `maxUrls` of them, with
 * the text length capped. Fails when no page is left.
 */
export function capFetch(limits: Limits, asked: FetchAsk): Effect.Effect<FetchPlan, SearchRefused> {
	const urls: string[] = [];
	const skipped: Unfetched[] = [];
	const permit = permitted(limits);
	const whyNot = (url: string): string | undefined => {
		if (!isWebAddress(url)) return "not a web address";
		if (!permit(hostOf(url))) return "this domain may not be fetched";
		if (urls.length >= limits.maxUrls) return `over the limit of ${limits.maxUrls} pages`;
		return undefined;
	};
	for (const url of asked.urls) {
		const reason = whyNot(url);
		if (reason === undefined) urls.push(url);
		else skipped.push({ url, reason });
	}
	if (urls.length === 0) {
		const reasons = skipped.map(({ url, reason }) => `${url} (${reason})`).join("; ");
		return Effect.fail(
			new SearchRefused({ reason: `No page can be fetched: ${reasons === "" ? "no address was given" : reasons}.` }),
		);
	}
	const maxCharacters = Math.min(asked.maxCharacters ?? limits.maxCharacters, limits.maxCharacters);
	return Effect.succeed({ urls, maxCharacters, skipped });
}

/** Whether a host lies on a permitted domain: inside the allowed ones, if any, and outside the blocked ones. */
function permitted(limits: Limits): (host: string | undefined) => boolean {
	const allowed = limits.allowedDomains?.map(hostOf);
	const blocked = (limits.blockedDomains ?? []).map(hostOf);
	return (host) => {
		const within = (domain: string | undefined) =>
			host !== undefined && domain !== undefined && (host === domain || host.endsWith(`.${domain}`));
		return (allowed === undefined || allowed.some(within)) && !blocked.some(within);
	};
}

/**
 * The host of a URL, or of a domain as a model or a product writes one (`Docs.Example.com`, `*.example.com`,
 * `https://example.com/a`), read by the platform's URL parser: a page is checked as a fetcher will read it, whatever
 * its spelling. None when there is no host to read.
 */
function hostOf(domainOrUrl: string): string | undefined {
	const text = domainOrUrl.trim().replace(/^\*\./, "");
	const url = HAS_SCHEME.test(text) ? text : `https://${text}`;
	// A trailing dot names the same host.
	return URL.canParse(url) ? new URL(url).hostname.replace(/\.$/, "") : undefined;
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Whether `url` is an absolute `http` or `https` URL: the only kind a provider reads. */
function isWebAddress(url: string): boolean {
	return URL.canParse(url) && ["http:", "https:"].includes(new URL(url).protocol);
}

/** The later of a fixed bound and an asked one: the narrower start of a range. */
function later(fixed: DateTime.Utc | undefined, asked: DateTime.Utc | undefined): DateTime.Utc | undefined {
	return fixed === undefined || asked === undefined ? (fixed ?? asked) : DateTime.max(fixed, asked);
}

/** The earlier of a fixed bound and an asked one: the narrower end of a range. */
function earlier(fixed: DateTime.Utc | undefined, asked: DateTime.Utc | undefined): DateTime.Utc | undefined {
	return fixed === undefined || asked === undefined ? (fixed ?? asked) : DateTime.min(fixed, asked);
}
