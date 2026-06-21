/**
 * Settings schema for PocketShell Desktop.
 *
 * Defines every configurable option with its type, default value,
 * validation rules, and display metadata.  Pure data — no DOM, no store.
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type SettingType = 'boolean' | 'number' | 'string' | 'enum';
export type SettingValue = boolean | number | string | null;

export type SettingCategory =
  | 'connection'
  | 'terminal'
  | 'tmux'
  | 'agent'
  | 'usage'
  | 'helper'
  | 'diagnostics'
  | 'utility'
  | 'assistant';

export interface ValidationRule {
  /** Human-readable error message when the rule fails. */
  message: string;
  /** For numbers: minimum value (inclusive). */
  min?: number;
  /** For numbers: maximum value (inclusive). */
  max?: number;
  /** For strings: regex pattern the value must match. */
  pattern?: string;
  /** For strings/numbers: minimum length (strings) or minimum value (numbers). */
  minLength?: number;
  /** For strings: maximum length. */
  maxLength?: number;
}

export interface SettingDefinition {
  /** Unique key matching the flat key used in the settings map. */
  key: string;
  /** Human-readable label shown in the UI. */
  label: string;
  /** Short description / tooltip text. */
  description: string;
  /** Value type. */
  type: SettingType;
  /** Category grouping. */
  category: SettingCategory;
  /** Default value. */
  defaultValue: SettingValue;
  /** Allowed values when type is 'enum'. */
  enumValues?: string[];
  /** Whether null is an accepted value. */
  nullable?: boolean;
  /** Validation rules (empty array means no extra validation). */
  validation: ValidationRule[];
}

// ---------------------------------------------------------------------------
// Schema definitions
// ---------------------------------------------------------------------------

const connectionSettings: SettingDefinition[] = [
  {
    key: 'autoConnect',
    label: 'Auto-connect on startup',
    description: 'Automatically connect to the last-used host when the app starts.',
    type: 'boolean',
    category: 'connection',
    defaultValue: true,
    validation: [],
  },
  {
    key: 'lastHostId',
    label: 'Last host',
    description: 'ID of the most recently connected host, used as a startup hint.',
    type: 'number',
    category: 'connection',
    defaultValue: null,
    nullable: true,
    validation: [
      { message: 'lastHostId must be a non-negative integer', min: 0 },
    ],
  },
  {
    key: 'reconnectMaxAttempts',
    label: 'Max reconnect attempts',
    description: 'Maximum number of automatic reconnection attempts before giving up.',
    type: 'number',
    category: 'connection',
    defaultValue: 5,
    validation: [
      { message: 'Must be between 0 and 100', min: 0, max: 100 },
    ],
  },
  {
    key: 'restoreSessionOnStartup',
    label: 'Restore last session',
    description: 'Restore the previous PocketShell session layout when the app starts.',
    type: 'boolean',
    category: 'connection',
    defaultValue: true,
    validation: [],
  },
  {
    key: 'sessionRestoreBehavior',
    label: 'Session restore behavior',
    description: 'How startup restore should handle missing or disconnected session hosts.',
    type: 'enum',
    category: 'connection',
    defaultValue: 'ask',
    enumValues: ['ask', 'restore-ready', 'skip'],
    validation: [],
  },
  {
    key: 'portForwardRestoreActiveTunnels',
    label: 'Restore active port forwards',
    description: 'Restore selected active port forwards after startup or reconnect.',
    type: 'boolean',
    category: 'connection',
    defaultValue: true,
    validation: [],
  },
];

