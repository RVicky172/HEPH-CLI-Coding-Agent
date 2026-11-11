import { LLMError } from '../core/errors/LLMError.js';
import type { ResolvedProfile } from '../config/ConfigLoader.js';
import type { LLMProvider } from './LLMProvider.js';
import { OpenAICompatibleProvider } from './openai-compatible/OpenAICompatibleProvider.js';

/**
 * Turns a config profile into a provider. Today every profile is
 * OpenAI-compatible. A future `"type": "anthropic"` profile would add one
 * case here and a new class, leaving everything else untouched (Open/Closed).
 */
export function createProvider(profile: ResolvedProfile): LLMProvider {
  return new OpenAICompatibleProvider({
    name: profile.name,
    baseURL: profile.baseURL,
    apiKey: profile.apiKey,
    timeoutMs: profile.timeoutMs,
  });
}

/** Model ids that are clearly not chat models (LM Studio lists embedding models too). */
const NON_CHAT_MODEL = /embed|embedding|rerank|whisper|tts/i;

/**
 * `"model": "auto"` picks the first chat model the server offers. That's handy
 * with LM Studio, where the id depends on what you downloaded.
 */
export async function resolveModel(
  provider: LLMProvider,
  requested: string,
  signal?: AbortSignal,
): Promise<string> {
  if (requested !== 'auto') return requested;

  const models = await provider.listModels(signal);
  return pickChatModel(provider, models);
}

/**
 * Returns a warning when an explicitly requested model isn't offered by the server.
 * Why: LM Studio does NOT fail on an unknown model id. It silently answers with
 * whatever model is loaded, so the banner would lie about which model you're using.
 * Returns undefined when the model is listed, or when the server can't list models.
 */
export async function unlistedModelWarning(
  provider: LLMProvider,
  model: string,
): Promise<string | undefined> {
  if (model === 'auto') return undefined;
  const models = await provider.listModels().catch(() => undefined);
  if (!models || models.length === 0 || models.includes(model)) return undefined;
  return (
    `Model "${model}" is not listed by "${provider.name}". Some servers (like LM Studio) then ` +
    `silently use another model. Run \`heph models\` to see the available ids.`
  );
}

function pickChatModel(provider: LLMProvider, models: readonly string[]): string {
  const chatModel = models.find((id) => !NON_CHAT_MODEL.test(id));
  if (!chatModel) {
    throw new LLMError(
      'no_models',
      `No chat model is available on "${provider.name}".`,
      models.length
        ? `Only non-chat models found (${models.join(', ')}). Download/load a chat model in LM Studio.`
        : 'Load a model in LM Studio (Developer tab), or run: lms load <model>',
    );
  }
  return chatModel;
}
