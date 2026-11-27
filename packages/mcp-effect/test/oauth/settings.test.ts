// The OAuth client settings with the client secret `Redacted`, and the settings Pi takes.

import { Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { toPiSettings } from "../../src/oauth/settings.ts";

describe("toPiSettings", () => {
	it("reveals the client secret for Pi, and keeps the other settings as they are", () => {
		const settings = { clientId: "app", clientSecret: Redacted.make("s3cret"), scope: "issues:read" };
		expect(String(settings.clientSecret)).not.toContain("s3cret");
		expect(toPiSettings(settings)).toEqual({ clientId: "app", clientSecret: "s3cret", scope: "issues:read" });
	});

	it("gives Pi no secret when there is none", () => {
		expect(toPiSettings({ scope: "issues:read" })).toEqual({ scope: "issues:read" });
	});
});
