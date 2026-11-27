// What pi-ai's auth resolution reads outside the credential store, as an Effect service: environment variables
// through `Config`, and whether a credentials file exists.

import { type AuthContext, defaultProviderAuthContext } from "@earendil-works/pi-ai";
import { Config, Context, Effect, Layer, Option, Redacted, String as Str } from "effect";
import type { RunInPi } from "./run-in-pi.ts";

/** pi-ai's `AuthContext` in Effect terms. */
export interface ProviderAuthContextService {
	/** An environment variable an API key auth reads (`ANTHROPIC_API_KEY`); none when unset or blank. */
	readonly env: (name: string) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, Config.ConfigError>;
	/** Whether a file exists (`~/.aws/credentials`, a leading `~` is the home directory); never in a browser. */
	readonly fileExists: (path: string) => Effect.Effect<boolean>;
}

/** Where `Models.layerWithAuth` resolves the ambient part of a provider's auth: the environment and files. */
export class ProviderAuthContext extends Context.Service<ProviderAuthContext, ProviderAuthContextService>()(
	"@effectified/pi-ai/auth-context/ProviderAuthContext",
) {
	/**
	 * pi-ai's default context with the environment read through `Config`, so a `ConfigProvider` (a test's, or one that
	 * reads a secrets manager) supplies the keys. As in pi-ai, a blank value counts as unset. Files are checked by
	 * pi-ai's own default, which knows the platform.
	 */
	static readonly layer: Layer.Layer<ProviderAuthContext> = Layer.sync(ProviderAuthContext, () => {
		const files = defaultProviderAuthContext();
		return {
			env: Effect.fn("ProviderAuthContext.env")(function* (name: string) {
				const value = yield* Config.option(Config.Redacted(name));
				return Option.filter(value, (secret) => Str.isNonEmpty(Str.trim(Redacted.value(secret))));
			}),
			fileExists: Effect.fn("ProviderAuthContext.fileExists")(function* (path: string) {
				return yield* Effect.promise(() => files.fileExists(path));
			}),
		};
	});
}

/** `context` as pi-ai's `AuthContext`, its Effects run with `run`. */
export function toPiAuthContext<R>(context: ProviderAuthContextService, run: RunInPi<R>): AuthContext {
	return {
		env: (name) =>
			run(Effect.map(context.env(name), (value) => Option.getOrUndefined(Option.map(value, Redacted.value)))),
		fileExists: (path) => run(context.fileExists(path)),
	};
}
