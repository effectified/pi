// Pi's code mode in Effect: sandboxes as scoped resources, an execution as an Effect, a deterministic run's events as
// a Stream, and the tools a script calls as Effects.

// Every type pi-codemode declares (`CodemodeResult`, `CodemodeTool`, `CodemodeOutcome`, ...), so an application names
// them without importing pi-codemode; where this package exports a name of its own, its own wins.
export type * from "@earendil-works/pi-codemode";
// pi-codemode's own class for a refused source, which this package's tagged `CodemodeSourceError` hides.
export type { CodemodeSourceError as PiCodemodeSourceError } from "@earendil-works/pi-codemode";
// Pi's limits and defaults, and the pure functions that render declarations and identifiers.
export {
	CODEMODE_OPTIONS_PREFIX,
	CODEMODE_SOURCE_GRAMMAR,
	DEFAULT_INPUT_SCHEMA_MAX_CHARS,
	DEFAULT_INTERRUPT_BUDGET,
	MAX_OUTPUT_CHARS,
	MAX_OUTPUT_ITEMS,
	MAX_STORE_TOTAL_CHARS,
	MAX_STORE_VALUE_CHARS,
	renderDeclarations,
	renderToolOutputType,
	renderToolSample,
	renderToolSignature,
	resolveSchemaRef,
	schemaToType,
	toCodemodeIdentifier,
} from "@earendil-works/pi-codemode";
// The schema failure building a tool can fail with, so a caller needs no second import to name it.
export { SchemaConversionError } from "@effectified/pi-agent";
export {
	AdmissionDenied,
	type CodemodeFailure,
	CodemodeSourceError,
	DeliveryRejected,
	RunRejected,
	SandboxClosed,
	ToolRejected,
	WasmLoadFailed,
} from "./errors.ts";
export * as InlineSandbox from "./inline-sandbox.ts";
export * as RemoteSandbox from "./remote-sandbox.ts";
export * as Run from "./run.ts";
export * as Sandbox from "./sandbox.ts";
export * as ScriptTool from "./script-tool.ts";
export * as Source from "./source.ts";
export * as Wasm from "./wasm.ts";
export * as WorkerSandbox from "./worker-sandbox.ts";
