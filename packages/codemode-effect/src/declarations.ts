// The entry of `@effectified/pi-codemode/declarations`: the TypeScript declarations a model reads for a sandbox's
// tools and globals, rendered from their JSON Schemas. Pure functions, as Pi has them; no sandbox is loaded.

export type * from "@earendil-works/pi-codemode/declarations";
export {
	DEFAULT_INPUT_SCHEMA_MAX_CHARS,
	renderDeclarations,
	renderToolOutputType,
	renderToolSample,
	renderToolSignature,
	resolveSchemaRef,
	schemaToType,
	toCodemodeIdentifier,
} from "@earendil-works/pi-codemode/declarations";
