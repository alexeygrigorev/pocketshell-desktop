/**
 * Schema for the dedicated PocketShell settings view.
 *
 * Pure data — no I/O, no vscode. Lists every setting surfaced in the view,
 * its type, default, and validation bounds. This is the single source of
 * truth for what the view renders and what the model validates.
 *
 * The chosen setting set reflects real PocketShell behavior surfaces:
 *   - terminal: default shell + scrollback lines
 *   - tmux: auto-attach + session name prefix
 *   - cli: minimum required PocketShell CLI version (install/upgrade gating)
 *   - connection: connect timeout
 *   - diagnostics: local capture toggle
 */

import type { SettingDefinition, SettingCategory } from './types';

/**
 * Ordered list of setting definitions.
 *
 * Order within a category is preserved by the view renderer.
 */
export const POCKETSHELL_SETTINGS: SettingDefinition[] = [
  // -------------------------------------------------------------------------
  // Terminal
  // -------------------------------------------------------------------------
  {
    key: 'terminal.defaultShell',
    label: 'Default shell',
    description:
      'Shell launched in new remote terminals when the host does not pin one (e.g. /bin/bash).',
    type: 'string',
    category: 'terminal',
    defaultValue: '',
  },
  {
    key: 'terminal.scrollback',
    label: 'Terminal scrollback (lines)',
    description: 'Number of lines retained in the terminal scrollback buffer.',
    type: 'number',
    category: 'terminal',
    defaultValue: 10000,
    min: 0,
    max: 1_000_000,
  },

  // -------------------------------------------------------------------------
  // tmux
  // -------------------------------------------------------------------------
  {
    key: 'tmux.autoAttach',
    label: 'Auto-attach to sessions',
    description:
      'When creating a terminal on a host with tmux, automatically attach to the last session instead of opening a bare shell.',
    type: 'boolean',
    category: 'tmux',
    defaultValue: true,
  },
  {
    key: 'tmux.sessionPrefix',
    label: 'Session name prefix',
    description: 'Prefix applied to PocketShell-created tmux session names.',
    type: 'string',
    category: 'tmux',
    defaultValue: 'psh-',
  },

  // -------------------------------------------------------------------------
  // CLI
  // -------------------------------------------------------------------------
  {
    key: 'cli.minVersion',
    label: 'Minimum CLI version',
    description:
      'Lowest PocketShell CLI version treated as compatible. Hosts running older versions are flagged for upgrade.',
    type: 'string',
    category: 'cli',
    defaultValue: '0.1.0',
  },

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------
  {
    key: 'connection.connectTimeoutMs',
    label: 'Connect timeout (ms)',
    description: 'Milliseconds to wait for an SSH connection before failing.',
    type: 'number',
    category: 'connection',
    defaultValue: 15000,
    min: 1000,
    max: 300_000,
  },

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------
  {
    key: 'diagnostics.capture',
    label: 'Capture diagnostic events',
    description: 'Record local diagnostic events for the PocketShell report.',
    type: 'boolean',
    category: 'diagnostics',
    defaultValue: true,
  },
];

/** Category display order used by the view renderer. */
export const CATEGORY_ORDER: SettingCategory[] = [
  'terminal',
  'tmux',
  'cli',
  'connection',
  'diagnostics',
];

/** Human-readable titles per category. */
export const CATEGORY_TITLES: Record<SettingCategory, string> = {
  terminal: 'Terminal',
  tmux: 'tmux',
  cli: 'PocketShell CLI',
  connection: 'Connection',
  diagnostics: 'Diagnostics',
};

/** Look up a definition by key. Returns undefined when unknown. */
export function getSettingDefinition(key: string): SettingDefinition | undefined {
  return POCKETSHELL_SETTINGS.find((s) => s.key === key);
}
