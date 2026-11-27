// The name of a search provider, branded so that a pi-ai provider id or any other string is never taken for one.

import { Schema } from "effect";

/**
 * The name of a search provider (`exa`): what its evidence and its errors name it by. Not a pi-ai `ProviderId`: a
 * search provider is no model provider, though both are called `provider`. A provider file brands its own
 * (`ProviderName.make("exa")`); decoding stored evidence brands a stored one.
 */
export const ProviderName = Schema.NonEmptyString.pipe(Schema.brand("@effectified/pi-search/ProviderName"));

/** The name of a search provider. */
export type ProviderName = typeof ProviderName.Type;
