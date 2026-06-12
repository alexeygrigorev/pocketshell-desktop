/**
 * Built-in configuration slash commands.
 *
 * /config set   — set a configuration key-value pair
 * /config get   — get a configuration value
 * /config reset — reset configuration to defaults
 */

import type { SlashCommand } from '../types';

export function createConfigCommands(): SlashCommand[] {
  return [
    {
      id: 'config.set',
      prefix: '/config set',
      label: 'Set Config',
      description: 'Set a configuration key and value',
      category: 'Config',
      icon: 'settings-edit',
      async execute(args?: string) {
        const parts = args?.trim().split(/\s+/);
        if (!parts || parts.length < 2) {
          console.error('[config] set requires <key> <value>');
          return;
        }
        const [key, ...valueParts] = parts;
        const value = valueParts.join(' ');
        // TODO: integrate with config store when available
        console.log(`[config] setting ${key} = ${value}`);
      },
    },
    {
      id: 'config.get',
      prefix: '/config get',
      label: 'Get Config',
      description: 'Get a configuration value by key',
      category: 'Config',
      icon: 'settings',
      async execute(args?: string) {
        const key = args?.trim();
        if (!key) {
          console.error('[config] get requires a key');
          return;
        }
        // TODO: integrate with config store when available
        console.log(`[config] getting config: ${key}`);
      },
    },
    {
      id: 'config.reset',
      prefix: '/config reset',
      label: 'Reset Config',
      description: 'Reset all configuration to defaults',
      category: 'Config',
      icon: 'clear-all',
      async execute() {
        // TODO: integrate with config store when available
        console.log('[config] resetting to defaults');
      },
    },
  ];
}
