// `@effectified/pi-durable/env`: Pi's environment contract, the files and commands a harness's tools work on, in
// Effect terms: its types, its failures as tagged errors, its results as Effects, its text decoding over Streams.

// Every type of the contract (`ExecutionEnv`, `FileInfo`, `ShellExecResult`, `Result`, `FileError`, ...), so an
// application names them without importing Pi; where this module exports a name of its own, its own wins.
export type * from "@earendil-works/pi-durable/env";
// Pure values of the contract: a result's constructors and its optional value, the errors an implementation returns
// in a result, an error of anything thrown, and whether bytes start with a byte-order mark.
export {
	ExecutionError,
	err,
	FileError,
	getOrUndefined,
	ok,
	startsWithBom,
	toError,
} from "@earendil-works/pi-durable/env";
export { EXECUTION_ERROR_CODES, ExecFailed, FILE_ERROR_CODES, FileFailed } from "./errors.ts";
export { fromResult } from "./result.ts";
export { decodeRange, decodeText, type LineRange, scanLines } from "./text.ts";
