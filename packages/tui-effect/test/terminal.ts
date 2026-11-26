// The terminal the tests draw on: pi-tui's own virtual terminal (xterm.js, headless), which also records the terminal
// state a test cannot read back from xterm (title, progress, program status). Never a real TTY.

import type { ProgramStatus } from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";

/** pi-tui's `VirtualTerminal`, recording what it is asked to show besides text. */
export class TestTerminal extends VirtualTerminal {
	readonly titles: string[] = [];
	readonly progress: boolean[] = [];
	readonly statuses: ProgramStatus[] = [];
	started = 0;
	stopped = 0;

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.started += 1;
		super.start(onInput, onResize);
	}

	override stop(): void {
		this.stopped += 1;
		super.stop();
	}

	override setTitle(title: string): void {
		this.titles.push(title);
		super.setTitle(title);
	}

	override setProgress(active: boolean): void {
		this.progress.push(active);
	}

	// `VirtualTerminal` declares this method without the status pi-tui's `Terminal` passes, so it is optional here.
	override setProgramStatus(status?: ProgramStatus): void {
		if (status !== undefined) this.statuses.push(status);
	}

	/** The visible rows once xterm processed every write, without trailing blank rows. */
	readonly screen: Effect.Effect<string[]> = Effect.promise(async () => {
		const rows = (await this.flushAndGetViewport()).map((row) => row.trimEnd());
		while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
		return rows;
	});
}
