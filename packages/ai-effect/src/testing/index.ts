// For tests: a scripted pi-ai provider behind `Models`, a scripted effect/ai `LanguageModel`, and the run of a test's
// Effect on the test clock.

export {
	type FauxResponseFactory,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai";
export { runLive, runTest, type TestServices } from "./run-test.ts";
export {
	ScriptedLanguageModel,
	type ScriptedLanguageModelService,
	type ScriptedResponse,
} from "./scripted-language-model.ts";
export { ScriptedModels, type ScriptedModelsService } from "./scripted-models.ts";
