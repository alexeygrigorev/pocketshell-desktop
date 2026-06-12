/**
 * Barrel export for all built-in slash commands.
 */

import type { SlashCommand } from '../types';
import { createSessionCommands } from './session-commands';
import { createAgentCommands } from './agent-commands';
import { createConfigCommands } from './config-commands';

export { createSessionCommands } from './session-commands';
export { createAgentCommands } from './agent-commands';
export { createConfigCommands } from './config-commands';

/**
 * Return all built-in slash commands.
 */
export function createBuiltinCommands(): SlashCommand[] {
  return [
    ...createSessionCommands(),
    ...createAgentCommands(),
    ...createConfigCommands(),
  ];
}
