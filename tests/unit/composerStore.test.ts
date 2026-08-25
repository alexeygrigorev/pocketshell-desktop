import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { StageAttachmentsResult } from '../../src/shared/types';

/**
 * The composer's behaviour tests — the desktop equivalents of the Android
 * instrumented suites the spec cites (PromptComposerSendDismissE2eTest,
 * PromptComposerDiscardE2eTest, ComposerPartialExpandE2eTest), driven through
 * the store rather than a rendered tree because the rules being pinned are
 * state rules, not layout ones. See docs/COMPOSER.md §24.
 */

const stage = vi.fn<(payload: unknown) => Promise<StageAttachmentsResult>>();
const pickFiles = vi.fn<(payload: unknown) => Promise<string[]>>();

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    attachments: {
      stage: (payload: unknown) => stage(payload),
      pickFiles: (payload: unknown) => pickFiles(payload),
    },
  },
}));

const { useComposerStore } = await import('../../src/renderer/stores/composer');
const { COMPOSER_STRINGS } = await import('../../src/shared/composerText');
const { composerTiming } = await import('../../src/shared/composerSend');

const A = '~/.pocketshell/attachments/main/shot.png';
const B = '~/.pocketshell/attachments/main/log.txt';
const KEY = 'conn-1/main';
const OTHER = 'conn-1/build';

const CONN = 'conn-1' as never;

function okResult(paths: string[]): StageAttachmentsResult {
  return { ok: true, paths, failedCount: 0 };
}

type Store = ReturnType<typeof useComposerStore>;

let composer: Store;

beforeEach(() => {
  setActivePinia(createPinia());
  composer = useComposerStore();
  stage.mockReset();
  pickFiles.mockReset();
});

afterEach(() => {
  composerTiming.sendTimeoutMs = 12_000;
});

async function attach(key: string, paths: string[], result?: StageAttachmentsResult): Promise<void> {
  stage.mockResolvedValueOnce(result ?? okResult(paths));
  await composer.stage(key, {
    connectionId: CONN,
    scopeKey: 'main',
    sources: paths.map(() => ({ kind: 'file', path: 'local' })),
  });
}

describe('draft lifecycle', () => {
  it('mirrors every edit and clears the error on any keystroke (:299)', () => {
    composer.restoreFailedSend(KEY, 'old payload');
    expect(composer.states[KEY]?.error).toBe(COMPOSER_STRINGS.notSent);
    composer.setDraft(KEY, 'typing again');
    expect(composer.states[KEY]?.error).toBeNull();
    expect(composer.states[KEY]?.draft).toBe('typing again');
  });

  it('keeps a per-session draft — switching away and back restores it', () => {
    composer.setDraft(KEY, 'draft for main');
    composer.setDraft(OTHER, 'draft for build');
    // The Android owner-stamp would have DISCARDED the first one here (§12.4).
    expect(composer.states[KEY]?.draft).toBe('draft for main');
    expect(composer.states[OTHER]?.draft).toBe('draft for build');
  });

  it('a session that was never touched has an empty draft', () => {
    composer.setDraft(KEY, 'only in main');
    expect(composer.ensure(OTHER).draft).toBe('');
  });

  it('prefillCommand replaces a leading slash token (:508)', () => {
    composer.setDraft(KEY, '/cle and some args');
    composer.prefillCommand(KEY, '/clear');
    expect(composer.states[KEY]?.draft).toBe('/clear and some args');
  });

  it('seedPrompt appends on its own line (:482)', () => {
    composer.setDraft(KEY, 'context');
    composer.seedPrompt(KEY, 'review ~/a.ts');
    expect(composer.states[KEY]?.draft).toBe('context\nreview ~/a.ts');
  });
});

