// The auth members of pi-ai's `Models` as Effects: a provider's resolved auth with its secrets `Redacted`, which
// providers are configured, their model catalogs, and logging in and out.

import {
	type AnyModel,
	type Api,
	type AuthCheck,
	type AuthEvent,
	type AuthPrompt,
	type AuthResult,
	type AuthType,
	formatThrownValue,
	type LoginOptions,
	type Model,
	type ModelAuth,
	ModelsError,
	type ModelsRefreshOptions,
	type ModelsRefreshResult,
	type ModelType,
	type ModelTypeMap,
	type MutableModels,
} from "@earendil-works/pi-ai";
import { Effect, Option, Predicate, Record, Redacted, Schema } from "effect";
import { type RedactedCredential, redactCredential } from "./credentials.ts";
import { AuthError, type AuthErrorReason } from "./errors.ts";
import type { ProviderId } from "./ids.ts";
import { Models } from "./models.ts";
import { carriedFailure, currentRunner } from "./run-in-pi.ts";

/** pi-ai's `AuthResolutionOverrides`, which its root does not export by name. */
type AuthResolutionOverrides = NonNullable<Parameters<MutableModels["getAuth"]>[1]>;

/** pi-ai's `ModelAuth` with its secrets `Redacted`: the key, and every header (auth headers carry tokens). */
export interface RedactedModelAuth {
	readonly apiKey?: Redacted.Redacted<string>;
	/** `null` removes a header pi-ai would otherwise send. */
	readonly headers?: Record.ReadonlyRecord<string, Redacted.Redacted<string> | null>;
	readonly baseUrl?: ModelAuth["baseUrl"];
}

/** pi-ai's `AuthResult` with its secrets `Redacted`: the auth of one request, and where it came from. */
export interface ResolvedAuth {
	readonly auth: RedactedModelAuth;
	/** Provider-scoped settings resolved with the auth (Cloudflare account ids). */
	readonly env?: AuthResult["env"];
	/** Where the auth came from, for status: `"ANTHROPIC_API_KEY"`, `"OAuth"`, `"stored credential"`. */
	readonly source?: AuthResult["source"];
}

/** pi-ai's `AuthResolutionOverrides` without `signal` (the fiber owns cancellation), the key `Redacted`. */
export interface AuthOverrides {
	readonly apiKey?: Redacted.Redacted<string>;
	readonly env?: AuthResolutionOverrides["env"];
	/** How long an OAuth token must still be valid, or it is refreshed first. pi-ai's default: five minutes. */
	readonly minOAuthValidityMs?: AuthResolutionOverrides["minOAuthValidityMs"];
}

/**
 * The auth a request of `provider` (an id, or a model, whose static headers are added) would use, resolved by pi-ai:
 * the stored credential, refreshing an OAuth token that expires within `minOAuthValidityMs`, or the environment.
 * None when the provider is unknown or not configured.
 */
export const getAuth = Effect.fn("Auth.getAuth")(function* (
	provider: ProviderId | AnyModel,
	overrides?: AuthOverrides,
): Effect.fn.Return<Option.Option<ResolvedAuth>, AuthError, Models> {
	const models = yield* Models;
	const result = yield* Effect.tryPromise({
		try: (signal) => {
			const resolution: AuthResolutionOverrides = {
				...overrides,
				apiKey: overrides?.apiKey === undefined ? undefined : Redacted.value(overrides.apiKey),
				signal,
			};
			// Two overloads of pi-ai's `getAuth`: TypeScript picks one per member of the union.
			return Predicate.isString(provider)
				? models.getAuth(provider, resolution)
				: models.getAuth(provider, resolution);
		},
		catch: (error) => authError(error, "auth"),
	});
	return Option.map(Option.fromUndefinedOr(result), redactAuth);
});