const terminalSettings: SettingDefinition[] = [
  {
    key: 'fontSize',
    label: 'Font size',
    description: 'Terminal font size in pixels.',
    type: 'number',
    category: 'terminal',
    defaultValue: 14,
    validation: [
      { message: 'Font size must be between 6 and 72', min: 6, max: 72 },
    ],
  },
  {
    key: 'scrollback',
    label: 'Scrollback lines',
    description: 'Number of lines kept in the terminal scrollback buffer.',
    type: 'number',
    category: 'terminal',
    defaultValue: 10000,
    validation: [
      { message: 'Scrollback must be between 100 and 1 000 000', min: 100, max: 1_000_000 },
    ],
  },
  {
    key: 'shell',
    label: 'Shell path',
    description: 'Absolute path to the shell binary to launch on the remote host.',
    type: 'string',
    category: 'terminal',
    defaultValue: '/bin/bash',
    validation: [
      { message: 'Shell path must start with /', pattern: '^/' },
    ],
  },
  {
    key: 'cursorStyle',
    label: 'Cursor style',
    description: 'Terminal cursor appearance.',
    type: 'enum',
    category: 'terminal',
    defaultValue: 'block',
    enumValues: ['block', 'underline', 'bar'],
    validation: [],
  },
  {
    key: 'theme',
    label: 'Theme',
    description: 'Application color theme.',
    type: 'enum',
    category: 'terminal',
    defaultValue: 'dark',
    enumValues: ['dark', 'light', 'system'],
    validation: [],
  },
];

const tmuxSettings: SettingDefinition[] = [
  {
    key: 'tmuxDefaultSessionName',
    label: 'Default tmux session',
    description: 'Session name to use when creating or attaching to tmux by default.',
    type: 'string',
    category: 'tmux',
    defaultValue: 'pocketshell',
    validation: [
      { message: 'Default tmux session name cannot be empty', minLength: 1 },
      { message: 'Default tmux session name must be at most 64 characters', maxLength: 64 },
    ],
  },
  {
    key: 'tmuxAttachBehavior',
    label: 'tmux attach behavior',
    description: 'Whether PocketShell should attach to an existing session or create one.',
    type: 'enum',
    category: 'tmux',
    defaultValue: 'attach-or-create',
    enumValues: ['attach-or-create', 'attach-existing', 'create-new'],
    validation: [],
  },
  {
    key: 'tmuxDefaultWindowName',
    label: 'Default tmux window',
    description: 'Window name to use for newly created tmux sessions.',
    type: 'string',
    category: 'tmux',
    defaultValue: 'shell',
    validation: [
      { message: 'Default tmux window name cannot be empty', minLength: 1 },
      { message: 'Default tmux window name must be at most 64 characters', maxLength: 64 },
    ],
  },
  {
    key: 'tmuxDefaultPaneSplit',
    label: 'Default pane split',
    description: 'Initial pane layout for new tmux sessions.',
    type: 'enum',
    category: 'tmux',
    defaultValue: 'none',
    enumValues: ['none', 'horizontal', 'vertical'],
    validation: [],
  },
];

