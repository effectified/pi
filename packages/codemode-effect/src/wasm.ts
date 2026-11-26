// The QuickJS WebAssembly module every sandbox runs its VMs on, loaded and compiled from a file (Node and Bun).

import { type CodemodeWasmModule, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { Effect } from "effect";
import { messageOf, WasmLoadFailed } from "./errors.ts";

/**
 * Reads and compiles `quickjs-wasi/quickjs.wasm`, once per path: Pi keeps the module, and a failed load is tried again
 * on the next call. `path` defaults to the file of the installed `quickjs-wasi`; pass it when the file lives
 * elsewhere, such as embedded in a Bun compiled executable.
 */
export function load(path?: string): Effect.Effect<CodemodeWasmModule, WasmLoadFailed> {
	return Effect.tryPromise({
		try: () => loadQuickJSWasm(path),
		catch: (cause) => new WasmLoadFailed({ message: messageOf(cause), cause }),
	});
}
