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
import { Effect, Exit, Option, Redacted } from "effect";
import { type RedactedCredential, redactCredential } from "./credentials.ts";
import { AuthError, type AuthErrorReason } from "./errors.ts";
import { Models } from "./models.ts";
import { carriedFailure, currentRunner } from "./run-in-pi.ts";

/** pi-ai's `AuthResolutionOverrides`, which its root does not export by name. */
type AuthResolutionOverrides = NonNullable<Parameters<MutableModels["getAuth"]>[1]>;

/** pi-ai's `ModelAuth` with its secrets `Redacted`: the key, and every header (auth headers carry tokens). */
export interface RedactedModelAuth {
	readonly apiKey?: Redacted.Redacted<string>;
	/** `null` removes a header pi-ai would otherwise send. */
	readonly headers?: Readonly<Record<string, Redacted.Redacted<string> | null>>;
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
export function getAuth(
	provider: string | AnyModel,
	overrides?: AuthOverrides,
): Effect.Effect<Option.Option<ResolvedAuth>, AuthError, Models> {
	return Models.use((models) =>
		Effect.map(
			Effect.tryPromise({
				try: (signal) => {
					const resolution: AuthResolutionOverrides = {
						...overrides,
						apiKey: overrides?.apiKey === undefined ? undefined : Redacted.value(overrides.apiKey),
						signal,
					};
					return typeof provider === "string"
						? models.getAuth(provider, resolution)
						: models.getAuth(provider, resolution);
				},
				catch: (error) => authError(error, "auth"),
			}),
			(result) => Option.map(Option.fromUndefinedOr(result), redactAuth),
		),
	);
}

/** Whether a provider's auth is configured, and how, without refreshing an OAuth token. None when it is not. */
export function checkAuth(providerId: string): Effect.Effect<Option.Option<AuthCheck>, AuthError, Models> {
	return Models.use((models) =>
		Effect.map(
			Effect.tryPromise({
				try: (signal) => models.checkAuth(providerId, { signal }),
				catch: (error) => authError(error, "auth"),
			}),
			Option.fromUndefinedOr,
		),
	);
}

/** The chat models of the providers whose auth is configured; of one provider when `providerId` is given. */
export function getAvailable(providerId?: string): Effect.Effect<ReadonlyArray<Model<Api>>, AuthError, Models> {
	return Models.use((models) =>
		Effect.tryPromise({
			try: (signal) => models.getAvailable(providerId, { signal }),
			catch: (error) => authError(error, "auth"),
		}),
	);
}

/** `getAvailable` for the models of one type (`chat`, `image`, `classifier`). */
export function getAvailableOfType<TType extends ModelType>(
	type: TType,
	providerId?: string,
): Effect.Effect<ReadonlyArray<ModelTypeMap[TType]>, AuthError, Models> {
	return Models.use((models) =>
		Effect.tryPromise({
			try: (signal) => models.getAvailableOfType(type, providerId, { signal }),
			catch: (error) => authError(error, "auth"),
		}),
	);
}

/** `getAvailable` for the models of every type. */
export function getAllAvailable(providerId?: string): Effect.Effect<ReadonlyArray<AnyModel>, AuthError, Models> {
	return Models.use((models) =>
		Effect.tryPromise({
			try: (signal) => models.getAllAvailable(providerId, { signal }),
			catch: (error) => authError(error, "auth"),
		}),
	);
}

/**
 * Fetches the model catalogs of the configured providers that have one (all, or `options.providers`), as pi-ai's
 * `refresh`. Never fails: a provider's failure is in `errors`. Interrupting it aborts the fetches.
 */
export function refreshModels(
	options?: Omit<ModelsRefreshOptions, "signal">,
): Effect.Effect<ModelsRefreshResult, never, Models> {
	return Models.use((models) => Effect.promise((signal) => models.refresh({ ...options, signal })));
}

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
export function login<E = never, R = never>(
	providerId: string,
	type: AuthType,
	interaction: LoginInteraction<E, R>,
	options?: LoginEffectOptions<R>,
): Effect.Effect<RedactedCredential, AuthError | E, Models | R> {
	return Effect.gen(function* () {
		const models = yield* Models;
		const run = yield* currentRunner<R>();
		const context = yield* Effect.context<R>();
		const runSync = Effect.runSyncExitWith(context);
		const now = <A>(effect: Effect.Effect<A, never, R>): A => {
			const exit = runSync(effect);
			if (Exit.isSuccess(exit)) return exit.value;
			throw new Error(`A login callback did not complete at once: ${String(exit.cause)}`);
		};
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
								Effect.mapError(
									interaction.prompt(prompt as LoginPrompt),
									(failure) => new InteractionFailed(failure),
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
				return Option.isSome(failure) && failure.value instanceof InteractionFailed
					? (failure.value.failure as E)
					: authError(error, "login");
			},
		});
		return redactCredential(credential);
	});
}

/** Removes the stored credential of a provider. Fails with `AuthError` (`auth`) when the store fails. */
export function logout(providerId: string): Effect.Effect<void, AuthError, Models> {
	return Models.use((models) =>
		Effect.tryPromise({
			try: (signal) => models.logout(providerId, { signal }),
			catch: (error) => authError(error, "auth"),
		}),
	);
}

/** A failure of a login interaction, as the rejection of its prompt; its message is the failure's. */
class InteractionFailed extends Error {
	readonly failure: unknown;

	constructor(failure: unknown) {
		super(formatThrownValue(failure));
		this.failure = failure;
	}
}

/** pi-ai's `ModelsError` as `AuthError`; anything else pi-ai rejects with gets `reason`. */
function authError(error: unknown, reason: AuthErrorReason): AuthError {
	return error instanceof ModelsError
		? new AuthError({ reason: error.code, message: error.message })
		: new AuthError({ reason, message: formatThrownValue(error) });
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
				: {
						headers: Object.fromEntries(
							Object.entries(headers).map(([name, value]) => [
								name,
								value === null ? null : Redacted.make(value),
							]),
						),
					}),
		},
	};
}
