/**
 * Unit tests for settings import/export.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  exportToJson,
  exportToJsonString,
  validateImport,
  importFromJson,
  importFromJsonString,
} from '../../../../src/ui/settings/settings-serializer';
import {
  SettingsPanel,
  type SettingsStoreLike,
} from '../../../../src/ui/settings/settings-panel';

// ---------------------------------------------------------------------------
// Fake store
// ---------------------------------------------------------------------------

function createFakeStore(initial?: Record<string, unknown>): {
  store: SettingsStoreLike;
  state: Record<string, unknown>;
} {
  const state: Record<string, unknown> = { ...(initial ?? {}) };
  return {
    state,
    store: {
      get: () => ({ ...state }),
      update: (partial: Record<string, unknown>) => {
        Object.assign(state, partial);
      },
    },
  };
}

function createPanel(initial?: Record<string, unknown>) {
  const { store, state } = createFakeStore(initial);
  return { panel: new SettingsPanel(store), state };
}

describe('settings-serializer', () => {
  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  describe('exportToJson', () => {
    it('produces a serialized object with _version and settings', () => {
      const { panel } = createPanel({ fontSize: 16, autoConnect: true });
      const exported = exportToJson(panel);
      expect(exported._version).toBe(1);
      expect(exported.settings).toBeDefined();
      expect(exported.settings.fontSize).toBe(16);
      expect(exported.settings.autoConnect).toBe(true);
    });
  });

  describe('exportToJsonString', () => {
    it('produces valid JSON', () => {
      const { panel } = createPanel();
      const str = exportToJsonString(panel);
      const parsed = JSON.parse(str);
      expect(parsed._version).toBe(1);
    });

    it('is pretty-printed', () => {
      const { panel } = createPanel();
      const str = exportToJsonString(panel);
      expect(str).toContain('\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Validate
  // ---------------------------------------------------------------------------

  describe('validateImport', () => {
    it('accepts a well-formed import', () => {
      const json = {
        _version: 1,
        settings: { fontSize: 14, autoConnect: true },
      };
      const result = validateImport(json);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects a non-object root', () => {
      expect(validateImport(null).valid).toBe(false);
      expect(validateImport('string').valid).toBe(false);
      expect(validateImport(42).valid).toBe(false);
      expect(validateImport([]).valid).toBe(false);
    });

    it('rejects wrong _version', () => {
      const result = validateImport({ _version: 99, settings: {} });
      expect(result.valid).toBe(false);
      expect(result.errors[0].key).toBe('_version');
    });

    it('rejects missing or malformed settings object', () => {
      const r1 = validateImport({ _version: 1 });
      expect(r1.valid).toBe(false);

      const r2 = validateImport({ _version: 1, settings: 'nope' });
      expect(r2.valid).toBe(false);
    });

    it('rejects unknown keys', () => {
      const result = validateImport({
        _version: 1,
        settings: { totallyBogus: 42 },
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0].key).toBe('totallyBogus');
    });

    it('rejects type mismatches', () => {
      const result = validateImport({
        _version: 1,
        settings: { fontSize: 'not-a-number' },
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0].key).toBe('fontSize');
    });

    it('rejects enum values outside allowed set', () => {
      const result = validateImport({
        _version: 1,
        settings: { cursorStyle: 'invalid' },
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0].key).toBe('cursorStyle');
    });

    it('accepts valid enum values', () => {
      for (const val of ['block', 'underline', 'bar']) {
        const result = validateImport({
          _version: 1,
          settings: { cursorStyle: val },
        });
        expect(result.valid).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Import
  // ---------------------------------------------------------------------------

  describe('importFromJson', () => {
    it('applies valid settings to the panel', () => {
      const { panel, state } = createPanel();
      const result = importFromJson(
        { _version: 1, settings: { fontSize: 20, autoConnect: false } },
        panel,
      );
      expect(result.valid).toBe(true);
      expect(state.fontSize).toBe(20);
      expect(state.autoConnect).toBe(false);
    });

    it('does not apply settings when validation fails', () => {
      const { panel, state } = createPanel();
      const result = importFromJson(
        { _version: 1, settings: { fontSize: 'bad' } },
        panel,
      );
      expect(result.valid).toBe(false);
      expect(state.fontSize).toBeUndefined();
    });

    it('skips individual settings that fail panel-level validation', () => {
      const { panel, state } = createPanel();
      // fontSize 1 is out of the [6, 72] range — panel validation should reject it
      const result = importFromJson(
        { _version: 1, settings: { fontSize: 1, autoConnect: true } },
        panel,
      );
      // The import-level validation passes (types are correct), but panel
      // validation for the individual value should prevent applying fontSize.
      expect(state.autoConnect).toBe(true);
      // fontSize=1 passes type validation but should fail range validation
      // when updateValue is called, so it should not be persisted.
      expect(state.fontSize).toBeUndefined();
    });
  });

  describe('importFromJsonString', () => {
    it('parses and imports valid JSON', () => {
      const { panel, state } = createPanel();
      const result = importFromJsonString(
        '{"_version":1,"settings":{"shell":"/bin/zsh"}}',
        panel,
      );
      expect(result.valid).toBe(true);
      expect(state.shell).toBe('/bin/zsh');
    });

    it('rejects malformed JSON', () => {
      const { panel } = createPanel();
      const result = importFromJsonString('not json at all', panel);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toBe('Invalid JSON');
    });
  });

  // ---------------------------------------------------------------------------
  // Round-trip
  // ---------------------------------------------------------------------------

  describe('round-trip (export then import)', () => {
    it('settings survive an export/import cycle', () => {
      const { panel: srcPanel, state: srcState } = createPanel();
      srcPanel.updateValue('fontSize', 20);
      srcPanel.updateValue('autoConnect', false);
      srcPanel.updateValue('shell', '/bin/fish');
      srcPanel.updateValue('cursorStyle', 'underline');

      const exported = exportToJson(srcPanel);

      const { panel: dstPanel, state: dstState } = createPanel();
      const result = importFromJson(exported, dstPanel);

      expect(result.valid).toBe(true);
      expect(dstState.fontSize).toBe(20);
      expect(dstState.autoConnect).toBe(false);
      expect(dstState.shell).toBe('/bin/fish');
      expect(dstState.cursorStyle).toBe('underline');
    });
  });
});
