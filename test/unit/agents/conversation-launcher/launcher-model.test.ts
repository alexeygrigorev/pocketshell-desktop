import { describe, expect, it } from 'vitest';
import {
  applySessionAttribution,
  buildComposerOpenArgs,
  buildConversationOpenElement,
  canLaunch,
  createLauncherPanelModel,
  launcherTitle,
  markOpenFailed,
  markOpenSucceeded,
  markOpeningComposer,
  markOpeningConversation,
  renderLauncherHtml,
  resetLauncherStatus,
  type LauncherPanelModel,
} from '../../../../src/agents/conversation-launcher';

function modelWithSession(overrides: Partial<LauncherPanelModel> = {}): LauncherPanelModel {
  return {
    ...createLauncherPanelModel(),
    session: {
      agentType: 'claude',
      sessionId: 'abc-123',
      label: 'claude: abc-123',
      hostId: 7,
    },
    hasConnection: true,
    ...overrides,
  };
}

describe('createLauncherPanelModel', () => {
  it('starts idle with no session and is not launchable', () => {
    const model = createLauncherPanelModel();
    expect(model.session).toBeUndefined();
    expect(model.ambiguous).toBe(false);
    expect(model.hasConnection).toBe(false);
    expect(model.status.kind).toBe('idle');
    expect(model.revision).toBe(0);
    expect(canLaunch(model)).toBe(false);
    expect(launcherTitle(model)).toBe('No active session');
  });
});

describe('applySessionAttribution', () => {
  it('stores a matching session with a connection and bumps the revision', () => {
    const base = createLauncherPanelModel();
    const model = applySessionAttribution(base, {
      kind: 'match',
      session: { agentType: 'codex', sessionId: 's1', hostId: 3 },
      hasConnection: true,
    });
    expect(model.session).toEqual({ agentType: 'codex', sessionId: 's1', hostId: 3 });
    expect(model.ambiguous).toBe(false);
    expect(model.hasConnection).toBe(true);
    expect(model.status.kind).toBe('idle');
    expect(model.revision).toBe(base.revision + 1);
    expect(canLaunch(model)).toBe(true);
    expect(launcherTitle(model)).toBe('codex: s1');
  });

  it('marks ambiguous attribution without a session', () => {
    const model = applySessionAttribution(modelWithSession(), { kind: 'ambiguous' });
    expect(model.session).toBeUndefined();
    expect(model.ambiguous).toBe(true);
    expect(canLaunch(model)).toBe(false);
    expect(model.status.kind).toBe('ambiguous');
    expect(launcherTitle(model)).toBe('Ambiguous session');
  });

  it('marks no-match attribution without a session', () => {
    const model = applySessionAttribution(modelWithSession(), { kind: 'no-match' });
    expect(model.session).toBeUndefined();
    expect(model.ambiguous).toBe(false);
    expect(model.hasConnection).toBe(false);
    expect(model.status.kind).toBe('no-session');
    expect(launcherTitle(model)).toBe('No active session');
  });

  it('falls back to the session label when present', () => {
    const model = applySessionAttribution(createLauncherPanelModel(), {
      kind: 'match',
      session: { agentType: 'opencode', sessionId: 'zz', label: 'custom label' },
      hasConnection: false,
    });
    expect(launcherTitle(model)).toBe('custom label');
    expect(model.hasConnection).toBe(false);
  });
});

describe('opening transitions', () => {
  it('marks opening-conversation only when a session exists', () => {
    const idle = modelWithSession();
    const opening = markOpeningConversation(idle);
    expect(opening.status.kind).toBe('opening-conversation');
    expect(opening.revision).toBe(idle.revision + 1);
  });

  it('refuses to open the conversation when no session is attributed', () => {
    const model = markOpeningConversation(createLauncherPanelModel());
    expect(model.status.kind).toBe('open-failed');
    expect(model.status.error).toMatch(/No agent session/);
  });

  it('marks opening-composer only when a session exists', () => {
    const opening = markOpeningComposer(modelWithSession());
    expect(opening.status.kind).toBe('opening-composer');
  });

  it('refuses to open the composer when no session is attributed', () => {
    const model = markOpeningComposer(createLauncherPanelModel());
    expect(model.status.kind).toBe('open-failed');
    expect(model.status.error).toMatch(/prompt composer/);
  });

  it('marks success by returning to idle', () => {
    const model = markOpenSucceeded(markOpeningConversation(modelWithSession()));
    expect(model.status.kind).toBe('idle');
  });

  it('marks failure with an error message', () => {
    const model = markOpenFailed(modelWithSession(), 'boom');
    expect(model.status.kind).toBe('open-failed');
    expect(model.status.error).toBe('boom');
  });
});

