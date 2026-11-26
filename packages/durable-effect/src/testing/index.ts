// The testing kit of this package: a harness on scripted models, and the responses to script.

// Pi's assertions over a test runner's `expect`, and the scales of its storage benchmarks: plain values.
export {
	createExpectAssertions,
	type ExpectLike,
	STORAGE_MEMORY_SCALES,
	type StorageBenchmarkDataset,
	type StorageBenchmarkScale,
	storageBenchmarkPrimaryRecordCount,
	TIMING_SCALE,
} from "@earendil-works/pi-durable/testing";
export {
	type FauxResponseFactory,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type RegisterFauxProviderOptions,
	ScriptedModels,
	type ScriptedModelsService,
} from "@effectified/pi-ai/testing";
export * as Benchmark from "./benchmark.ts";
export { type Case, type EnvOptions, envConformance, storageConformance } from "./conformance.ts";
export { answer, type Held, held, toolCall } from "./responses.ts";
export * as TestHarness from "./test-harness.ts";
