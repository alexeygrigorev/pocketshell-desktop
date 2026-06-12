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

export type SettingCategory = 'connection' | 'terminal' | 'agent' | 'utility';

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
  defaultValue: boolean | number | string;
  /** Allowed values when type is 'enum'. */
  enumValues?: string[];
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
    key: 'defaultHostId',
    label: 'Default host',
    description: 'ID of the host to connect to by default (null = use last connected).',
    type: 'number',
    category: 'connection',
    defaultValue: 0,
    validation: [
      { message: 'defaultHostId must be a non-negative integer', min: 0 },
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
];

const utilitySettings: SettingDefinition[] = [
  {
    key: 'helperVersion',
    label: 'Helper script version',
    description: 'Version string of the remote helper script to deploy / expect.',
    type: 'string',
    category: 'utility',
    defaultValue: '',
    validation: [],
  },
  {
    key: 'usageRefreshInterval',
    label: 'Usage refresh interval (ms)',
    description: 'How often (in ms) to refresh server resource usage stats.',
    type: 'number',
    category: 'utility',
    defaultValue: 60000,
    validation: [
      { message: 'Must be between 5000 and 3 600 000 ms', min: 5000, max: 3_600_000 },
    ],
  },
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
];

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** All setting definitions in schema order, grouped by category. */
export const ALL_SETTINGS: SettingDefinition[] = [
  ...connectionSettings,
  ...terminalSettings,
  ...agentSettings,
  ...utilitySettings,
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
export function getDefaultsMap(): Record<string, boolean | number | string> {
  const map: Record<string, boolean | number | string> = {};
  for (const s of ALL_SETTINGS) {
    map[s.key] = s.defaultValue;
  }
  return map;
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
