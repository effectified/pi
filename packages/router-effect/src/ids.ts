// The ids of this package's own: the concurrency key routes share a limit by, the id of a request in route events, and
// the provider id a router takes when it is given none. Provider and model ids are pi-ai's (`ProviderId`, `ModelId` of
// `@effectified/pi-ai`).

import { ProviderId } from "@effectified/pi-ai";
import { Schema } from "effect";

/** The id of a router's provider in `Models` when it is built with none (`RouterOptions.id`). */
export const DEFAULT_ROUTER_ID: ProviderId = ProviderId.make("router");

/**
 * The key of a route table's `limits` whose slots and backoff every route that names it shares, and the key a
 * `Limiter` limits by (`openrouter`, `local`, `crawler`). It names a limit, not a provider: two providers may share one.
 */
export const ConcurrencyKey = Schema.String.pipe(Schema.brand("ConcurrencyKey"));

/** The key of a limit routes share. */
export type ConcurrencyKey = typeof ConcurrencyKey.Type;

/**
 * The id of one request to a router, as its route events carry it: the same for every attempt of the request and of
 * no other request, of this router or another, in this process or a later one. With the attempt's number it names one
 * attempt for good.
 */
export const RouterRequestId = Schema.String.pipe(Schema.brand("RouterRequestId"));

/** The id of one request to a router. */
export type RouterRequestId = typeof RouterRequestId.Type;
