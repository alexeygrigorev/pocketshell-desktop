/**
 * Unit tests for the SlashCommandPalette.
 */

import { describe, it, expect, vi } from 'vitest';
import { SlashCommandPalette } from '../../../../src/agents/palette/command-palette';
import type { SlashCommand } from '../../../../src/agents/palette/types';

function makeCommand(overrides: Partial<SlashCommand> = {}): SlashCommand {
  return {
    id: 'test.cmd',
    prefix: '/test',
    label: 'Test Command',
    description: 'A test command',
    category: 'Test',
    execute: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('SlashCommandPalette', () => {
  describe('register / unregister', () => {
    it('registers commands via constructor', () => {
      const cmd = makeCommand();
      const palette = new SlashCommandPalette([cmd]);
      expect(palette.listAll()).toHaveLength(1);
      expect(palette.listAll()[0].id).toBe('test.cmd');
    });

    it('registers commands via register()', () => {
      const palette = new SlashCommandPalette();
      const cmd = makeCommand();
      palette.register(cmd);
      expect(palette.listAll()).toHaveLength(1);
    });

    it('overwrites when registering a command with a duplicate id', () => {
      const cmd1 = makeCommand({ label: 'First' });
      const cmd2 = makeCommand({ label: 'Second' });
      const palette = new SlashCommandPalette([cmd1]);
      palette.register(cmd2);
      expect(palette.listAll()).toHaveLength(1);
      expect(palette.listAll()[0].label).toBe('Second');
    });

    it('unregisters a command by id', () => {
      const cmd = makeCommand();
      const palette = new SlashCommandPalette([cmd]);
      palette.unregister('test.cmd');
      expect(palette.listAll()).toHaveLength(0);
    });

    it('unregister is a no-op for unknown id', () => {
      const palette = new SlashCommandPalette();
      expect(() => palette.unregister('nonexistent')).not.toThrow();
    });
  });

  describe('search', () => {
    it('returns all commands for empty query', () => {
      const commands = [
        makeCommand({ id: 'a', prefix: '/aaa', label: 'AAA' }),
        makeCommand({ id: 'b', prefix: '/bbb', label: 'BBB' }),
        makeCommand({ id: 'c', prefix: '/ccc', label: 'CCC' }),
      ];
      const palette = new SlashCommandPalette(commands);
      const results = palette.search('');
      expect(results).toHaveLength(3);
    });

    it('returns matching commands', () => {
      const commands = [
        makeCommand({ id: 'session', prefix: '/session list', label: 'List Sessions', description: 'List agent sessions' }),
        makeCommand({ id: 'agent', prefix: '/agent detect', label: 'Detect Agents', description: 'Detect installed agents' }),
        makeCommand({ id: 'config', prefix: '/config set', label: 'Set Config', description: 'Set a config value' }),
      ];
      const palette = new SlashCommandPalette(commands);

      const results = palette.search('session');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].command.id).toBe('session');
    });

    it('ranks results by match quality', () => {
      const commands = [
        // This should rank lower — 'ses' appears later in the text
        makeCommand({ id: 'low', prefix: '/agent assess', label: 'Assess Agent', description: 'Assess agent status' }),
        // This should rank highest — prefix starts with 'ses'
        makeCommand({ id: 'high', prefix: '/session list', label: 'List Sessions', description: 'List all sessions' }),
        // This should rank in the middle
        makeCommand({ id: 'mid', prefix: '/config session', label: 'Session Config', description: 'Configure sessions' }),
      ];
      const palette = new SlashCommandPalette(commands);

      const results = palette.search('ses');
      expect(results.length).toBeGreaterThanOrEqual(2);
      // The 'session list' command should rank highest
      const ids = results.map((r) => r.command.id);
      expect(ids.indexOf('high')).toBeLessThan(ids.indexOf('low'));
    });

    it('returns empty array when nothing matches', () => {
      const commands = [
        makeCommand({ id: 'a', prefix: '/aaa', label: 'AAA', description: 'A command' }),
      ];
      const palette = new SlashCommandPalette(commands);
      const results = palette.search('zzzzz');
      expect(results).toHaveLength(0);
    });

    it('matches against description', () => {
      const commands = [
        makeCommand({
          id: 'test',
          prefix: '/foo bar',
          label: 'Foo Bar',
          description: 'Manage agent sessions on remote host',
        }),
      ];
      const palette = new SlashCommandPalette(commands);
      const results = palette.search('remote');
      expect(results).toHaveLength(1);
      expect(results[0].command.id).toBe('test');
    });
  });

  describe('executeSelected', () => {
    it('executes the command at the given index', async () => {
      const execute = vi.fn().mockResolvedValue(undefined);
      const cmd = makeCommand({ execute });
      const palette = new SlashCommandPalette([cmd]);
      const results = palette.search('');

      await palette.executeSelected(results, 0, 'arg1');

      expect(execute).toHaveBeenCalledWith('arg1');
    });

    it('throws on out-of-bounds index', async () => {
      const palette = new SlashCommandPalette([makeCommand()]);
      const results = palette.search('');

      await expect(palette.executeSelected(results, 5)).rejects.toThrow(
        'Invalid selection index',
      );
      await expect(palette.executeSelected(results, -1)).rejects.toThrow(
        'Invalid selection index',
      );
    });

    it('throws on empty results', async () => {
      const palette = new SlashCommandPalette();
      const results = palette.search('nonexistent');

      await expect(palette.executeSelected(results, 0)).rejects.toThrow(
        'Invalid selection index',
      );
    });
  });
});
