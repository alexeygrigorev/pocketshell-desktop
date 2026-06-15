/**
 * Unit tests for SettingsPanel.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  SettingsPanel,
  type SettingsStoreLike,
} from '../../../../src/ui/settings/settings-panel';
import { ALL_SETTINGS } from '../../../../src/ui/settings/settings-schema';

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

describe('SettingsPanel', () => {
  // ---------------------------------------------------------------------------
  // getSections
  // ---------------------------------------------------------------------------

  describe('getSections', () => {
    it('returns all schema sections', () => {
      const { store } = createFakeStore();
      const panel = new SettingsPanel(store);
      const sections = panel.getSections();
      expect(sections).toHaveLength(8);
    });

    it('sections are in schema order', () => {
      const { store } = createFakeStore();
      const panel = new SettingsPanel(store);
      const cats = panel.getSections().map((s) => s.category);
      expect(cats).toEqual([
        'connection',
        'terminal',
        'tmux',
        'agent',
        'usage',
        'helper',
        'diagnostics',
        'utility',
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // getValues
  // ---------------------------------------------------------------------------

  describe('getValues', () => {
    it('returns current store values', () => {
      const { store } = createFakeStore({ fontSize: 18, autoConnect: false });
      const panel = new SettingsPanel(store);
      const values = panel.getValues();
      expect(values.fontSize).toBe(18);
      expect(values.autoConnect).toBe(false);
    });

    it('merges schema defaults with sparse store values', () => {
      const { store } = createFakeStore({ fontSize: 18 });
      const panel = new SettingsPanel(store);
      const values = panel.getValues();
      expect(values.fontSize).toBe(18);
      expect(values.autoConnect).toBe(true);
      expect(values.theme).toBe('dark');
    });
  });

  // ---------------------------------------------------------------------------
  // updateValue
  // ---------------------------------------------------------------------------

  describe('updateValue', () => {
    it('persists a valid value and returns no errors', () => {
      const { store, state } = createFakeStore();
      const panel = new SettingsPanel(store);
      const errors = panel.updateValue('fontSize', 16);
      expect(errors).toHaveLength(0);
      expect(state.fontSize).toBe(16);
    });

    it('rejects an invalid value and returns errors without persisting', () => {
      const { store, state } = createFakeStore();
      const panel = new SettingsPanel(store);
      const errors = panel.updateValue('fontSize', 1);
      expect(errors.length).toBeGreaterThan(0);
      expect(state.fontSize).toBeUndefined();
    });

    it('rejects invalid boolean values without explicit validation rules', () => {
      const { store, state } = createFakeStore();
      const panel = new SettingsPanel(store);
      const errors = panel.updateValue('autoConnect', 'false');
      expect(errors.length).toBeGreaterThan(0);
      expect(state.autoConnect).toBeUndefined();
    });

    it('rejects invalid enum values without explicit validation rules', () => {
      const { store, state } = createFakeStore();
      const panel = new SettingsPanel(store);
      const errors = panel.updateValue('cursorStyle', 'box');
      expect(errors.length).toBeGreaterThan(0);
      expect(state.cursorStyle).toBeUndefined();
    });

    it('persists all schema-supported setting value types', () => {
      const { store, state } = createFakeStore();
      const panel = new SettingsPanel(store);

      expect(panel.updateValue('restoreSessionOnStartup', false)).toHaveLength(0);
      expect(panel.updateValue('tmuxDefaultSessionName', 'work')).toHaveLength(0);
      expect(panel.updateValue('tmuxAttachBehavior', 'create-new')).toHaveLength(0);
      expect(panel.updateValue('usageHistoryLimit', 250)).toHaveLength(0);
      expect(panel.updateValue('lastHostId', null)).toHaveLength(0);

      expect(state.restoreSessionOnStartup).toBe(false);
      expect(state.tmuxDefaultSessionName).toBe('work');
      expect(state.tmuxAttachBehavior).toBe('create-new');
      expect(state.usageHistoryLimit).toBe(250);
      expect(state.lastHostId).toBeNull();
    });

    it('rejects an unknown key', () => {
      const { store } = createFakeStore();
      const panel = new SettingsPanel(store);
      const errors = panel.updateValue('nonexistent', 42);
      expect(errors.length).toBeGreaterThan(0);
    });

    it('notifies listeners on successful update', () => {
      const { store } = createFakeStore();
      const panel = new SettingsPanel(store);
      const listener = vi.fn();
      panel.subscribe(listener);

      panel.updateValue('autoConnect', false);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith('autoConnect', false);
    });

    it('does not notify listeners on failed validation', () => {
      const { store } = createFakeStore();
      const panel = new SettingsPanel(store);
      const listener = vi.fn();
      panel.subscribe(listener);

      panel.updateValue('fontSize', -10);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // resetToDefaults
  // ---------------------------------------------------------------------------

  describe('resetToDefaults', () => {
    it('resets all settings to schema defaults', () => {
      const { store, state } = createFakeStore({ fontSize: 99, autoConnect: false });
      const panel = new SettingsPanel(store);

      panel.resetToDefaults();

      expect(state.fontSize).toBe(14);
      expect(state.autoConnect).toBe(true);
      expect(state.scrollback).toBe(10000);
      expect(state.cursorStyle).toBe('block');
      expect(state.tmuxDefaultSessionName).toBe('pocketshell');
      expect(state.helperCommand).toBe('pocketshell');
      expect(state.diagnosticsRedactionMode).toBe('balanced');
    });

    it('notifies listeners for every setting', () => {
      const { store } = createFakeStore();
      const panel = new SettingsPanel(store);
      const listener = vi.fn();
      panel.subscribe(listener);

      panel.resetToDefaults();

      expect(listener).toHaveBeenCalledTimes(ALL_SETTINGS.length);
    });
  });

  // ---------------------------------------------------------------------------
  // getValidationErrors
  // ---------------------------------------------------------------------------

  describe('getValidationErrors', () => {
    it('returns no errors for a valid value', () => {
      const { store } = createFakeStore();
      const panel = new SettingsPanel(store);
      expect(panel.getValidationErrors('fontSize', 14)).toHaveLength(0);
    });

    it('returns errors for an invalid value', () => {
      const { store } = createFakeStore();
      const panel = new SettingsPanel(store);
      const errors = panel.getValidationErrors('fontSize', 200);
      expect(errors.length).toBeGreaterThan(0);
    });

    it('returns errors for invalid direct boolean and enum values', () => {
      const { store } = createFakeStore();
      const panel = new SettingsPanel(store);
      expect(panel.getValidationErrors('autoConnect', 1).length).toBeGreaterThan(0);
      expect(panel.getValidationErrors('cursorStyle', 'box').length).toBeGreaterThan(0);
    });

    it('returns an error for an unknown key', () => {
      const { store } = createFakeStore();
      const panel = new SettingsPanel(store);
      const errors = panel.getValidationErrors('bogus', 1);
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // subscribe
  // ---------------------------------------------------------------------------

  describe('subscribe', () => {
    it('returns an unsubscribe function', () => {
      const { store } = createFakeStore();
      const panel = new SettingsPanel(store);
      const listener = vi.fn();
      const unsub = panel.subscribe(listener);

      panel.updateValue('autoConnect', false);
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();

      panel.updateValue('autoConnect', true);
      expect(listener).toHaveBeenCalledTimes(1); // not called again
    });

    it('supports multiple listeners', () => {
      const { store } = createFakeStore();
      const panel = new SettingsPanel(store);
      const l1 = vi.fn();
      const l2 = vi.fn();
      panel.subscribe(l1);
      panel.subscribe(l2);

      panel.updateValue('shell', '/bin/zsh');

      expect(l1).toHaveBeenCalledTimes(1);
      expect(l2).toHaveBeenCalledTimes(1);
    });
  });
});
