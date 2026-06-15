import { describe, expect, it, vi } from 'vitest';
import { sessionRefFromAttribution } from '../../../../extensions/pocketshell/src/feature/conversation/conversation-commands';
import type { ConversationAttributionResult } from '../../../../src/agents/conversation-attribution';
import { AgentType } from '../../../../src/agents/types';

vi.mock('vscode', () => ({
  commands: {},
  env: { clipboard: { writeText: vi.fn() } },
  l10n: { t: (message: string, ...args: string[]) => args.reduce((text, arg, index) => text.replace(`{${index}}`, arg), message) },
  ViewColumn: { Active: 1 },
  window: {
    createWebviewPanel: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
}));

function attribution(overrides: Partial<ConversationAttributionResult>): ConversationAttributionResult {
  return {
    kind: 'no-match',
    paneKey: '$1:@1:%1',
    dismissed: false,
    shouldShowHint: false,
    fromCache: false,
    candidates: [],
    ...overrides,
  };
}

describe('sessionRefFromAttribution', () => {
  it('returns a session ref only for concrete matches', () => {
    expect(sessionRefFromAttribution(attribution({
      kind: 'match',
      session: {
        id: 'codex-session',
        agentType: AgentType.Codex,
        path: '/tmp/session.jsonl',
        size: 10,
        modifiedAt: 1,
      },
      candidates: [],
    }))).toEqual({ id: 'codex-session', agentType: AgentType.Codex });

    expect(sessionRefFromAttribution(attribution({
      kind: 'ambiguous',
      candidates: [
        {
          id: 'a',
          agentType: AgentType.Codex,
          path: '/tmp/a.jsonl',
          size: 10,
          modifiedAt: 1,
        },
      ],
    }))).toBeUndefined();

    expect(sessionRefFromAttribution(attribution({ kind: 'no-match' }))).toBeUndefined();
    expect(sessionRefFromAttribution(undefined)).toBeUndefined();
  });
});