const agentSettings: SettingDefinition[] = [
  {
    key: 'detectionInterval',
    label: 'Agent detection interval (ms)',
    description: 'How often (in ms) to poll for agent activity in tmux sessions.',
    type: 'number',
    category: 'agent',
    defaultValue: 5000,
    validation: [
      { message: 'Detection interval must be between 500 and 60 000 ms', min: 500, max: 60_000 },
    ],
  },
  {
    key: 'conversationAutoTail',
    label: 'Auto-tail conversations',
    description: 'Automatically scroll to the latest agent conversation output.',
    type: 'boolean',
    category: 'agent',
    defaultValue: true,
    validation: [],
  },
  {
    key: 'maxConversations',
    label: 'Max conversations',
    description: 'Maximum number of concurrent agent conversations to track.',
    type: 'number',
    category: 'agent',
    defaultValue: 10,
    validation: [
      { message: 'Must be between 1 and 100', min: 1, max: 100 },
    ],
  },
  {
    key: 'promptComposerDictationProvider',
    label: 'Prompt composer dictation',
    description: 'Optional transcription provider for inserting dictated text into prompt composer drafts.',
    type: 'enum',
    category: 'agent',
    defaultValue: 'none',
    enumValues: ['none', 'local', 'system', 'openai'],
    validation: [],
  },
  {
    key: 'promptComposerDictationCommand',
    label: 'Dictation command',
    description: 'Shell command used by local or system prompt composer dictation providers. Stdout is inserted as transcript text.',
    type: 'string',
    category: 'agent',
    defaultValue: '',
    validation: [
      { message: 'Dictation command must be at most 1024 characters', maxLength: 1024 },
    ],
  },
  {
    key: 'promptComposerDictationOpenAiApiKey',
    label: 'OpenAI dictation API key',
    description: 'Optional API key used only when prompt composer dictation provider is set to OpenAI. OPENAI_API_KEY is also supported.',
    type: 'string',
    category: 'agent',
    defaultValue: '',
    validation: [
      { message: 'OpenAI dictation API key must be at most 4096 characters', maxLength: 4096 },
    ],
  },
  {
    key: 'promptComposerDictationOpenAiModel',
    label: 'OpenAI dictation model',
    description: 'OpenAI audio transcription model for prompt composer dictation.',
    type: 'string',
    category: 'agent',
    defaultValue: 'whisper-1',
    validation: [
      { message: 'OpenAI dictation model cannot be empty', minLength: 1 },
      { message: 'OpenAI dictation model must be at most 128 characters', maxLength: 128 },
    ],
  },
  {
    key: 'promptComposerDictationLanguage',
    label: 'Dictation language',
    description: 'Optional language hint for prompt composer dictation transcription.',
    type: 'string',
    category: 'agent',
    defaultValue: '',
    validation: [
      { message: 'Dictation language must be at most 32 characters', maxLength: 32 },
    ],
  },
];

const usageSettings: SettingDefinition[] = [
  {
    key: 'usageEnabled',
    label: 'Usage collection',
    description: 'Collect and display remote CPU, memory, disk, and provider usage.',
    type: 'boolean',
    category: 'usage',
    defaultValue: true,
    validation: [],
  },
  {
    key: 'usageRefreshInterval',
    label: 'Usage refresh interval (ms)',
    description: 'How often (in ms) to refresh server resource usage stats.',
    type: 'number',
    category: 'usage',
    defaultValue: 60000,
    validation: [
      { message: 'Must be between 5000 and 3 600 000 ms', min: 5000, max: 3_600_000 },
    ],
  },
  {
    key: 'usageProviderBreakdown',
    label: 'Provider usage breakdown',
    description: 'Show usage grouped by detected agent or provider when available.',
    type: 'boolean',
    category: 'usage',
    defaultValue: true,
    validation: [],
  },
  {
    key: 'usageHistoryLimit',
    label: 'Usage history limit',
    description: 'Maximum number of usage snapshots retained in memory.',
    type: 'number',
    category: 'usage',
    defaultValue: 1000,
    validation: [
      { message: 'Must be between 10 and 100 000', min: 10, max: 100_000 },
    ],
  },
];

const helperSettings: SettingDefinition[] = [
  {
    key: 'helperCommand',
    label: 'Helper command',
    description: 'Command used to invoke the remote PocketShell helper.',
    type: 'string',
    category: 'helper',
    defaultValue: 'pocketshell',
    validation: [
      { message: 'Helper command cannot be empty', minLength: 1 },
      { message: 'Helper command must be at most 256 characters', maxLength: 256 },
    ],
  },
  {
    key: 'helperVersion',
    label: 'Helper script version',
    description: 'Version string of the remote helper script to deploy / expect.',
    type: 'string',
    category: 'helper',
    defaultValue: '',
    validation: [],
  },
  {
    key: 'helperInstallMode',
    label: 'Helper install mode',
    description: 'How PocketShell should handle remote helper installation and upgrades.',
    type: 'enum',
    category: 'helper',
    defaultValue: 'auto',
    enumValues: ['auto', 'prompt', 'never'],
    validation: [],
  },
];

