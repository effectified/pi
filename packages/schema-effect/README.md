# @effectified/pi-schema

Effect `Schema` to and from the JSON Schema that Pi tool parameters are written in, and
[`@earendil-works/pi-schema`](../schema/README.md)'s validator with typed errors. For `effect` 4.1.

## Installation

```bash
npm install @effectified/pi-schema effect
```

## Effect Schema to tool parameters

```typescript
import { Effect, Schema } from "effect";
import { decodeUnknown, encode, toJsonSchema } from "@effectified/pi-schema";

const Lookup = Schema.Struct({
	id: Schema.String.annotate({ description: "Record id" }),
	since: Schema.optional(Schema.Date),
});

toJsonSchema(Lookup);
// { type: "object", properties: { id: { type: "string", description: "Record id" }, since: { anyOf: [...] } },
//   required: ["id"], additionalProperties: false }

const args = await Effect.runPromise(decodeUnknown(Lookup)({ id: "42", since: "2026-11-24T00:00:00.000Z" }));
args.since; // Date

await Effect.runPromise(encode(Lookup)(args)); // { id: "42", since: "2026-11-24T00:00:00.000Z" }
```

`toJsonSchema` describes the schema's JSON form: a `Date` is a string, an optional field may be `null`. Shared
definitions are kept under `$defs`, so the result stands alone. Objects are closed (`additionalProperties: false`), as
pi-schema's `obj()` builds them and as strict tool calling requires; pass `{ onExcessProperty: "ignore" }` to both
`toJsonSchema` and `decodeUnknown` to leave them open.

`decodeUnknown` fails with `SchemaDecodeError`. It reports every issue, each with a JSON Pointer path like
pi-schema's:

```typescript
const error = await Effect.runPromise(Effect.flip(decodeUnknown(Lookup)({ id: 1, extra: true })));
error.issues; // [{ path: "/extra", message: "Expected no excess property" }, { path: "/id", message: "Expected string" }]
```

For the same value, the paths are the ones pi-schema's validator reports for `toJsonSchema(schema)`, with one
difference: for a union with no discriminator, `decodeUnknown` reports the issues of every member, pi-schema only
those of the member the value comes closest to.

## Tool parameters to Effect Schema

```typescript
import { fromJsonSchema, obj, str } from "@effectified/pi-schema";

const schema = await Effect.runPromise(fromJsonSchema(obj({ path: str({ minLength: 1 }) })));
```

For parameters that arrive as JSON Schema: MCP servers, tools built with pi-schema's builders. The conversion is best
effort, as Effect's importer is. Keywords Effect cannot express (`if`, `contains`, `$dynamicRef`, ...) fail with
`SchemaConversionError`. A `pattern` fails too unless you pass `{ patterns: "apply" }` (trusted schemas only) or
`{ patterns: "ignore" }`. `{ draft: "7" }` reads draft 7.

## pi-schema's validator

```typescript
import { validator } from "@effectified/pi-schema";

const read = await Effect.runPromise(validator(Read));
read.check(value); // boolean, pi-schema's allocation-free check
read.validate(value); // Effect<T, SchemaDecodeError>: the value itself, or pi-schema's errors
read.parse(value); // coerces loosely typed input as Pi coerces tool call arguments, then validates
```

Use it to check values exactly as Pi checks tool arguments. Compiling fails with `SchemaConversionError` when the
schema is malformed or a `$ref` names nothing. `SchemaDecodeError` issues carry pi-schema's `path`, `keyword` and
`message`.
