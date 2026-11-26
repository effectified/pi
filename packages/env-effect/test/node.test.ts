import { describe, expect, it } from "vitest";
import * as Node from "../src/node.ts";

describe("the exports of `/node`", () => {
	it("are pi-env's connections, programs, environments and SSH at `/node`", () => {
		expect(Object.keys(Node).sort()).toEqual([
			"Connection",
			"HostKey",
			"Local",
			"Process",
			"Remote",
			"RemoteWatch",
			"Ssh",
			"Terminal",
			"nodePlatform",
			"packagedDaemon",
		]);
	});
});
