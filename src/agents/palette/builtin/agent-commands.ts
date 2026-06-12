/**
 * Built-in agent slash commands.
 *
 * /agent detect  — detect installed agents
 * /agent status  — show running agents
 * /agent install — install an agent
 */

import type { SlashCommand } from '../types';

export function createAgentCommands(): SlashCommand[] {
  return [
    {
      id: 'agent.detect',
      prefix: '/agent detect',
      label: 'Detect Agents',
      description: 'Detect installed agents on the remote host',
      category: 'Agent',
      icon: 'eye',
      async execute() {
        // TODO: integrate with agent detector when available
        console.log('[agent] detecting installed agents');
      },
    },
    {
      id: 'agent.status',
      prefix: '/agent status',
      label: 'Agent Status',
      description: 'Show currently running agents',
      category: 'Agent',
      icon: 'pulse',
      async execute() {
        // TODO: integrate with agent status tracker when available
        console.log('[agent] showing agent status');
      },
    },
    {
      id: 'agent.install',
      prefix: '/agent install',
      label: 'Install Agent',
      description: 'Install an agent by type',
      category: 'Agent',
      icon: 'cloud-download',
      async execute(args?: string) {
        const agentType = args?.trim();
        if (!agentType) {
          console.error('[agent] install requires an agent type');
          return;
        }
        // TODO: integrate with agent installer when available
        console.log(`[agent] installing agent: ${agentType}`);
      },
    },
  ];
}
