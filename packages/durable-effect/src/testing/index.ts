// The testing kit of this package: a harness on scripted models, and the responses to script.

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
} from "@gunta/pi-ai-effect/testing";
export { answer, type Held, held, toolCall } from "./responses.ts";
export * as TestHarness from "./test-harness.ts";
