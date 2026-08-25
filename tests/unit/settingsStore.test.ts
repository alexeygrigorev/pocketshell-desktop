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

  it('rejects a non-string, non-null defaultHost', () => {
    expect(coerceSettings({ defaultHost: 7 }).defaultHost).toBeNull();
    expect(coerceSettings({ defaultHost: null }).defaultHost).toBeNull();
    expect(coerceSettings({ defaultHost: 'hetzner' }).defaultHost).toBe('hetzner');
  });
});
