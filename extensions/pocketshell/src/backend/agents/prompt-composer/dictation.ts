export type PromptComposerDictationProviderId = 'none' | 'local' | 'system' | 'openai';

export interface PromptComposerDictationConfig {
  provider: PromptComposerDictationProviderId;
  command?: string;
  openAiApiKey?: string;
  openAiModel?: string;
  language?: string;
}

export interface PromptComposerDictationRequest {
  audioPath?: string;
  audioData?: Uint8Array;
  fileName?: string;
  mimeType?: string;
}

export interface PromptComposerDictationProvider {
  id: Exclude<PromptComposerDictationProviderId, 'none'>;
  transcribe(request?: PromptComposerDictationRequest): Promise<string>;
}

export interface PromptComposerDictationDeps {
  runCommand?: (command: string, request?: PromptComposerDictationRequest) => Promise<string>;
  transcribeOpenAi?: (request: PromptComposerDictationRequest, config: PromptComposerDictationConfig) => Promise<string>;
}

export interface PromptComposerDictationAvailability {
  enabled: boolean;
  provider: PromptComposerDictationProviderId;
  reason?: string;
}

export const DEFAULT_PROMPT_COMPOSER_DICTATION_CONFIG: PromptComposerDictationConfig = {
  provider: 'none',
  openAiModel: 'whisper-1',
};

export function readPromptComposerDictationConfig(
  settings: Record<string, unknown> | null | undefined,
  env: Record<string, string | undefined> = {},
): PromptComposerDictationConfig {
  const provider = normalizeDictationProvider(settings?.promptComposerDictationProvider);
  const command = stringSetting(settings?.promptComposerDictationCommand);
  const openAiApiKey = stringSetting(settings?.promptComposerDictationOpenAiApiKey)
    ?? stringSetting(env.OPENAI_API_KEY);
  const openAiModel = stringSetting(settings?.promptComposerDictationOpenAiModel)
    ?? DEFAULT_PROMPT_COMPOSER_DICTATION_CONFIG.openAiModel;
  const language = stringSetting(settings?.promptComposerDictationLanguage);
  return {
    provider,
    command,
    openAiApiKey,
    openAiModel,
    language,
  };
}

export function getPromptComposerDictationAvailability(
  config: PromptComposerDictationConfig,
): PromptComposerDictationAvailability {
  if (config.provider === 'none') {
    return { enabled: false, provider: 'none', reason: 'Dictation is not configured.' };
  }
  if ((config.provider === 'local' || config.provider === 'system') && !config.command?.trim()) {
    return {
      enabled: false,
      provider: config.provider,
      reason: 'Dictation command is not configured.',
    };
  }
  if (config.provider === 'openai' && !config.openAiApiKey?.trim()) {
    return {
      enabled: false,
      provider: 'openai',
      reason: 'OpenAI dictation requires an API key.',
    };
  }
  return { enabled: true, provider: config.provider };
}

export function createPromptComposerDictationProvider(
  config: PromptComposerDictationConfig,
  deps: PromptComposerDictationDeps,
): PromptComposerDictationProvider | undefined {
  const availability = getPromptComposerDictationAvailability(config);
  if (!availability.enabled) {
    return undefined;
  }
  if (config.provider === 'local' || config.provider === 'system') {
    return {
      id: config.provider,
      transcribe: async (request) => {
        if (!deps.runCommand) {
          throw new Error('Dictation command runner is not available');
        }
        return normalizeTranscript(await deps.runCommand(config.command ?? '', request));
      },
    };
  }
  if (config.provider === 'openai') {
    return {
      id: 'openai',
      transcribe: async (request) => {
        if (!deps.transcribeOpenAi) {
          throw new Error('OpenAI dictation provider is not available');
        }
        return normalizeTranscript(await deps.transcribeOpenAi(request ?? {}, config));
      },
    };
  }
  return undefined;
}

export function appendPromptComposerTranscript(draft: string, transcript: string): string {
  const trimmedTranscript = normalizeTranscript(transcript);
  if (!trimmedTranscript) {
    return draft;
  }
  const trimmedDraft = draft.trimEnd();
  return trimmedDraft ? `${trimmedDraft}\n\n${trimmedTranscript}\n\n` : `${trimmedTranscript}\n\n`;
}

export function normalizeTranscript(transcript: string): string {
  return transcript.replace(/\r\n/g, '\n').trim();
}

function normalizeDictationProvider(value: unknown): PromptComposerDictationProviderId {
  return value === 'local' || value === 'system' || value === 'openai' ? value : 'none';
}

function stringSetting(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