describe('attachments', () => {
  it('stages paths as tiles WITHOUT touching the draft (:301-309)', async () => {
    composer.setDraft(KEY, 'typed first');
    await attach(KEY, [A]);
    expect(composer.states[KEY]?.draft).toBe('typed first');
    expect(composer.states[KEY]?.attachments.map((a) => a.remotePath)).toEqual([A]);
    expect(composer.states[KEY]?.attachments[0]?.displayName).toBe('shot.png');
  });

  it('attach-then-type leaves the draft empty right after attaching', async () => {
    await attach(KEY, [A]);
    expect(composer.states[KEY]?.draft).toBe('');
    composer.setDraft(KEY, 'now some text');
    expect(composer.states[KEY]?.attachments).toHaveLength(1);
    expect(composer.states[KEY]?.draft).toBe('now some text');
  });

  it('KEEPS the survivors of a partial failure and shows the error (#570)', async () => {
    await attach(KEY, [A], { ok: false, paths: [A], failedCount: 1, error: 'huge.bin too large' });
    expect(composer.states[KEY]?.attachments.map((a) => a.remotePath)).toEqual([A]);
    expect(composer.states[KEY]?.error).toBe(
      COMPOSER_STRINGS.attachmentFailed('huge.bin too large'),
    );
  });

  it('reports an error and stages nothing when nothing landed', async () => {
    stage.mockResolvedValueOnce({ ok: false, paths: [], failedCount: 2, error: 'connection lost' });
    await composer.stage(KEY, {
      connectionId: CONN,
      scopeKey: 'main',
      sources: [
        { kind: 'file', path: 'a' },
        { kind: 'file', path: 'b' },
      ],
    });
    expect(composer.states[KEY]?.attachments).toEqual([]);
    expect(composer.states[KEY]?.error).toContain('connection lost');
  });

  it('de-duplicates by remote path (:409-412)', async () => {
    await attach(KEY, [A, B]);
    await attach(KEY, [B]);
    expect(composer.states[KEY]?.attachments.map((a) => a.remotePath)).toEqual([A, B]);
  });

  it('is single-flight: a second batch while one is uploading is a no-op (:315)', async () => {
    let release!: (r: StageAttachmentsResult) => void;
    stage.mockReturnValueOnce(
      new Promise<StageAttachmentsResult>((resolve) => {
        release = resolve;
      }),
    );
    const first = composer.stage(KEY, {
      connectionId: CONN,
      scopeKey: 'main',
      sources: [{ kind: 'file', path: 'a' }],
    });
    expect(composer.states[KEY]?.uploadingCount).toBe(1);
    await composer.stage(KEY, {
      connectionId: CONN,
      scopeKey: 'main',
      sources: [{ kind: 'file', path: 'b' }],
    });
    expect(stage).toHaveBeenCalledTimes(1);
    release(okResult([A]));
    await first;
    expect(composer.states[KEY]?.uploadingCount).toBe(0);
  });

  it('removing a tile never touches the draft (:520-527)', async () => {
    composer.setDraft(KEY, 'keep me');
    await attach(KEY, [A, B]);
    composer.removeAttachment(KEY, A);
    expect(composer.states[KEY]?.attachments.map((a) => a.remotePath)).toEqual([B]);
    expect(composer.states[KEY]?.draft).toBe('keep me');
  });

  it('seedAttachment attaches an already-uploaded path once (:443)', () => {
    composer.seedAttachment(KEY, A);
    composer.seedAttachment(KEY, A);
    expect(composer.states[KEY]?.attachments).toHaveLength(1);
  });
});