const diagnosticsSettings: SettingDefinition[] = [
  {
    key: 'diagnosticsEnabled',
    label: 'Diagnostics',
    description: 'Capture PocketShell diagnostic events for troubleshooting.',
    type: 'boolean',
    category: 'diagnostics',
    defaultValue: true,
    validation: [],
  },
  {
    key: 'diagnosticsMaxEvents',
    label: 'Max diagnostic events',
    description: 'Maximum number of diagnostic events retained in memory.',
    type: 'number',
    category: 'diagnostics',
    defaultValue: 500,
    validation: [
      { message: 'Must be between 0 and 100 000', min: 0, max: 100_000 },
    ],
  },
  {
    key: 'diagnosticsRedactionMode',
    label: 'Diagnostics redaction',
    description: 'How aggressively diagnostics should redact paths, hostnames, and command arguments.',
    type: 'enum',
    category: 'diagnostics',
    defaultValue: 'balanced',
    enumValues: ['strict', 'balanced', 'off'],
    validation: [],
  },
];

const utilitySettings: SettingDefinition[] = [
  {
    key: 'logMaxLines',
    label: 'Max log lines',
    description: 'Maximum number of lines retained in the in-memory log buffer.',
    type: 'number',
    category: 'utility',
    defaultValue: 5000,
    validation: [
      { message: 'Must be between 100 and 1 000 000', min: 100, max: 1_000_000 },
    ],
  },
  {
    key: 'outputMaxLines',
    label: 'Max output lines',
    description: 'Maximum number of lines retained in command output channels.',
    type: 'number',
    category: 'utility',
    defaultValue: 10000,
    validation: [
      { message: 'Must be between 100 and 1 000 000', min: 100, max: 1_000_000 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Assistant (action-assistant) settings. Display-safe, non-secret fields only.
 * The API key is stored separately in `vscode.SecretStorage` (NOT here) —
 * deliberately NOT repeating the dictation key's plaintext-settings weakness.
 * The defaults mirror `src/assistant/llm-types.ts` (kept in sync by hand — the
 * settings view is feature-layer, the pure module is mirrored).
 */
const assistantSettings: SettingDefinition[] = [
  {
    key: 'assistantProvider',
    label: 'Assistant provider',
    description: 'LLM provider the in-app action assistant talks to. Dispatch 1 ships OpenAI only.',
    type: 'enum',
    category: 'assistant',
    defaultValue: 'openai',
    enumValues: ['openai', 'anthropic', 'zai'],
    validation: [],
  },
  {
    key: 'assistantOpenAiBaseUrl',
    label: 'OpenAI base URL',
    description: 'Base URL for the OpenAI Chat Completions API (or an OpenAI-compatible gateway).',
    type: 'string',
    category: 'assistant',
    defaultValue: 'https://api.openai.com/v1',
    validation: [
      { message: 'OpenAI base URL cannot be empty', minLength: 1 },
      { message: 'OpenAI base URL must be at most 1024 characters', maxLength: 1024 },
    ],
  },
  {
    key: 'assistantOpenAiModel',
    label: 'OpenAI model',
    description: 'OpenAI Chat Completions model id (e.g. gpt-4o).',
    type: 'string',
    category: 'assistant',
    defaultValue: 'gpt-4o',
    validation: [
      { message: 'OpenAI model cannot be empty', minLength: 1 },
      { message: 'OpenAI model must be at most 128 characters', maxLength: 128 },
    ],
  },
  {
    key: 'assistantAnthropicBaseUrl',
    label: 'Anthropic base URL',
    description: 'Base URL for the Anthropic Messages API. Used when provider is anthropic or zai (Dispatch 3).',
    type: 'string',
    category: 'assistant',
    defaultValue: 'https://api.anthropic.com/v1',
    validation: [
      { message: 'Anthropic base URL cannot be empty', minLength: 1 },
      { message: 'Anthropic base URL must be at most 1024 characters', maxLength: 1024 },
    ],
  },
  {
    key: 'assistantAnthropicModel',
    label: 'Anthropic model',
    description: 'Anthropic Messages model id (e.g. claude-3-5-sonnet-latest). Used in Dispatch 3.',
    type: 'string',
    category: 'assistant',
    defaultValue: 'claude-3-5-sonnet-latest',
    validation: [
      { message: 'Anthropic model cannot be empty', minLength: 1 },
      { message: 'Anthropic model must be at most 128 characters', maxLength: 128 },
    ],
  },
];

/** All setting definitions in schema order, grouped by category. */
export const ALL_SETTINGS: SettingDefinition[] = [
  ...connectionSettings,
  ...terminalSettings,
  ...tmuxSettings,
  ...agentSettings,
  ...usageSettings,
  ...helperSettings,
  ...diagnosticsSettings,
  ...utilitySettings,
  ...assistantSettings,
];

/** Map from setting key to its definition for O(1) lookups. */
export const SETTING_MAP: ReadonlyMap<string, SettingDefinition> = new Map(
  ALL_SETTINGS.map((s) => [s.key, s]),
);

/**
 * Return all definitions belonging to a given category.
 */
export function getSettingsByCategory(category: SettingCategory): SettingDefinition[] {
  return ALL_SETTINGS.filter((s) => s.category === category);
}

/**
 * Return the default value map — key → default — for every setting.
 */
export function getDefaultsMap(): Record<string, SettingValue> {
  const map: Record<string, SettingValue> = {};
  for (const s of ALL_SETTINGS) {
    map[s.key] = s.defaultValue;
  }
  return map;
}

/**
 * Validate a value against schema-level type/enum constraints and any
 * definition-specific validation rules.
 */
export function validateSettingValue(def: SettingDefinition, value: unknown): ValidationRule[] {
  const errors: ValidationRule[] = [];

  if (value === null) {
    if (def.nullable) return errors;
    errors.push({ message: `${def.key} must be a ${def.type}` });
    return errors;
  }

  if (value === undefined) {
    return errors;
  }

  if (def.type === 'boolean') {
    if (typeof value !== 'boolean') {
      errors.push({ message: `${def.key} must be a boolean` });
    }
    return errors;
  }

  if (def.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push({ message: `${def.key} must be a number` });
      return errors;
    }
    if (!Number.isInteger(value)) {
      errors.push({ message: `${def.key} must be an integer` });
    }
    for (const rule of def.validation) {
      if (rule.min !== undefined && value < rule.min) errors.push(rule);
      if (rule.max !== undefined && value > rule.max) errors.push(rule);
    }
    return errors;
  }

  if (def.type === 'string') {
    if (typeof value !== 'string') {
      errors.push({ message: `${def.key} must be a string` });
      return errors;
    }
    for (const rule of def.validation) {
      if (rule.pattern && !new RegExp(rule.pattern).test(value)) errors.push(rule);
      if (rule.minLength !== undefined && value.length < rule.minLength) errors.push(rule);
      if (rule.maxLength !== undefined && value.length > rule.maxLength) errors.push(rule);
    }
    return errors;
  }

  if (typeof value !== 'string') {
    errors.push({ message: `${def.key} must be one of: ${(def.enumValues ?? []).join(', ')}` });
    return errors;
  }
  if (!def.enumValues?.includes(value)) {
    errors.push({ message: `${def.key} must be one of: ${def.enumValues?.join(', ')}` });
  }
  return errors;
}

/**
 * Return the ordered list of distinct categories that actually appear in the
 * schema (useful for rendering sections in order).
 */
export function getCategoryOrder(): SettingCategory[] {
  const seen = new Set<SettingCategory>();
  const order: SettingCategory[] = [];
  for (const s of ALL_SETTINGS) {
    if (!seen.has(s.category)) {
      seen.add(s.category);
      order.push(s.category);
    }
  }
  return order;
}