/** Whether a provider's auth is configured, and how, without refreshing an OAuth token. None when it is not. */
export const checkAuth = Effect.fn("Auth.checkAuth")(function* (
	providerId: ProviderId,
): Effect.fn.Return<Option.Option<AuthCheck>, AuthError, Models> {
	const models = yield* Models;
	const check = yield* Effect.tryPromise({
		try: (signal) => models.checkAuth(providerId, { signal }),
		catch: (error) => authError(error, "auth"),
	});
	return Option.fromUndefinedOr(check);
});

/** The chat models of the providers whose auth is configured; of one provider when `providerId` is given. */
export const getAvailable = Effect.fn("Auth.getAvailable")(function* (
	providerId?: ProviderId,
): Effect.fn.Return<ReadonlyArray<Model<Api>>, AuthError, Models> {
	const models = yield* Models;
	return yield* Effect.tryPromise({
		try: (signal) => models.getAvailable(providerId, { signal }),
		catch: (error) => authError(error, "auth"),
	});
});

/** `getAvailable` for the models of one type (`chat`, `image`, `classifier`). */
export const getAvailableOfType = Effect.fn("Auth.getAvailableOfType")(function* <TType extends ModelType>(
	type: TType,
	providerId?: ProviderId,
): Effect.fn.Return<ReadonlyArray<ModelTypeMap[TType]>, AuthError, Models> {
	const models = yield* Models;
	return yield* Effect.tryPromise({
		try: (signal) => models.getAvailableOfType(type, providerId, { signal }),
		catch: (error) => authError(error, "auth"),
	});
});

/** `getAvailable` for the models of every type. */
export const getAllAvailable = Effect.fn("Auth.getAllAvailable")(function* (
	providerId?: ProviderId,
): Effect.fn.Return<ReadonlyArray<AnyModel>, AuthError, Models> {
	const models = yield* Models;
	return yield* Effect.tryPromise({
		try: (signal) => models.getAllAvailable(providerId, { signal }),
		catch: (error) => authError(error, "auth"),
	});
});

/**
 * Fetches the model catalogs of the configured providers that have one (all, or `options.providers`), as pi-ai's
 * `refresh`. Never fails: a provider's failure is in `errors`. Interrupting it aborts the fetches.
 */
export const refreshModels = Effect.fn("Auth.refreshModels")(function* (
	options?: Omit<ModelsRefreshOptions, "signal">,
): Effect.fn.Return<ModelsRefreshResult, never, Models> {
	const models = yield* Models;
	return yield* Effect.promise((signal) => models.refresh({ ...options, signal }));
});

/** A question of a login flow: pi-ai's `AuthPrompt` without its `signal` (the prompt's fiber is interrupted instead). */
export type LoginPrompt = AuthPrompt extends infer P ? (P extends unknown ? Omit<P, "signal"> : never) : never;

/** How a login flow talks to the user, in Effect terms (pi-ai's `AuthInteraction`). */
export interface LoginInteraction<E = never, R = never> {
	/**
	 * Asks the user: the text entered, or the `id` of the option selected. Failing cancels the login with this failure.
	 * Interrupted when the flow no longer needs the answer (the browser's callback arrived first).
	 */
	readonly prompt: (prompt: LoginPrompt) => Effect.Effect<string, E, R>;
	/**
	 * Tells the user something: a URL to open, a device code, progress. pi-ai does not wait for it, so it must not wait
	 * either (print, log, offer to a queue); one that waits is a defect that fails the login.
	 */
	readonly notify: (event: AuthEvent) => Effect.Effect<void, never, R>;
}

/** pi-ai's `LoginOptions` with the device id as an Effect. */
export interface LoginEffectOptions<R = never> {
	/**
	 * The stable id of this installation, for flows that send one (OpenAI's agent host id). Asked only by those flows,
	 * so the id can be made on first use; it must be the same every time. It must not wait.
	 */
	readonly deviceId?: Effect.Effect<string, never, R>;
	/** The name the application introduces itself with during login. pi-ai's default: its own. */
	readonly agentName?: LoginOptions["agentName"];
}

