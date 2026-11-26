import { describe, expect, it } from "vitest";
import { AutocompleteError, ClipboardError, InvalidColor } from "../src/errors.ts";

describe("the errors", () => {
	it("are tagged, and take their message from their cause", () => {
		expect(new InvalidColor({ value: "x", message: "Invalid color value: x" })._tag).toBe("InvalidColor");
		expect(new ClipboardError({ operation: "getText", cause: new Error("busy") }).message).toBe("busy");
		expect(new ClipboardError({ operation: "setText", cause: "gone" }).message).toBe("gone");
		expect(new AutocompleteError({ cause: new Error("fd failed") }).message).toBe("fd failed");
	});
});
