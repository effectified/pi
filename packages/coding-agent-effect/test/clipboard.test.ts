import { runLive } from "@effectified/pi-ai/testing";
import { describe, expect, it } from "vitest";
import { copyToClipboard } from "../src/index.ts";

/** A Linux machine without a desktop: Pi copies through the terminal (OSC 52), not a clipboard of the user's. */
const headless =
	process.platform === "linux" &&
	process.env.DISPLAY === undefined &&
	process.env.WAYLAND_DISPLAY === undefined &&
	process.env.TERMUX_VERSION === undefined;

describe("copyToClipboard", () => {
	// Elsewhere it would replace what the user has on their clipboard.
	it.skipIf(!headless)("copies through the terminal where there is no desktop clipboard", async () => {
		await expect(runLive(copyToClipboard("copied"))).resolves.toBeUndefined();
	});

	it.skipIf(!headless)("fails with Pi's error when the text is over the terminal's limit", async () => {
		await expect(runLive(copyToClipboard("x".repeat(200_000)))).rejects.toThrow("OSC 52 size limit");
	});
});
