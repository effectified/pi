// `@effectified/pi-chord/output`: Chord's bounded output, the head or tail window a tool keeps of a long stream.

// Chord's output types (`OutputLimits`, `BoundedOutput`, `OutputSlice`, `OutputSkip`, `ProgressClock`).
export type * from "@earendil-works/chord/output";
// Chord's bounded output: synchronous and free of I/O. `OutputBuffer` holds the window of one stream as it grows.
// `Progress` is not offered: it paces promise-returning writes on timers (see `test/output.test.ts`).
export {
	boundOutput,
	characterEnd,
	OutputBuffer,
	PROGRESS_BYTES_PER_SECOND,
	sanitizeOutput,
	utf8ByteLength,
} from "@earendil-works/chord/output";
