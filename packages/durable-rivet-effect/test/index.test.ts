// The public surface: what each subpath exports.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as Main from "../src/index.ts";
import * as Node from "../src/node.ts";
import * as Testing from "../src/testing/index.ts";

describe("the package's exports", () => {
	it("are these, from the main entry", () => {
		expect(Object.keys(Main).sort()).toEqual([
			"Action",
			"ActionFailed",
			"Actor",
			"ActorDatabase",
			"ActorDefect",
			"ActorEngine",
			"ActorGone",
			"ActorInfo",
			"Client",
			"EngineUnavailable",
			"Fork",
			"ForkKeyHeld",
			"Host",
			"NotIdle",
			"Self",
			"SqliteDatabase",
			"storage",
		]);
		expect(Object.keys(Main.Action).sort()).toEqual(["boundary", "make"]);
		expect(Object.keys(Main.Actor).sort()).toEqual(["make"]);
		expect(Object.keys(Main.Client).sort()).toEqual([
			"RivetClient",
			"call",
			"destroy",
			"find",
			"fork",
			"getOrCreate",
			"isIdle",
			"layer",
			"lineage",
			"status",
			"waitForIdle",
		]);
		expect(Object.keys(Main.Fork).sort()).toEqual(["lineage"]);
		expect(Object.keys(Main.Host).sort()).toEqual(["serve", "use"]);
		expect(Object.keys(Main.Self).sort()).toEqual(["client", "definition", "find", "getOrCreate", "handle"]);
		expect(Object.keys(Main.SqliteDatabase).sort()).toEqual(["make"]);
	});

	it("are these, from the node entry, which the bun entry mirrors", () => {
		expect(Object.keys(Node).sort()).toEqual(["available", "serve"]);
	});

	it("are these, from the testing entry, which has no platform code", () => {
		expect(Object.keys(Testing).sort()).toEqual([
			"hosted",
			"lifecycle",
			"observed",
			"scheduleWake",
			"schedules",
			"seen",
			"sleep",
		]);
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		expect(manifest.exports["./testing"]).toEqual({
			source: "./src/testing/index.ts",
			types: "./dist/testing/index.d.ts",
			import: "./dist/testing/index.js",
		});
		const source = readFileSync(new URL("../src/testing/index.ts", import.meta.url), "utf8");
		expect(source).not.toMatch(/from "(node|bun):/);
	});
});
