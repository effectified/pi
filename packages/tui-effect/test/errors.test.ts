import { describe, expect, it } from "vitest";
import { AutocompleteError, ClipboardError, InvalidColor, TuiError } from "../src/errors.ts";

describe("the errors", () => {
	it("are tagged, and take their message from their cause", () => {
		expect(InvalidColor.make({ value: "x", message: "Invalid color value: x" })._tag).toBe("InvalidColor");
		expect(ClipboardError.make({ operation: "getText", cause: new Error("busy") }).message).toBe("busy");
		expect(ClipboardError.make({ operation: "setText", cause: "gone" }).message).toBe("gone");
		expect(AutocompleteError.make({ cause: new Error("fd failed") }).message).toBe("fd failed");
	});

	it("keep the color value they rejected as given, a number that is not finite included", () => {
		expect(InvalidColor.make({ value: Number.NaN, message: "Invalid color value: NaN" }).value).toBeNaN();
	});

	it("form TuiError, a union whose match takes one handler per tag", () => {
		const failures: ReadonlyArray<TuiError> = [
			InvalidColor.make({ value: 300, message: "out of range" }),
			ClipboardError.make({ operation: "getImage", cause: "busy" }),
			AutocompleteError.make({ cause: "fd failed" }),
		];
		const named = failures.map(
			TuiError.match({
				InvalidColor: (error) => `color ${error.value}`,
				ClipboardError: (error) => `clipboard ${error.operation}`,
				AutocompleteError: (error) => `autocomplete ${error.message}`,
			}),
		);
		expect(named).toEqual(["color 300", "clipboard getImage", "autocomplete fd failed"]);
	});
});