describe('send', () => {
  it('composes text + attachment paths at SEND time', async () => {
    composer.setDraft(KEY, 'what is wrong here');
    await attach(KEY, [A, B]);
    const seen: string[] = [];
    await composer.send(KEY, async (p) => {
      seen.push(p);
      return true;
    });
    expect(seen).toEqual([`what is wrong here\n\nAttached files:\n- ${A}\n- ${B}`]);
  });

  it('allows an attachment-only send', async () => {
    await attach(KEY, [A]);
    const seen: string[] = [];
    await composer.send(KEY, async (p) => {
      seen.push(p);
      return true;
    });
    expect(seen).toEqual([`Attached files:\n- ${A}`]);
  });

  it('does NOT clear the draft or the tiles while in flight (#745)', async () => {
    composer.setDraft(KEY, 'hello');
    await attach(KEY, [A]);
    let release!: (v: boolean) => void;
    const pending = composer.send(
      KEY,
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    expect(composer.states[KEY]?.sendInFlight).toBe(true);
    expect(composer.states[KEY]?.draft).toBe('hello');
    expect(composer.states[KEY]?.attachments).toHaveLength(1);
    release(true);
    await pending;
  });

  it('clears the draft and the tiles on delivery, and STAYS OPEN (§12.3)', async () => {
    composer.setDraft(KEY, 'hello');
    await attach(KEY, [A]);
    await composer.send(KEY, async () => true);
    expect(composer.states[KEY]?.draft).toBe('');
    expect(composer.states[KEY]?.attachments).toEqual([]);
    expect(composer.states[KEY]?.error).toBeNull();
    // The phone dismisses the sheet here; the desktop deliberately does not.
    expect(composer.mode).toBe('docked');
  });

  it('restores the COMPOSED payload and drops the tiles on failure (:768-770)', async () => {
    composer.setDraft(KEY, 'typed text');
    await attach(KEY, [A]);
    await composer.send(KEY, async () => false);
    const s = composer.states[KEY]!;
    expect(s.draft).toBe(`typed text\n\nAttached files:\n- ${A}`);
    expect(s.draft).toContain(A);
    expect(s.attachments).toEqual([]);
    expect(s.error).toBe(COMPOSER_STRINGS.notSent);
    expect(s.sendInFlight).toBe(false);
  });

  it('a resend after a failure still carries the path and does not double it', async () => {
    composer.setDraft(KEY, 'typed text');
    await attach(KEY, [A]);
    await composer.send(KEY, async () => false);
    const seen: string[] = [];
    await composer.send(KEY, async (p) => {
      seen.push(p);
      return true;
    });
    expect(seen[0]).toContain(A);
    expect(seen[0]!.match(/Attached files:/g)).toHaveLength(1);
    expect(seen[0]!.match(/- ~\/\.pocketshell/g)).toHaveLength(1);
  });

  it('treats a timeout exactly like a failure', async () => {
    composerTiming.sendTimeoutMs = 10;
    composer.setDraft(KEY, 'slow one');
    const ok = await composer.send(KEY, () => new Promise<boolean>(() => {}));
    expect(ok).toBe(false);
    expect(composer.states[KEY]?.error).toBe(COMPOSER_STRINGS.notSent);
    expect(composer.states[KEY]?.draft).toBe('slow one');
  });

  it('is a no-op when the composed payload is empty (:672)', async () => {
    composer.setDraft(KEY, '   ');
    const deliver = vi.fn(async () => true);
    expect(await composer.send(KEY, deliver)).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('is a no-op while a send is already in flight (:662)', async () => {
    composer.setDraft(KEY, 'hello');
    let release!: (v: boolean) => void;
    const first = composer.send(
      KEY,
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const second = vi.fn(async () => true);
    expect(await composer.send(KEY, second)).toBe(false);
    expect(second).not.toHaveBeenCalled();
    release(true);
    await first;
  });

  it('canSend mirrors the button predicate (PromptComposerSheet.kt:1202)', async () => {
    expect(composer.canSend(KEY)).toBe(false);
    composer.setDraft(KEY, 'x');
    expect(composer.canSend(KEY)).toBe(true);
    composer.setDraft(KEY, '');
    expect(composer.canSend(KEY)).toBe(false);
    await attach(KEY, [A]);
    expect(composer.canSend(KEY)).toBe(true);
  });
});

describe('discard (PromptComposerDiscardE2eTest.kt:160-226)', () => {
  it('clears draft, tiles and banner, and leaves the composer OPEN', async () => {
    composer.setDraft(KEY, 'typed text');
    await attach(KEY, [A]);
    await composer.send(KEY, async () => false);
    expect(composer.states[KEY]?.error).not.toBeNull();

    composer.discard(KEY);
    const s = composer.states[KEY]!;
    expect(s.draft).toBe('');
    expect(s.attachments).toEqual([]);
    expect(s.error).toBeNull();
    expect(composer.mode).not.toBe('hidden');
  });

  it('does not touch any other session', () => {
    composer.setDraft(KEY, 'mine');
    composer.setDraft(OTHER, 'theirs');
    composer.discard(KEY);
    expect(composer.states[OTHER]?.draft).toBe('theirs');
  });
});

describe('visibility state machine (§12.1)', () => {
  it('defaults to docked', () => {
    expect(composer.mode).toBe('docked');
  });

  it('grows hidden -> docked -> expanded and stops there', () => {
    composer.setMode('hidden');
    composer.grow();
    expect(composer.mode).toBe('docked');
    composer.grow();
    expect(composer.mode).toBe('expanded');
    composer.grow();
    expect(composer.mode).toBe('expanded');
  });

  it('shrinks expanded -> docked -> hidden and stops there', () => {
    composer.setMode('expanded');
    composer.shrink();
    expect(composer.mode).toBe('docked');
    composer.shrink();
    expect(composer.mode).toBe('hidden');
    composer.shrink();
    expect(composer.mode).toBe('hidden');
  });

  it('toggleHidden restores the last non-hidden mode, not always docked', () => {
    composer.setMode('expanded');
    composer.toggleHidden();
    expect(composer.mode).toBe('hidden');
    composer.toggleHidden();
    expect(composer.mode).toBe('expanded');
  });

  it('never destroys the draft across any transition', () => {
    composer.setDraft(KEY, 'survivor');
    for (const m of ['hidden', 'docked', 'expanded', 'hidden'] as const) {
      composer.setMode(m);
      expect(composer.states[KEY]?.draft).toBe('survivor');
    }
  });

  /**
   * The reported bug: close the panel, open another session, and it is back.
   * Open/closed is a preference about the tool, so it does not live in the
   * per-session record that a never-visited session starts blank.
   */
  it('stays closed when the user switches to another session', () => {
    composer.setDraft(KEY, 'draft for main');
    composer.setMode('hidden');

    composer.ensure(OTHER); // selecting a session the composer has never seen
    expect(composer.mode).toBe('hidden');

    // ...and the per-session halves are still per session.
    expect(composer.states[OTHER]?.draft).toBe('');
    expect(composer.states[KEY]?.draft).toBe('draft for main');
  });

  it('re-opens into the mode it was closed from, whichever session is current', () => {
    composer.setMode('expanded');
    composer.setMode('hidden');
    composer.ensure(OTHER);
    composer.toggleHidden();
    expect(composer.mode).toBe('expanded');
  });

  it('keeps the dragged height per session even though the mode is shared', () => {
    composer.setHeight(KEY, 420);
    expect(composer.ensure(OTHER).height).toBeNull();
    expect(composer.states[KEY]?.height).toBe(420);
  });

  it('a delivered send re-opens a hidden composer rather than leaving it hidden', async () => {
    composer.setDraft(KEY, 'hi');
    composer.setMode('hidden');
    await composer.send(KEY, async () => true);
    expect(composer.mode).toBe('docked');
  });
});

describe('connection degradation is advisory (§9)', () => {
  it('does not gate send', async () => {
    composer.setConnectionDegraded(KEY, true);
    composer.setDraft(KEY, 'send me anyway');
    expect(composer.canSend(KEY)).toBe(true);
    expect(await composer.send(KEY, async () => true)).toBe(true);
  });
});
