// The QuickJS WebAssembly module every sandbox runs its VMs on, loaded and compiled from a file (Node and Bun).

import { type CodemodeWasmModule, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { Effect } from "effect";
import { messageOf, WasmLoadFailed } from "./errors.ts";

/**
 * Reads and compiles `quickjs-wasi/quickjs.wasm`, once per path: Pi keeps the module, and a failed load is tried again
 * on the next call. `path` defaults to the file of the installed `quickjs-wasi`; pass it when the file lives
 * elsewhere, such as embedded in a Bun compiled executable.
 */
export const load = Effect.fn("Wasm.load")(function* (
	path?: string,
): Effect.fn.Return<CodemodeWasmModule, WasmLoadFailed> {
	return yield* Effect.tryPromise({
		try: () => loadQuickJSWasm(path),
		catch: (cause) => WasmLoadFailed.make({ message: messageOf(cause), cause }),
	});
});
