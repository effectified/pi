// For tests: a scripted pi-ai provider behind `Models`, a scripted effect/ai `LanguageModel`, the run of a test's
// Effect on the test clock, and waits on a fake's state.

export {
	type FauxResponseFactory,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai";
export { type Conditions, conditions } from "./conditions.ts";
export { runLive, runTest, type TestServices } from "./run-test.ts";
export {
	ScriptedLanguageModel,
	type ScriptedLanguageModelService,
	type ScriptedResponse,
} from "./scripted-language-model.ts";
export { ScriptedModels, type ScriptedModelsService } from "./scripted-models.ts";