/**
 * Runs the provider's own login flow of `type` (`"oauth"`, or `"api_key"` to prompt for a key) and stores the
 * credential it returns in the collection's credential store. Interrupting it aborts the flow. Fails with the
 * interaction's own failure when a prompt failed, or `AuthError`: `provider` for an unknown provider, `auth` when the
 * provider has no such login or the store failed, `login` when the flow failed.
 */
export const login = Effect.fn("Auth.login")(function* <E = never, R = never>(
	providerId: ProviderId,
	type: AuthType,
	interaction: LoginInteraction<E, R>,
	options?: LoginEffectOptions<R>,
): Effect.fn.Return<RedactedCredential, AuthError | E, Models | R> {
	const models = yield* Models;
	const run = yield* currentRunner<R>();
	const context = yield* Effect.context<R>();
	// pi-ai calls `notify` and `getDeviceId` without waiting: one that does not complete at once throws, which fails
	// the flow.
	const now = Effect.runSyncWith(context);
	const { deviceId, agentName } = options ?? {};
	const credential = yield* Effect.tryPromise({
		try: (signal) =>
			models.login(
				providerId,
				type,
				{
					signal,
					// The rest of one of pi-ai's prompts is that prompt without `signal`; the destructuring loses the union.
					prompt: ({ signal: promptSignal, ...prompt }) =>
						run(
							Effect.mapError(interaction.prompt(prompt as LoginPrompt), (failure) =>
								InteractionFailed.make({ failure }),
							),
							promptSignal === undefined ? signal : AbortSignal.any([signal, promptSignal]),
						),
					notify: (event) => now(interaction.notify(event)),
				},
				{
					...(agentName === undefined ? {} : { agentName }),
					...(deviceId === undefined ? {} : { getDeviceId: () => now(deviceId) }),
				},
			),
		catch: (error): AuthError | E => {
			const failure = carriedFailure(error);
			// The interaction's failure, marked by this call, so a failure of the store is never taken for it; only the
			// interaction's prompts fail with `E`.
			return Option.isSome(failure) && isInteractionFailed(failure.value)
				? (failure.value.failure as E)
				: authError(error, "login");
		},
	});
	return redactCredential(credential);
});

/** Removes the stored credential of a provider. Fails with `AuthError` (`auth`) when the store fails. */
export const logout = Effect.fn("Auth.logout")(function* (
	providerId: ProviderId,
): Effect.fn.Return<void, AuthError, Models> {
	const models = yield* Models;
	yield* Effect.tryPromise({
		try: (signal) => models.logout(providerId, { signal }),
		catch: (error) => authError(error, "auth"),
	});
});

/** A failure of a login interaction, as the rejection of its prompt; its message is the failure's. */
class InteractionFailed extends Schema.TaggedError<InteractionFailed, { readonly brand: unique symbol }>()(
	"InteractionFailed",
	{ failure: Schema.Defect() },
) {
	override get message(): string {
		return formatThrownValue(this.failure);
	}
}

const isInteractionFailed = Schema.is(InteractionFailed);

/** pi-ai's `ModelsError` as `AuthError`; anything else pi-ai rejects with gets `reason`. */
function authError(error: unknown, reason: AuthErrorReason): AuthError {
	// Wire input: what pi-ai rejected with, its `ModelsError` or a provider's own failure.
	return error instanceof ModelsError
		? AuthError.make({ reason: error.code, message: error.message, cause: error })
		: AuthError.make({ reason, message: formatThrownValue(error), cause: error });
}

function redactAuth(result: AuthResult): ResolvedAuth {
	const { apiKey, headers, ...rest } = result.auth;
	return {
		...result,
		auth: {
			...rest,
			...(apiKey === undefined ? {} : { apiKey: Redacted.make(apiKey) }),
			...(headers === undefined
				? {}
				: { headers: Record.map(headers, (value) => (value === null ? null : Redacted.make(value))) }),
		},
	};
}
