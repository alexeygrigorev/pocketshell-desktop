// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * The settings store's three jobs: hand back the documented defaults, survive a
 * restart, and survive a blob it did not write.
 *
 * jsdom, not the suite's default `node` environment, because the whole point of
 * the middle one is the localStorage round-trip — the store's `typeof
 * localStorage === 'undefined'` guard would make every persistence assertion
 * pass vacuously under `node`.
 */

const { useSettingsStore, coerceSettings, settingsDefaults } = await import(
  '../../src/renderer/stores/settings'
);

const KEY = 'pocketshell.settings.v1';

/** What is actually on disk, parsed. */
function stored(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

describe('defaults', () => {
  it('seeds the documented keys, composer switches ON', () => {
    const settings = useSettingsStore();
    expect(settings.typingOpensComposer).toBe(true);
    expect(settings.closeComposerOnSend).toBe(true);
    expect(settings.defaultHost).toBeNull();
  });

  it('seeds typography with exactly what shipped before it was settable', () => {
    const settings = useSettingsStore();
    expect(settings.monospaceFontFamily).toBeNull();
    expect(settings.terminalFontSize).toBe(16);
    expect(settings.editorFontSize).toBe(13);
  });

  it('seeds zoom at 100%, so an upgrade changes nothing on screen', () => {
    expect(useSettingsStore().zoomPercent).toBe(100);
  });

  it('seeds the theme as dark — never system — for the same reason', () => {
    // `system` as the default would repaint the app on upgrade for every user
    // whose OS is in light mode. Dark is what shipped.
    expect(useSettingsStore().theme).toBe('dark');
  });

  it('exposes every key of AppSettings on the store, not behind a container', () => {
    // The contract another agent is coding against: `settings.typingOpensComposer`.
    const settings = useSettingsStore();
    for (const key of Object.keys(settingsDefaults())) {
      expect(settings).toHaveProperty(key);
    }
  });

  it('writes nothing until something changes', () => {
    useSettingsStore();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe('persistence', () => {
  it('round-trips a change through localStorage into a fresh store', () => {
    const first = useSettingsStore();
    first.set('defaultHost', 'hetzner');
    first.set('typingOpensComposer', false);

    // A brand-new pinia, i.e. a fresh app launch reading the same profile.
    setActivePinia(createPinia());
    const second = useSettingsStore();
    expect(second.defaultHost).toBe('hetzner');
    expect(second.typingOpensComposer).toBe(false);
    expect(second.closeComposerOnSend).toBe(true);
  });

  it('persists direct assignment too, not only set()', () => {
    const settings = useSettingsStore();
    settings.closeComposerOnSend = false;
    expect(stored()['closeComposerOnSend']).toBe(false);
  });

  it('writes synchronously, so a value is durable the moment the UI moves', () => {
    const settings = useSettingsStore();
    settings.set('defaultHost', 'fixture');
    // No await, no nextTick: `flush: 'sync'` is the reason this holds.
    expect(stored()['defaultHost']).toBe('fixture');
  });

  it('normalises a blank host alias to null — the select emits ""', () => {
    const settings = useSettingsStore();
    settings.set('defaultHost', '  ');
    setActivePinia(createPinia());
    expect(useSettingsStore().defaultHost).toBeNull();
  });
});

describe('degrading a stored blob', () => {
  it('falls back to defaults on unparseable JSON', () => {
    localStorage.setItem(KEY, '{"defaultHost": "hetzn');
    const settings = useSettingsStore();
    expect(settings.defaultHost).toBeNull();
    expect(settings.typingOpensComposer).toBe(true);
  });

  it('falls back to defaults when the blob is not an object', () => {
    for (const blob of ['null', '42', '"hetzner"', '[]']) {
      localStorage.setItem(KEY, blob);
      setActivePinia(createPinia());
      expect(useSettingsStore().defaultHost).toBeNull();
    }
  });

  it('degrades PER KEY — one bad value does not cost the others', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ typingOpensComposer: 'yes', defaultHost: 'hetzner' }),
    );
    const settings = useSettingsStore();
    // The string is not a boolean, so that key alone reverts...
    expect(settings.typingOpensComposer).toBe(true);
    // ...and the perfectly good host beside it survives.
    expect(settings.defaultHost).toBe('hetzner');
  });

  it('ignores unknown keys rather than carrying them forward', () => {
    localStorage.setItem(KEY, JSON.stringify({ defaultHost: 'a', fromTheFuture: 1 }));
    const settings = useSettingsStore();
    expect(settings).not.toHaveProperty('fromTheFuture');
    settings.set('defaultHost', 'b');
    expect(stored()).not.toHaveProperty('fromTheFuture');
  });

  it('clamps a stored font size instead of discarding it', () => {
    localStorage.setItem(KEY, JSON.stringify({ terminalFontSize: 400, editorFontSize: 2 }));
    const settings = useSettingsStore();
    expect(settings.terminalFontSize).toBe(32);
    expect(settings.editorFontSize).toBe(8);
  });

  it('falls back to the shipped size when the stored one is not a number', () => {
    localStorage.setItem(KEY, JSON.stringify({ terminalFontSize: 'big' }));
    expect(useSettingsStore().terminalFontSize).toBe(16);
  });

  it('sanitises a stored font family rather than trusting it', () => {
    localStorage.setItem(KEY, JSON.stringify({ monospaceFontFamily: 'Fira Code"; }' }));
    expect(useSettingsStore().monospaceFontFamily).toBe('Fira Code');
  });

  it('round-trips the typography keys', () => {
    const first = useSettingsStore();
    first.set('monospaceFontFamily', 'JetBrains Mono');
    first.set('terminalFontSize', 20);
    setActivePinia(createPinia());
    const second = useSettingsStore();
    expect(second.monospaceFontFamily).toBe('JetBrains Mono');
    expect(second.terminalFontSize).toBe(20);
    expect(second.editorFontSize).toBe(13);
  });

  it('keeps a stored theme it knows, drops one it does not', () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: 'nord' }));
    expect(useSettingsStore().theme).toBe('nord');

    // An id from a newer build (or a typo in a hand-edited blob) reverts to
    // the default rather than leaving the app trying to apply nothing.
    localStorage.setItem(KEY, JSON.stringify({ theme: 'vaporwave' }));
    setActivePinia(createPinia());
    expect(useSettingsStore().theme).toBe('dark');

    localStorage.setItem(KEY, JSON.stringify({ theme: 'system' }));
    setActivePinia(createPinia());
    expect(useSettingsStore().theme).toBe('system');
  });

  it('rejects a non-string, non-null defaultHost', () => {
    expect(coerceSettings({ defaultHost: 7 }).defaultHost).toBeNull();
    expect(coerceSettings({ defaultHost: null }).defaultHost).toBeNull();
    expect(coerceSettings({ defaultHost: 'hetzner' }).defaultHost).toBe('hetzner');
  });
});

/**
 * Zoom lives in this store rather than beside the code that calls Chromium,
 * and these are the tests that say why: the keyboard chords and the settings
 * screen both go through these actions, so there is one value and it is the
 * one that persists.
 */
describe('zoom', () => {
  it('steps up and down through the store, not around it', () => {
    const settings = useSettingsStore();
    settings.zoomIn();
    expect(settings.zoomPercent).toBe(110);
    settings.zoomOut();
    expect(settings.zoomPercent).toBe(100);
  });

  it('resets to 100% from anywhere — the guaranteed way back', () => {
    const settings = useSettingsStore();
    for (let i = 0; i < 10; i++) settings.zoomOut();
    expect(settings.zoomPercent).toBe(50);
    settings.resetZoom();
    expect(settings.zoomPercent).toBe(100);
  });

  it('cannot be stepped out of its bounds however long a key is held', () => {
    const settings = useSettingsStore();
    for (let i = 0; i < 50; i++) settings.zoomIn();
    expect(settings.zoomPercent).toBe(200);
    for (let i = 0; i < 50; i++) settings.zoomOut();
    expect(settings.zoomPercent).toBe(50);
  });

  it('persists a keyboard zoom, so it survives a restart like any setting', () => {
    // The chord path (main -> App.vue -> zoomIn) writes the SAME value the
    // settings panel shows, which is the whole design point.
    useSettingsStore().zoomIn();
    expect(stored()['zoomPercent']).toBe(110);
    setActivePinia(createPinia());
    expect(useSettingsStore().zoomPercent).toBe(110);
  });

  it('clamps a hand-edited zoom instead of discarding it', () => {
    localStorage.setItem(KEY, JSON.stringify({ zoomPercent: 5000 }));
    expect(useSettingsStore().zoomPercent).toBe(200);
  });

  it('falls back to 100% when the stored zoom is not a number', () => {
    localStorage.setItem(KEY, JSON.stringify({ zoomPercent: 'huge' }));
    expect(useSettingsStore().zoomPercent).toBe(100);
  });
});

describe('session roots', () => {
  it('defaults to an empty list, which means "derive roots from $HOME"', () => {
    expect(useSettingsStore().sessionRoots).toEqual([]);
  });

  it('hands every caller its own array, never the spec default itself', () => {
    // A shared reference here would let one mutation rewrite the default for
    // every future load — a bug that only shows up on the second boot.
    const a = settingsDefaults();
    a.sessionRoots.push('~/git');
    expect(settingsDefaults().sessionRoots).toEqual([]);
  });

  it('adds, normalises and persists a root', () => {
    const settings = useSettingsStore();
    expect(settings.addSessionRoot('  ~/git/  ')).toBe(true);
    expect(settings.sessionRoots).toEqual(['~/git']);
    expect(stored()['sessionRoots']).toEqual(['~/git']);
  });

  it('keeps registered order, which is what the panel renders in', () => {
    const settings = useSettingsStore();
    settings.addSessionRoot('~/tmp');
    settings.addSessionRoot('~/git');
    expect(settings.sessionRoots).toEqual(['~/tmp', '~/git']);
  });

  it('refuses a duplicate and a path anchored to nothing', () => {
    const settings = useSettingsStore();
    expect(settings.addSessionRoot('~/git')).toBe(true);
    expect(settings.addSessionRoot('~/git/')).toBe(false);
    expect(settings.addSessionRoot('git')).toBe(false);
    expect(settings.addSessionRoot('')).toBe(false);
    expect(settings.sessionRoots).toEqual(['~/git']);
  });

  it('removes by the stored spelling', () => {
    const settings = useSettingsStore();
    settings.addSessionRoot('~/git');
    settings.addSessionRoot('~/tmp');
    settings.removeSessionRoot('~/git');
    expect(settings.sessionRoots).toEqual(['~/tmp']);
    // A spelling that was never registered is a no-op, not an error.
    settings.removeSessionRoot('/home/alexey/tmp');
    expect(settings.sessionRoots).toEqual(['~/tmp']);
  });

  it('survives a restart', () => {
    useSettingsStore().addSessionRoot('~/git');
    setActivePinia(createPinia());
    expect(useSettingsStore().sessionRoots).toEqual(['~/git']);
  });

  it('degrades a corrupt list per ENTRY, not per key', () => {
    expect(coerceSettings({ sessionRoots: ['~/git', 7, 'relative', '~/tmp/'] }).sessionRoots).toEqual(
      ['~/git', '~/tmp'],
    );
  });

  it('falls back to the default when the value is not a list at all', () => {
    expect(coerceSettings({ sessionRoots: '~/git' }).sessionRoots).toEqual([]);
    expect(coerceSettings({ sessionRoots: null }).sessionRoots).toEqual([]);
  });

  it('keeps the rest of the blob when only the root list is corrupt', () => {
    const settings = coerceSettings({ sessionRoots: 3, defaultHost: 'hetzner' });
    expect(settings.sessionRoots).toEqual([]);
    expect(settings.defaultHost).toBe('hetzner');
  });
});

/**
 * The launch dialog's remembered answers. The defaults matter as much as the
 * degradation here: they are the helper's own (`[default: skip-permissions]`)
 * and the phone's first segment, so a fresh install opens the dialog exactly
 * where the phone's picker opens.
 */
describe('agentLaunchDefaults', () => {
  it('defaults to claude with skip-permissions ON and no profile', () => {
    const settings = useSettingsStore();
    expect(settings.agentLaunchDefaults).toEqual({
      kind: 'claude',
      skipPermissions: true,
      profiles: {},
    });
  });

  it('hands every caller its own object, never the spec default itself', () => {
    const a = settingsDefaults();
    a.agentLaunchDefaults.profiles['claude'] = 'Claude (Z.AI)';
    expect(settingsDefaults().agentLaunchDefaults.profiles).toEqual({});
  });

  it('round-trips a full choice', () => {
    const settings = useSettingsStore();
    settings.agentLaunchDefaults = {
      kind: 'codex',
      skipPermissions: false,
      profiles: { codex: 'work' },
    };
    expect(stored()['agentLaunchDefaults']).toEqual({
      kind: 'codex',
      skipPermissions: false,
      profiles: { codex: 'work' },
    });
  });

  it('drops a kind the helper cannot launch, keeping the other answers', () => {
    // `grok` is in SessionAgentKind but has no `pocketshell agent` subcommand,
    // so a blob naming it must not reach the command builder.
    const out = coerceSettings({
      agentLaunchDefaults: { kind: 'grok', skipPermissions: false, profiles: { claude: 'Z' } },
    }).agentLaunchDefaults;
    expect(out).toEqual({ kind: 'claude', skipPermissions: false, profiles: { claude: 'Z' } });
  });

  it('degrades a corrupt profile map per ENTRY', () => {
    expect(
      coerceSettings({
        agentLaunchDefaults: { kind: 'claude', profiles: { claude: 7, codex: '  ', x: ' ok ' } },
      }).agentLaunchDefaults,
    ).toEqual({ kind: 'claude', skipPermissions: true, profiles: { x: 'ok' } });
  });

  it('falls back wholesale only when the value is not an object', () => {
    expect(coerceSettings({ agentLaunchDefaults: 'claude' }).agentLaunchDefaults).toEqual({
      kind: 'claude',
      skipPermissions: true,
      profiles: {},
    });
  });

  it('keeps the rest of the blob when only this key is corrupt', () => {
    const settings = coerceSettings({ agentLaunchDefaults: 3, defaultHost: 'hetzner' });
    expect(settings.agentLaunchDefaults.kind).toBe('claude');
    expect(settings.defaultHost).toBe('hetzner');
  });
});
