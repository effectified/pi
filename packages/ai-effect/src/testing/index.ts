// Scripted models for tests: a scripted pi-ai provider behind `Models`, and a scripted effect/ai `LanguageModel`.

export {
	type FauxResponseFactory,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai";
export {
	ScriptedLanguageModel,
	type ScriptedLanguageModelService,
	type ScriptedResponse,
} from "./scripted-language-model.ts";
export { ScriptedModels, type ScriptedModelsService } from "./scripted-models.ts";
