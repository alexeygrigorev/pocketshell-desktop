/**
 * Unit tests for built-in slash commands.
 */

import { describe, it, expect } from 'vitest';
import { createBuiltinCommands } from '../../../../src/agents/palette/builtin';
import { createSessionCommands } from '../../../../src/agents/palette/builtin/session-commands';
import { createAgentCommands } from '../../../../src/agents/palette/builtin/agent-commands';
import { createConfigCommands } from '../../../../src/agents/palette/builtin/config-commands';
import type { SlashCommand } from '../../../../src/agents/palette/types';

const REQUIRED_FIELDS: (keyof SlashCommand)[] = [
  'id',
  'prefix',
  'label',
  'description',
  'category',
  'execute',
];

describe('Built-in commands', () => {
  describe('all built-in commands have required fields', () => {
    const allCommands = createBuiltinCommands();

    for (const cmd of allCommands) {
      describe(`command ${cmd.id}`, () => {
        for (const field of REQUIRED_FIELDS) {
          it(`has ${field}`, () => {
            expect(cmd[field]).toBeDefined();
            if (field !== 'execute') {
              expect(typeof cmd[field]).toBe('string');
            } else {
              expect(typeof cmd[field]).toBe('function');
            }
          });
        }

        it('has non-empty id', () => {
          expect(cmd.id.length).toBeGreaterThan(0);
        });

        it('has prefix starting with /', () => {
          expect(cmd.prefix).toMatch(/^\//);
        });
      });
    }
  });

  describe('no duplicate IDs', () => {
    it('has no duplicate IDs across all built-in commands', () => {
      const commands = createBuiltinCommands();
      const ids = commands.map((c) => c.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });

  describe('no duplicate prefixes', () => {
    it('has no duplicate prefixes across all built-in commands', () => {
      const commands = createBuiltinCommands();
      const prefixes = commands.map((c) => c.prefix);
      const uniquePrefixes = new Set(prefixes);
      expect(uniquePrefixes.size).toBe(prefixes.length);
    });
  });

  describe('session commands', () => {
    it('creates exactly 4 session commands', () => {
      const commands = createSessionCommands();
      expect(commands).toHaveLength(4);
    });

    it('all session commands are in Session category', () => {
      const commands = createSessionCommands();
      for (const cmd of commands) {
        expect(cmd.category).toBe('Session');
      }
    });

    it('has expected session command IDs', () => {
      const commands = createSessionCommands();
      const ids = commands.map((c) => c.id).sort();
      expect(ids).toEqual([
        'session.kill',
        'session.list',
        'session.new',
        'session.resume',
      ]);
    });
  });

  describe('agent commands', () => {
    it('creates exactly 3 agent commands', () => {
      const commands = createAgentCommands();
      expect(commands).toHaveLength(3);
    });

    it('all agent commands are in Agent category', () => {
      const commands = createAgentCommands();
      for (const cmd of commands) {
        expect(cmd.category).toBe('Agent');
      }
    });

    it('has expected agent command IDs', () => {
      const commands = createAgentCommands();
      const ids = commands.map((c) => c.id).sort();
      expect(ids).toEqual([
        'agent.detect',
        'agent.install',
        'agent.status',
      ]);
    });
  });

  describe('config commands', () => {
    it('creates exactly 3 config commands', () => {
      const commands = createConfigCommands();
      expect(commands).toHaveLength(3);
    });

    it('all config commands are in Config category', () => {
      const commands = createConfigCommands();
      for (const cmd of commands) {
        expect(cmd.category).toBe('Config');
      }
    });

    it('has expected config command IDs', () => {
      const commands = createConfigCommands();
      const ids = commands.map((c) => c.id).sort();
      expect(ids).toEqual([
        'config.get',
        'config.reset',
        'config.set',
      ]);
    });
  });

  describe('createBuiltinCommands aggregates all', () => {
    it('includes all session, agent, and config commands', () => {
      const all = createBuiltinCommands();
      const session = createSessionCommands();
      const agent = createAgentCommands();
      const config = createConfigCommands();
      expect(all.length).toBe(session.length + agent.length + config.length);
    });
  });
});