describe('resetLauncherStatus', () => {
  it('clears transient opening/failed statuses back to idle when a session exists', () => {
    const failed = markOpenFailed(modelWithSession(), 'x');
    const reset = resetLauncherStatus(failed);
    expect(reset.status.kind).toBe('idle');
  });

  it('falls back to no-session when there is no attributed session', () => {
    const failed = markOpenFailed(createLauncherPanelModel(), 'x');
    const reset = resetLauncherStatus(failed);
    expect(reset.status.kind).toBe('no-session');
  });

  it('is a no-op for already-stable statuses', () => {
    const idle = modelWithSession();
    expect(resetLauncherStatus(idle)).toBe(idle);
    const noSession = createLauncherPanelModel();
    expect(resetLauncherStatus(noSession)).toBe(noSession);
  });
});

describe('command-argument builders', () => {
  it('builds the conversation open element carrying the host id', () => {
    expect(buildConversationOpenElement(modelWithSession({ session: { agentType: 'claude', sessionId: 's', hostId: 4 } }))).toEqual({ hostId: 4 });
  });

  it('omits hostId from the conversation element when unknown', () => {
    expect(buildConversationOpenElement(modelWithSession({ session: { agentType: 'claude', sessionId: 's' } }))).toEqual({});
  });

  it('returns undefined for the conversation element when there is no session', () => {
    expect(buildConversationOpenElement(createLauncherPanelModel())).toBeUndefined();
  });

  it('builds normalized prompt-composer open args with an agent target', () => {
    const args = buildComposerOpenArgs(modelWithSession({ session: { agentType: 'codex', sessionId: 'sess', hostId: 2, label: 'L' } }));
    expect(args).toEqual({
      target: { kind: 'agent', agentType: 'codex', sessionId: 'sess', hostId: 2, label: 'L' },
    });
  });

  it('omits optional fields from composer args when absent', () => {
    const args = buildComposerOpenArgs(modelWithSession({ session: { agentType: 'codex', sessionId: 'sess' } }));
    expect(args).toEqual({ target: { kind: 'agent', agentType: 'codex', sessionId: 'sess' } });
    expect('hostId' in (args!.target)).toBe(false);
    expect('label' in (args!.target)).toBe(false);
  });

  it('returns undefined for composer args when there is no session', () => {
    expect(buildComposerOpenArgs(createLauncherPanelModel())).toBeUndefined();
  });
});

describe('renderLauncherHtml', () => {
  it('renders disabled buttons when no session is attributed', () => {
    const html = renderLauncherHtml(createLauncherPanelModel(), { nonce: 'n', cspSource: 'https://x' });
    expect(html).toContain('Open Conversation</button>');
    expect(html).toContain('disabled');
    expect(html).toContain('No active session');
    expect(html).toContain('nonce="n"');
    expect(html).toContain('Content-Security-Policy');
  });

  it('renders enabled buttons and the session line when a session is attributed', () => {
    const html = renderLauncherHtml(modelWithSession(), { nonce: 'n', cspSource: 'https://x' });
    expect(html).toContain('claude: abc-123');
    expect(html).toContain('connected');
    // Exactly two buttons, neither disabled.
    const disabledMatches = html.match(/<button[^>]*disabled/g) ?? [];
    expect(disabledMatches.length).toBe(0);
    expect(html).toContain('data-action="open-conversation"');
    expect(html).toContain('data-action="open-composer"');
  });

  it('escapes the title and session id', () => {
    const model = applySessionAttribution(createLauncherPanelModel(), {
      kind: 'match',
      session: { agentType: 'claude', sessionId: '<x>', label: 'claude: <x>' },
      hasConnection: true,
    });
    const html = renderLauncherHtml(model);
    expect(html).toContain('&lt;x&gt;');
    expect(html).not.toContain('claude: <x>');
  });

  it('does not emit a CSP meta tag when nonce/cspSource are absent', () => {
    const html = renderLauncherHtml(createLauncherPanelModel());
    expect(html).not.toContain('Content-Security-Policy');
  });
});
