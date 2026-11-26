// Effect Schema to and from Pi tool parameters (JSON Schema), and pi-schema's validator with typed errors.

// pi-schema's builders, its deep equality and its types, so tool parameters written as JSON Schema need no second
// import. Its validators (`compile`, `Validator`, `CoercingValidator`) throw and are replaced by `validator`; that
// nothing else of pi-schema is left out is checked in test/pi-conformance.ts.
export type * from "@earendil-works/pi-schema";
export {
	arr,
	bigint,
	bool,
	bytes,
	equal,
	int,
	lit,
	map,
	nul,
	nullable,
	num,
	Optional,
	obj,
	oneOf,
	opt,
	recursive,
	str,
	tuple,
	union,
	unknown,
	unsafe,
} from "@earendil-works/pi-schema";
export { decodeUnknown, encode } from "./codec.ts";
export { Issue, SchemaConversionError, SchemaDecodeError } from "./errors.ts";
export { type FromJsonSchemaOptions, fromJsonSchema, type ToJsonSchemaOptions, toJsonSchema } from "./json-schema.ts";
export { type Validator, validator } from "./validator.ts";
