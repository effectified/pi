// The OAuth client settings of one MCP server in Effect terms: Pi's settings, with the client secret `Redacted`.

import type { McpOAuthSettings } from "@earendil-works/pi-mcp/oauth";
import { Redacted } from "effect";

/**
 * Pi's client settings of one MCP server (`clientId`, `scope`, the loopback callback, ...), its `clientSecret`
 * `Redacted`, as `Config.redacted` reads one, so that it shows in no log or error.
 */
export type OAuthSettings = Omit<McpOAuthSettings, "clientSecret"> & {
	/** The secret of the pre-registered client `clientId`, resolved already. */
	readonly clientSecret?: Redacted.Redacted<string>;
};

/** `settings` as Pi takes them: the client secret leaves `Redacted` only here, where it is handed to Pi. */
export function toPiSettings(settings: OAuthSettings): McpOAuthSettings {
	const { clientSecret, ...rest } = settings;
	return clientSecret === undefined ? rest : { ...rest, clientSecret: Redacted.value(clientSecret) };
}
