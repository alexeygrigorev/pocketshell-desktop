/**
 * Unit tests for the conversation open-for-session argument parser (#106).
 *
 * `resolveSessionRefArgs` parses the `{hostId, agentType, sessionId}` argument
 * that the surface layer passes to `pocketshell.conversation.openForSession`
 * when opening a per-session Conversation tab from the canonical session tree.
 * It accepts a plain object (or a canonical-tree node carrying those fields) and
 * returns undefined for a malformed arg so the surface layer can fall back
 * gracefully rather than throwing.
 */
import { describe, expect, it, vi } from 'vitest';
import { resolveSessionRefArgs, resolveViewColumnArg } from '../../../../extensions/pocketshell/src/feature/conversation/conversation-commands';
import { AgentType } from '../../../../src/agents/types';

vi.mock('vscode', () => ({
  commands: {},
  env: { clipboard: { writeText: vi.fn() } },
  l10n: { t: (message: string, ...args: string[]) => args.reduce((text, arg, index) => text.replace(`{${index}}`, arg), message) },
  // Real VS Code enum values: Active=-1, Beside=-2, One=1..Nine=9.
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
  window: {
    createWebviewPanel: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
}));

describe('resolveSessionRefArgs', () => {
  it('parses a complete {hostId, agentType, sessionId} object', () => {
    expect(resolveSessionRefArgs({ hostId: 7, agentType: AgentType.Claude, sessionId: 'abc-123' }))
      .toEqual({ hostId: 7, agentType: AgentType.Claude, sessionId: 'abc-123' });
  });

  it('parses when extra fields (e.g. viewColumn, label) are present', () => {
    expect(resolveSessionRefArgs({
      hostId: 1,
      agentType: AgentType.Codex,
      sessionId: 's',
      viewColumn: 2,
      label: 'codex: s',
      panelKey: '1:codex:s',
    })).toEqual({ hostId: 1, agentType: AgentType.Codex, sessionId: 's' });
  });

  it('returns undefined when hostId is missing or non-number', () => {
    expect(resolveSessionRefArgs({ agentType: AgentType.Claude, sessionId: 's' })).toBeUndefined();
    expect(resolveSessionRefArgs({ hostId: '1', agentType: AgentType.Claude, sessionId: 's' })).toBeUndefined();
  });

  it('returns undefined when agentType is missing or non-string', () => {
    expect(resolveSessionRefArgs({ hostId: 1, sessionId: 's' })).toBeUndefined();
    expect(resolveSessionRefArgs({ hostId: 1, agentType: 5, sessionId: 's' })).toBeUndefined();
  });

  it('returns undefined when sessionId is missing or non-string', () => {
    expect(resolveSessionRefArgs({ hostId: 1, agentType: AgentType.Claude })).toBeUndefined();
    expect(resolveSessionRefArgs({ hostId: 1, agentType: AgentType.Claude, sessionId: 9 })).toBeUndefined();
  });

  it('returns undefined for non-object args (no throw)', () => {
    expect(resolveSessionRefArgs(undefined)).toBeUndefined();
    expect(resolveSessionRefArgs(null)).toBeUndefined();
    expect(resolveSessionRefArgs('not-an-object')).toBeUndefined();
    expect(resolveSessionRefArgs(7)).toBeUndefined();
  });
});

describe('resolveViewColumnArg', () => {
  it('accepts the symbolic ViewColumn.Beside (-2) so the controller can open beside without yanking (#106)', () => {
    // This is the critical case: the conversation-default controller passes
    // ViewColumn.Beside (-2). A buggy range check (>= Active) would reject it.
    expect(resolveViewColumnArg({ viewColumn: -2 })).toBe(-2);
    expect(resolveViewColumnArg({ viewColumn: 1 })).toBe(1);
    // vscode.ViewColumn values are compared by numeric value from the mock.
  });

  it('accepts symbolic Active (-1) and concrete One..Nine (1..9)', () => {
    expect(resolveViewColumnArg({ viewColumn: -1 })).toBe(-1);
    expect(resolveViewColumnArg({ viewColumn: 1 })).toBe(1);
    expect(resolveViewColumnArg({ viewColumn: 9 })).toBe(9);
  });

  it('rejects out-of-range and non-number values (falls back to Active)', () => {
    expect(resolveViewColumnArg({ viewColumn: 0 })).toBeUndefined();
    expect(resolveViewColumnArg({ viewColumn: 10 })).toBeUndefined();
    expect(resolveViewColumnArg({ viewColumn: -3 })).toBeUndefined();
    expect(resolveViewColumnArg({ viewColumn: '1' })).toBeUndefined();
    expect(resolveViewColumnArg({})).toBeUndefined();
    expect(resolveViewColumnArg(undefined)).toBeUndefined();
  });

  it('ignores the viewColumn when the arg is not an object', () => {
    expect(resolveViewColumnArg(7)).toBeUndefined();
    expect(resolveViewColumnArg('x')).toBeUndefined();
  });
});

