/**
 * Built-in session slash commands.
 *
 * /session list   — list agent sessions
 * /session new    — start new agent session
 * /session resume — resume a session
 * /session kill   — kill a session
 */

import type { SlashCommand } from '../types';

export function createSessionCommands(): SlashCommand[] {
  return [
    {
      id: 'session.list',
      prefix: '/session list',
      label: 'List Sessions',
      description: 'List all agent sessions',
      category: 'Session',
      icon: 'list-tree',
      async execute() {
        // TODO: integrate with session manager when available
        console.log('[session] listing sessions');
      },
    },
    {
      id: 'session.new',
      prefix: '/session new',
      label: 'New Session',
      description: 'Start a new agent session',
      category: 'Session',
      icon: 'add',
      async execute() {
        // TODO: integrate with session manager when available
        console.log('[session] starting new session');
      },
    },
    {
      id: 'session.resume',
      prefix: '/session resume',
      label: 'Resume Session',
      description: 'Resume an existing session by ID',
      category: 'Session',
      icon: 'debug-continue',
      async execute(args?: string) {
        const sessionId = args?.trim();
        if (!sessionId) {
          console.error('[session] resume requires a session ID');
          return;
        }
        // TODO: integrate with session manager when available
        console.log(`[session] resuming session: ${sessionId}`);
      },
    },
    {
      id: 'session.kill',
      prefix: '/session kill',
      label: 'Kill Session',
      description: 'Kill a running session by ID',
      category: 'Session',
      icon: 'trash',
      async execute(args?: string) {
        const sessionId = args?.trim();
        if (!sessionId) {
          console.error('[session] kill requires a session ID');
          return;
        }
        // TODO: integrate with session manager when available
        console.log(`[session] killing session: ${sessionId}`);
      },
    },
  ];
}
