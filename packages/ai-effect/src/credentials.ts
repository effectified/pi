// pi-ai's credential store as an Effect service: one credential per provider, read and written as Effects, with
// every secret `Redacted`.

import {
	type ApiKeyCredential,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	InMemoryCredentialStore,
	type OAuthCredential,
} from "@earendil-works/pi-ai";
import { Context, Effect, Layer, Option, Redacted } from "effect";
import { CredentialStoreError } from "./errors.ts";
import { carriedFailure, currentRunner, type RunInPi } from "./run-in-pi.ts";

/** pi-ai's stored API key credential, its key `Redacted`. */
export interface RedactedApiKeyCredential {
	readonly type: ApiKeyCredential["type"];
	readonly key?: Redacted.Redacted<string>;
	/** Provider-scoped settings such as Cloudflare account ids: not secret, kept as they are. */
	readonly env?: ApiKeyCredential["env"];
}

/** pi-ai's stored OAuth credential, its tokens `Redacted`. A flow's own fields (an account id) are kept as they are. */
export interface RedactedOAuthCredential {
	readonly type: OAuthCredential["type"];
	readonly access: Redacted.Redacted<string>;
	readonly refresh: Redacted.Redacted<string>;
	/** When the access token expires, in Unix milliseconds. */
	readonly expires: OAuthCredential["expires"];
	readonly [field: string]: unknown;
}

/** pi-ai's `Credential` with its secrets `Redacted`: what the `Credentials` service reads and writes. */
export type RedactedCredential = RedactedApiKeyCredential | RedactedOAuthCredential;

/** pi-ai's `CredentialStore` in Effect terms. */
export interface CredentialsService {
	/** The stored credential of a provider, possibly expired. For status; a request's auth comes from `getAuth`. */
	readonly read: (providerId: string) => Effect.Effect<Option.Option<RedactedCredential>, CredentialStoreError>;
	/** Which providers have a credential, and of which type, without any secret. */
	readonly list: Effect.Effect<ReadonlyArray<CredentialInfo>, CredentialStoreError>;
	/**
	 * The one way to write: `f` sees the current credential and returns the new one, or nothing to leave it. Runs one
	 * at a time per provider. Succeeds with the credential stored afterwards.
	 */
	readonly modify: <E, R>(
		providerId: string,
		f: (current: Option.Option<RedactedCredential>) => Effect.Effect<Option.Option<RedactedCredential>, E, R>,
	) => Effect.Effect<Option.Option<RedactedCredential>, E | CredentialStoreError, R>;
	/** Removes the credential of a provider (logout). */
	readonly delete: (providerId: string) => Effect.Effect<void, CredentialStoreError>;
}

/**
 * Where the credentials of `Models` live, keyed by provider id. `Models.layerWithAuth` hands it to pi-ai, which
 * refreshes OAuth tokens inside `modify`, so two requests never refresh one token twice.
 */
export class Credentials extends Context.Service<Credentials, CredentialsService>()("@effectified/pi-ai/Credentials") {
	/** pi-ai's `InMemoryCredentialStore`: credentials that end with the program, for one process and for tests. */
	static readonly layerMemory: Layer.Layer<Credentials> = Layer.sync(Credentials, () =>
		fromPiStore(new InMemoryCredentialStore()),
	);

	/** A pi-ai `CredentialStore` (an application's file or keychain store) as the service. */
	static fromPiStore(store: CredentialStore): CredentialsService {
		return fromPiStore(store);
	}
}

/** `credential` with its secrets `Redacted`. */
export function redactCredential(credential: Credential): RedactedCredential {
	if (credential.type === "api_key") {
		const { key, ...rest } = credential;
		return key === undefined ? rest : { ...rest, key: Redacted.make(key) };
	}
	return { ...credential, access: Redacted.make(credential.access), refresh: Redacted.make(credential.refresh) };
}

/** pi-ai's `Credential` of `credential`: its secrets in the clear, to persist or to hand to pi-ai. */
export function revealCredential(credential: RedactedCredential): Credential {
	if (credential.type === "api_key") {
		// `type` tells the two members apart; TypeScript cannot narrow through the OAuth member's index signature.
		const { key, ...rest } = credential as RedactedApiKeyCredential;
		return key === undefined ? rest : { ...rest, key: Redacted.value(key) };
	}
	const oauth = credential as RedactedOAuthCredential;
	return { ...oauth, type: "oauth", access: Redacted.value(oauth.access), refresh: Redacted.value(oauth.refresh) };
}

function fromPiStore(store: CredentialStore): CredentialsService {
	return {
		read: (providerId) =>
			Effect.map(
				Effect.tryPromise({
					try: (signal) => store.read(providerId, { signal }),
					catch: (error) => storeError(providerId, error),
				}),
				(credential) => Option.map(Option.fromUndefinedOr(credential), redactCredential),
			),
		list: Effect.tryPromise({
			try: (signal) => store.list({ signal }),
			catch: (error) => storeError(undefined, error),
		}),
		modify: <E, R>(
			providerId: string,
			f: (current: Option.Option<RedactedCredential>) => Effect.Effect<Option.Option<RedactedCredential>, E, R>,
		) =>
			Effect.flatMap(currentRunner<R>(), (run) =>
				Effect.map(
					Effect.tryPromise({
						try: (signal) =>
							store.modify(
								providerId,
								async (current) =>
									Option.getOrUndefined(
										Option.map(
											await run(f(Option.map(Option.fromUndefinedOr(current), redactCredential)), signal),
											revealCredential,
										),
									),
								{ signal },
							),
						// A failure of `f` comes back as the rejection it was carried in; `E` is its type.
						catch: (error) =>
							Option.getOrElse(carriedFailure(error) as Option.Option<E>, () => storeError(providerId, error)),
					}),
					(stored) => Option.map(Option.fromUndefinedOr(stored), redactCredential),
				),
			),
		delete: (providerId) =>
			Effect.tryPromise({
				try: (signal) => store.delete(providerId, { signal }),
				catch: (error) => storeError(providerId, error),
			}),
	};
}

/** `credentials` as pi-ai's `CredentialStore`, its Effects run with `run`. */
export function toPiStore<R>(credentials: CredentialsService, run: RunInPi<R>): CredentialStore {
	return {
		read: async (providerId, options) =>
			Option.getOrUndefined(Option.map(await run(credentials.read(providerId), options?.signal), revealCredential)),
		list: (options) => run(credentials.list, options?.signal),
		modify: async (providerId, fn, options) => {
			const write = credentials.modify(providerId, (current) =>
				Effect.map(
					Effect.tryPromise({
						try: () => fn(Option.getOrUndefined(Option.map(current, revealCredential))),
						// pi-ai's own failure inside `fn` (a refresh that failed) goes back to pi-ai as it was thrown.
						catch: (error): unknown => error,
					}),
					(next) => Option.map(Option.fromUndefinedOr(next), redactCredential),
				),
			);
			try {
				return Option.getOrUndefined(Option.map(await run(write, options?.signal), revealCredential));
			} catch (error) {
				throw Option.getOrElse(carriedFailure(error), () => error);
			}
		},
		delete: (providerId, options) => run(credentials.delete(providerId), options?.signal),
	};
}

function storeError(providerId: string | undefined, error: unknown): CredentialStoreError {
	return new CredentialStoreError({
		providerId,
		message: error instanceof Error ? error.message : String(error),
	});
}
