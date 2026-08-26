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
const { defaultGeometry } = await import('../../src/shared/composerGeometry');
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

  it('WAITS for an upload in flight, then sends the prompt WITH the image', async () => {
    // The user's report, in their words: "If I'm uploading an image and hit
    // enter, I wait till image is uploaded and then send the prompt" — and, on
    // being told the old rule cited the phone for abandoning the batch: "that's
    // not how the phone app works. it waits".
    //
    // What the old rule did was drop the in-flight batch and send what was
    // already staged, so a prompt written ABOUT an image went out without it,
    // to an agent that answered anyway having never seen the picture.
    let release!: (r: StageAttachmentsResult) => void;
    stage.mockReturnValueOnce(
      new Promise<StageAttachmentsResult>((resolve) => {
        release = resolve;
      }),
    );
    composer.setDraft(KEY, 'what is wrong in this screenshot?');
    const staging = composer.stage(KEY, {
      connectionId: CONN,
      scopeKey: 'main',
      sources: [{ kind: 'file', path: 'shot.png' }],
    });
    expect(composer.states[KEY]?.uploadingCount).toBe(1);

    // Enter, mid-upload. Nothing may be delivered yet.
    //
    // Typed argument list, not `vi.fn(async () => true)`: an inferred zero-arg
    // spy makes `mock.calls` a tuple of length 0, and the assertions below are
    // entirely about WHAT was delivered.
    const deliver = vi.fn(async (_payload: string) => true);
    const sending = composer.send(KEY, deliver);
    await Promise.resolve();
    expect(deliver).not.toHaveBeenCalled();
    // And the composer must not look idle while it waits, or a click-outside
    // could dismiss a prompt that is parked on its own upload.
    expect(composer.states[KEY]?.sendInFlight).toBe(true);

    release(okResult([A]));
    await staging;
    expect(await sending).toBe(true);

    // ONE delivery, carrying the path that landed while the send waited.
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]![0]).toContain(A);
    expect(deliver.mock.calls[0]![0]).toContain('what is wrong in this screenshot?');
  });

  it('does NOT send when the upload it waited for failed', async () => {
    // The prompt was written about the attachment, so delivering it without one
    // is the failure this whole rule exists to remove. The draft and the banner
    // stay, which is what every other refusal in this store leaves behind.
    let release!: (r: StageAttachmentsResult) => void;
    stage.mockReturnValueOnce(
      new Promise<StageAttachmentsResult>((resolve) => {
        release = resolve;
      }),
    );
    composer.setDraft(KEY, 'look at this');
    const staging = composer.stage(KEY, {
      connectionId: CONN,
      scopeKey: 'main',
      sources: [{ kind: 'file', path: 'shot.png' }],
    });

    const deliver = vi.fn(async () => true);
    const sending = composer.send(KEY, deliver);
    release({ ok: false, paths: [], failedCount: 1, error: 'connection lost' });
    await staging;

    expect(await sending).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
    expect(composer.states[KEY]?.draft).toBe('look at this');
    expect(composer.states[KEY]?.error).toContain('connection lost');
    // The wait must not leave the flag stuck on, or the composer is bricked:
    // every later send would return at the single-flight guard.
    expect(composer.states[KEY]?.sendInFlight).toBe(false);
  });

  it('takes one send while waiting, not two', async () => {
    // Enter pressed twice during a slow upload. The second must be the ordinary
    // single-flight no-op rather than a second prompt queued behind the same
    // picture.
    let release!: (r: StageAttachmentsResult) => void;
    stage.mockReturnValueOnce(
      new Promise<StageAttachmentsResult>((resolve) => {
        release = resolve;
      }),
    );
    composer.setDraft(KEY, 'twice');
    const staging = composer.stage(KEY, {
      connectionId: CONN,
      scopeKey: 'main',
      sources: [{ kind: 'file', path: 'shot.png' }],
    });

    const deliver = vi.fn(async () => true);
    const first = composer.send(KEY, deliver);
    await Promise.resolve();
    const second = await composer.send(KEY, deliver);
    expect(second).toBe(false);

    release(okResult([A]));
    await staging;
    expect(await first).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('still sends immediately when nothing is uploading', async () => {
    // The wait is only for a batch in flight. A prompt with no upload behind it
    // must not pay a tick for the feature.
    composer.setDraft(KEY, 'plain');
    const deliver = vi.fn(async () => true);
    expect(await composer.send(KEY, deliver)).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
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


  /**
   * The card's box is a preference about the tool, exactly like open/closed:
   * where the composer sits describes the window layout, not any conversation.
   * A per-session position would make the card jump as you switch sessions,
   * which is the bug this file already pins for the mode.
   */
  it('shares one card geometry across sessions', () => {
    composer.setGeometry({ right: 120, bottom: 40, width: 640, height: 300 });
    composer.ensure(OTHER);
    expect(composer.geometry).toEqual({ right: 120, bottom: 40, width: 640, height: 300 });
  });

  it('starts in the resting corner at the default size', () => {
    expect(composer.geometry).toEqual(defaultGeometry());
  });

  it('resetGeometry puts a card the user has lost back in its corner', () => {
    composer.setGeometry({ right: 900, bottom: 400, width: 380, height: 200 });
    composer.resetGeometry();
    expect(composer.geometry).toEqual(defaultGeometry());
  });

  it('keeps the geometry across every mode transition', () => {
    const g = { right: 60, bottom: 80, width: 500, height: 260 };
    composer.setGeometry(g);
    for (const m of ['hidden', 'docked', 'expanded', 'docked'] as const) {
      composer.setMode(m);
      expect(composer.geometry).toEqual(g);
    }
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

/**
 * `closeComposerOnSend` (docs/COMPOSER.md §26): the phone's rhythm — send, the
 * card gets out of the way, the next keystroke brings it back.
 */
describe('close on send', () => {
  it('closes the composer after a confirmed delivery', async () => {
    composer.setDraft(KEY, 'ship it');
    await composer.send(KEY, async () => true, { closeOnDelivery: true });
    expect(composer.mode).toBe('hidden');
  });

  it('leaves it OPEN when the send failed, where the banner and draft are', async () => {
    composer.setDraft(KEY, 'ship it');
    await composer.send(KEY, async () => false, { closeOnDelivery: true });
    expect(composer.mode).not.toBe('hidden');
    expect(composer.states[KEY]?.error).toBe(COMPOSER_STRINGS.notSent);
    expect(composer.states[KEY]?.draft).toBe('ship it');
  });

  it('leaves it open when a send times out, which is a failure like any other', async () => {
    composerTiming.sendTimeoutMs = 10;
    composer.setDraft(KEY, 'slow one');
    await composer.send(KEY, () => new Promise<boolean>(() => {}), { closeOnDelivery: true });
    expect(composer.mode).not.toBe('hidden');
  });

  it('keeps the composer open on delivery when the setting is off', async () => {
    composer.setDraft(KEY, 'ship it');
    await composer.send(KEY, async () => true);
    expect(composer.mode).toBe('docked');
  });

  it('remembers docked-vs-maximized across a close-on-send round trip', async () => {
    composer.setMode('expanded');
    composer.setDraft(KEY, 'ship it');
    await composer.send(KEY, async () => true, { closeOnDelivery: true });
    expect(composer.mode).toBe('hidden');
    composer.toggleHidden();
    expect(composer.mode).toBe('expanded');
  });

  it('still clears the draft and the tiles on the way out', async () => {
    composer.setDraft(KEY, 'ship it');
    await attach(KEY, [A]);
    await composer.send(KEY, async () => true, { closeOnDelivery: true });
    expect(composer.states[KEY]?.draft).toBe('');
    expect(composer.states[KEY]?.attachments).toEqual([]);
  });

  it('a partially-staged batch does not turn a delivery into a failure', async () => {
    // #570 partial failure happens at STAGE time: the survivors are attached
    // and an error is shown. If the user sends anyway, the send either lands or
    // it does not — the earlier attachment error has no say in whether the
    // panel closes.
    await attach(KEY, [A], { ok: false, paths: [A], failedCount: 1, error: 'huge.bin too large' });
    expect(composer.states[KEY]?.error).not.toBeNull();
    await composer.send(KEY, async () => true, { closeOnDelivery: true });
    expect(composer.mode).toBe('hidden');
    expect(composer.states[KEY]?.error).toBeNull();
  });
});

/**
 * Closing the composer does NOT decide what the next keystroke does
 * (docs/COMPOSER.md §12.2, revised).
 *
 * The user reported the old behaviour as a bug — "I start typing, prompt
 * composer opens, I click esc, continue typing and now the input goes to the
 * terminal" — and it was the design working as written: `dismiss()` suppressed
 * the typing intercept, so Escape carried a second, durable instruction beyond
 * "put the panel away".
 *
 * Every closing route now behaves the same, and typing brings the panel back
 * from all of them. What suppresses is a press inside the TERMINAL, which is
 * the only gesture that is unambiguously about the shell.
 */
describe('closing, and what the next keystroke does', () => {
  it('a dismissal does NOT suppress typing — this is the reported bug', () => {
    composer.dismiss();
    expect(composer.mode).toBe('hidden');
    // The regression. Escape closes; it does not also speak for the next
    // keystroke, so continuing to type re-opens the composer carrying the
    // character, exactly as it does from any other closed state.
    expect(composer.isTypingSuppressed(KEY)).toBe(false);
  });

  it('a delivered send closes WITHOUT suppressing, so typing brings it back', async () => {
    composer.setDraft(KEY, 'ship it');
    await composer.send(KEY, async () => true, { closeOnDelivery: true });
    expect(composer.mode).toBe('hidden');
    expect(composer.isTypingSuppressed(KEY)).toBe(false);
  });

  it('the two close paths agree, and are still two paths', async () => {
    // They produce the same state, which is the point of the change — and they
    // stay distinct actions, which is the point of NOT collapsing them into one
    // boolean. `dismiss` still records the mode to come back to; the send path
    // goes through `setMode` and does not.
    composer.setMode('expanded');
    composer.dismiss();
    const afterDismiss = composer.isTypingSuppressed(KEY);

    composer.setMode('expanded');
    composer.setDraft(KEY, 'ship it');
    await composer.send(KEY, async () => true, { closeOnDelivery: true });

    expect(afterDismiss).toBe(composer.isTypingSuppressed(KEY));
    expect(composer.mode).toBe('hidden');
    expect(composer.lastOpenMode).toBe('expanded');
  });

  it('the toggle and the size ladder close the same way Escape does', () => {
    // A user who dismisses three different ways must not get three different
    // results. All of these route through `dismiss`.
    composer.toggleHidden();
    expect(composer.mode).toBe('hidden');
    expect(composer.isTypingSuppressed(KEY)).toBe(false);

    composer.setMode('expanded');
    composer.shrink();
    expect(composer.mode).toBe('docked');
    composer.shrink();
    expect(composer.mode).toBe('hidden');
    expect(composer.isTypingSuppressed(KEY)).toBe(false);
  });

  it('a dismissal still remembers docked-vs-maximized for the next summons', () => {
    composer.setMode('expanded');
    composer.dismiss();
    composer.toggleHidden();
    expect(composer.mode).toBe('expanded');
  });

  it('never destroys the draft', () => {
    composer.setDraft(KEY, 'survivor');
    composer.dismiss();
    expect(composer.states[KEY]?.draft).toBe('survivor');
  });
});

/**
 * The plain-terminal hatch, which moved off Escape and onto the pointer
 * (docs/COMPOSER.md §12.2, §26.1).
 *
 * It has to exist: with `typingOpensComposer` on and nothing suppressing, every
 * printable keystroke reaches the composer and the shell becomes untypeable
 * without a trip to Settings. The gesture is a press inside the terminal pane —
 * which is what a user does before typing at a shell anyway.
 */
describe('the plain-terminal hatch', () => {
  /** A press, as far as the store is concerned: an identity, nothing more. */
  const press = (): object => ({});

  it('a press in the terminal suppresses typing without touching the panel', () => {
    composer.setMode('docked');
    composer.suppressTyping(KEY, press());
    expect(composer.isTypingSuppressed(KEY)).toBe(true);
    // It says where the user is TYPING, not what the panel should do. Closing
    // the panel is Escape's job and this is not Escape.
    expect(composer.mode).toBe('docked');
  });

  it('any summons lifts it, whatever set it', () => {
    composer.suppressTyping(KEY);
    composer.setMode('docked');
    expect(composer.isTypingSuppressed(KEY)).toBe(false);
  });

  it('allowTypingToOpen lifts it without opening — a press inside the composer', () => {
    composer.dismiss();
    composer.suppressTyping(KEY);
    composer.allowTypingToOpen(KEY);
    expect(composer.isTypingSuppressed(KEY)).toBe(false);
    expect(composer.mode).toBe('hidden');
  });

  it('survives a close, so working at the shell is not undone by Escape', () => {
    // The sequence that makes the hatch usable: click into the terminal, then
    // put the panel away. Escape must not RE-ARM typing here — the user has
    // already said where they are working.
    composer.setMode('docked');
    composer.suppressTyping(KEY);
    composer.dismiss();
    expect(composer.mode).toBe('hidden');
    expect(composer.isTypingSuppressed(KEY)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // ONE PRESS, ONE MEANING — the reported bug.
  //
  // "in some cases my inpurt isn't captured i type directly into teminal no
  // promt composer". A single `mousedown` in a terminal pane was doing two
  // jobs: the composer's click-outside rule dismissed the empty card, and the
  // SAME press armed the plain-terminal hatch. The next prompt went to the
  // shell from a screen with no composer on it.
  //
  // The order below is the order the browser produces, and it is why nothing
  // either handler could read told them apart: the composer listens on
  // `window` in the CAPTURE phase, TerminalView on its own element, and window
  // capture always precedes an element handler. So the dismissal has already
  // run — the card is hidden and looks as though it always was — by the time
  // the arming asks.
  // -------------------------------------------------------------------------

  it('the press that dismissed an empty composer does NOT also arm the hatch', () => {
    composer.setMode('docked');
    const p = press();

    // The composer's window-capture handler, first.
    composer.dismissOnOutsidePress(p);
    // TerminalView's own handler, on the same press, second.
    composer.suppressTyping(KEY, p);

    expect(composer.mode).toBe('hidden');
    // The whole regression: typing now re-opens the composer carrying the
    // character, which is what §12.2 says a click-outside dismissal leaves
    // behind ("nothing was lost; typing afterwards almost certainly means they
    // want it back").
    expect(composer.isTypingSuppressed(KEY)).toBe(false);
  });

  it('a press that dismissed nothing still arms it — the hatch itself', () => {
    // The composer is already away, so this press dismisses nothing and means
    // only what it looks like: "I am typing here". Without this the hatch would
    // not exist and the shell would be untypeable with the setting on.
    composer.dismiss();
    composer.suppressTyping(KEY, press());
    expect(composer.isTypingSuppressed(KEY)).toBe(true);
  });

  it('a press over a NON-empty composer arms it, because it dismissed nothing', () => {
    // The card stays on screen (there is a draft in it), so the press was not
    // answered by anything and is a plain statement about where the user types.
    // This is §12.2's documented composition — click into the terminal, then
    // Escape, and typing still goes to the shell.
    composer.setDraft(KEY, 'half a prompt');
    composer.setMode('docked');
    composer.suppressTyping(KEY, press());
    expect(composer.isTypingSuppressed(KEY)).toBe(true);
    expect(composer.mode).toBe('docked');
  });

  it('answers ONE press, so the next one still arms the hatch', () => {
    // The dismissing press landed on the tab strip, not in a terminal — so it
    // is never asked about and must not be left lying around to swallow the
    // next terminal press. Identity is the event object, which is why there is
    // nothing to reset.
    composer.setMode('docked');
    composer.dismissOnOutsidePress(press());
    composer.suppressTyping(KEY, press());
    expect(composer.isTypingSuppressed(KEY)).toBe(true);
  });

  it('still dismisses — it is a close first and a marker second', () => {
    composer.setMode('expanded');
    composer.dismissOnOutsidePress(press());
    expect(composer.mode).toBe('hidden');
    // It goes through `setMode`, so the mode to come back to is remembered.
    expect(composer.lastOpenMode).toBe('expanded');
  });

  // -------------------------------------------------------------------------
  // ONE ENTRY PER PANE. "I am typing at the shell" is a fact about the pane the
  // user pressed in, and it used to be one boolean for the whole app.
  // -------------------------------------------------------------------------

  it('a press in one pane says nothing about another', () => {
    composer.suppressTyping(KEY, press());
    expect(composer.isTypingSuppressed(OTHER)).toBe(false);
  });

  it('a summons lifts it in EVERY pane — the panel is app-level', () => {
    composer.suppressTyping(KEY);
    composer.suppressTyping(OTHER);
    composer.setMode('docked');
    expect(composer.isTypingSuppressed(KEY)).toBe(false);
    expect(composer.isTypingSuppressed(OTHER)).toBe(false);
  });

  it('allowTypingToOpen with no key lifts every pane — arriving at a workspace', () => {
    composer.suppressTyping(KEY);
    composer.suppressTyping(OTHER);
    composer.allowTypingToOpen();
    expect(composer.isTypingSuppressed(KEY)).toBe(false);
    expect(composer.isTypingSuppressed(OTHER)).toBe(false);
  });

  it('allowTypingToOpen with a key leaves the other pane alone', () => {
    composer.suppressTyping(KEY);
    composer.suppressTyping(OTHER);
    composer.allowTypingToOpen(KEY);
    expect(composer.isTypingSuppressed(KEY)).toBe(false);
    expect(composer.isTypingSuppressed(OTHER)).toBe(true);
  });

  it('travels with a rename, even for a pane that never had a draft', () => {
    // `ensure()` is never called for a pane the user has only typed at the
    // shell in, so the suppression has to move on its own — otherwise the
    // renamed pane starts answering to the intercept mid-keystroke.
    composer.suppressTyping(KEY);
    composer.rekey(KEY, OTHER);
    expect(composer.isTypingSuppressed(KEY)).toBe(false);
    expect(composer.isTypingSuppressed(OTHER)).toBe(true);
  });

  it('dies with the session, so the next session of that name is not born mute', () => {
    // `sessions create` derives the name from the folder, so a name comes back.
    composer.suppressTyping(KEY);
    composer.forget(KEY);
    expect(composer.isTypingSuppressed(KEY)).toBe(false);
  });
});

/**
 * `forget` — the kill's counterpart to a rename's `rekey`
 * (docs/WORKSPACE.md §14.3).
 *
 * A rename moves a record to the name its session now has; a kill leaves a
 * record no session will ever claim again. They must not be the same call, and
 * neither of them is `discard`, which is the user throwing away a draft in a
 * session that still exists.
 */
describe('forget', () => {
  it('removes the record entirely, not just its contents', () => {
    composer.setDraft(KEY, 'half a prompt');
    composer.forget(KEY);
    // `discard` would leave a blank record behind. That is right when the
    // session is still there and the composer has to go on rendering it, and
    // wrong here: the entry would persist to localStorage forever.
    expect(composer.states[KEY]).toBeUndefined();
  });

  it('leaves every other session alone', () => {
    composer.setDraft(KEY, 'mine');
    composer.setDraft(OTHER, 'theirs');
    composer.forget(KEY);
    expect(composer.states[OTHER]?.draft).toBe('theirs');
  });

  it('does not hand a killed session’s draft to the next one of that name', () => {
    // Not hypothetical: `sessions create` derives the name from the folder, so
    // a folder's session comes back under the same name routinely.
    composer.setDraft(KEY, 'from the dead session');
    composer.forget(KEY);
    expect(composer.ensure(KEY).draft).toBe('');
  });

  it('is a no-op for a key that was never touched', () => {
    expect(() => composer.forget('conn-1/never-existed')).not.toThrow();
    expect(composer.states['conn-1/never-existed']).toBeUndefined();
  });
});
