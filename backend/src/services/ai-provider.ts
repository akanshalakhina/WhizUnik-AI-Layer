import type { AppConfig } from '../config';
import type { AiProvider } from './ai-provider.types';
import { LocalProvider } from './ai-provider.local';
import { OpenAiProvider } from './ai-provider.openai';

export function createProvider(cfg: AppConfig, fetchImpl?: typeof fetch): AiProvider {
  const models = { fast: cfg.ai.modelFast, strong: cfg.ai.modelStrong };
  if (cfg.ai.provider === 'openai') {
    return new OpenAiProvider(
      {
        apiKey: cfg.ai.openaiApiKey,
        baseUrl: cfg.ai.openaiBaseUrl,
        modelFast: cfg.ai.modelFast,
        modelStrong: cfg.ai.modelStrong,
      },
      fetchImpl,
    );
  }
  return new LocalProvider(models);
}
