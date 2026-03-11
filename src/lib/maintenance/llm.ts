import {
  listConfig
} from '../config-manager.js';
import {
  requestLlmCompletion,
  resolveLlmProvider,
  type LlmProvider
} from '../llm-provider.js';

const VALID_PROVIDERS: LlmProvider[] = ['anthropic', 'openai', 'gemini', 'xai', 'openclaw'];

function asProvider(value: unknown): LlmProvider | null {
  if (typeof value !== 'string') {
    return null;
  }
  return VALID_PROVIDERS.includes(value as LlmProvider) ? value as LlmProvider : null;
}

export interface WorkerLlmClient {
  enabled: boolean;
  provider: LlmProvider | null;
  model: string | null;
  complete: (systemPrompt: string, userPrompt: string) => Promise<string>;
}

export function createWorkerLlmClient(vaultPath: string): WorkerLlmClient {
  if (process.env.CLAWVAULT_NO_LLM) {
    return {
      enabled: false,
      provider: null,
      model: null,
      complete: async () => ''
    };
  }

  let configuredProvider: LlmProvider | null = null;
  let configuredModel: string | null = null;
  try {
    const config = listConfig(vaultPath);
    const observe = (
      config.observe && typeof config.observe === 'object' && !Array.isArray(config.observe)
        ? config.observe
        : {}
    ) as Record<string, unknown>;
    configuredProvider = asProvider(observe.provider);
    if (typeof observe.model === 'string' && observe.model.trim()) {
      configuredModel = observe.model.trim();
    }
  } catch {
    // Missing/invalid config falls back to runtime provider resolution.
  }

  const resolvedProvider = configuredProvider ?? resolveLlmProvider();
  const enabled = !!resolvedProvider;

  return {
    enabled,
    provider: resolvedProvider,
    model: configuredModel,
    complete: async (systemPrompt: string, userPrompt: string): Promise<string> => {
      if (!enabled) {
        return '';
      }
      try {
        return await requestLlmCompletion({
          provider: resolvedProvider,
          model: configuredModel ?? undefined,
          systemPrompt,
          prompt: userPrompt,
          temperature: 0.1,
          maxTokens: 1200
        });
      } catch {
        return '';
      }
    }
  };
}
