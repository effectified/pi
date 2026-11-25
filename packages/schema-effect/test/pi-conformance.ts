// What schema-effect mirrors of pi-schema by hand, checked against pi-schema's own types. Type-only: nothing here runs.

import type { ValidationError } from "@earendil-works/pi-schema";
import type { Assert, Covers } from "../../../effect/conformance.ts";
import type { Issue } from "../src/index.ts";

/**
 * Every field of a pi-schema validation error is a field of `Issue`, so `validator()` hands each on. The other way,
 * that a validation error is an `Issue`, `validator.ts` checks where it passes pi-schema's errors as issues.
 */
export type IssueCovers = Assert<Covers<ValidationError, Issue>>;
