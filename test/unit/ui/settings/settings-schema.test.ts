/**
 * Unit tests for the settings schema definitions.
 */

import { describe, it, expect } from 'vitest';
import {
  ALL_SETTINGS,
  SETTING_MAP,
  getSettingsByCategory,
  getDefaultsMap,
  getCategoryOrder,
  type SettingCategory,
} from '../../../../src/ui/settings/settings-schema';

describe('settings-schema', () => {
  // ---------------------------------------------------------------------------
  // ALL_SETTINGS
  // ---------------------------------------------------------------------------

  describe('ALL_SETTINGS', () => {
    it('is a non-empty array', () => {
      expect(ALL_SETTINGS.length).toBeGreaterThan(0);
    });

    it('every entry has all required fields', () => {
      for (const s of ALL_SETTINGS) {
        expect(s.key).toBeTypeOf('string');
        expect(s.key.length).toBeGreaterThan(0);
        expect(s.label).toBeTypeOf('string');
        expect(s.description).toBeTypeOf('string');
        expect(['boolean', 'number', 'string', 'enum']).toContain(s.type);
        expect(['connection', 'terminal', 'agent', 'utility']).toContain(s.category);
        expect(s.defaultValue).toBeDefined();
        expect(Array.isArray(s.validation)).toBe(true);
      }
    });

    it('has unique keys', () => {
      const keys = ALL_SETTINGS.map((s) => s.key);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  // ---------------------------------------------------------------------------
  // Defaults
  // ---------------------------------------------------------------------------

  describe('defaults', () => {
    it('every default value matches the declared type', () => {
      for (const s of ALL_SETTINGS) {
        switch (s.type) {
          case 'boolean':
            expect(s.defaultValue).toBeTypeOf('boolean');
            break;
          case 'number':
            expect(s.defaultValue).toBeTypeOf('number');
            break;
          case 'string':
            expect(s.defaultValue).toBeTypeOf('string');
            break;
          case 'enum':
            expect(s.defaultValue).toBeTypeOf('string');
            expect(s.enumValues).toBeDefined();
            expect(s.enumValues!).toContain(s.defaultValue);
            break;
        }
      }
    });

    it('every default passes its own validation rules', () => {
      for (const s of ALL_SETTINGS) {
        for (const rule of s.validation) {
          if (s.type === 'number' && typeof s.defaultValue === 'number') {
            if (rule.min !== undefined) expect(s.defaultValue).toBeGreaterThanOrEqual(rule.min);
            if (rule.max !== undefined) expect(s.defaultValue).toBeLessThanOrEqual(rule.max);
          }
          if (s.type === 'string' && typeof s.defaultValue === 'string') {
            if (rule.pattern) expect(s.defaultValue).toMatch(new RegExp(rule.pattern));
          }
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Categories
  // ---------------------------------------------------------------------------

  describe('categories', () => {
    const expectedCategories: SettingCategory[] = ['connection', 'terminal', 'agent', 'utility'];

    it('all four categories are represented', () => {
      const present = new Set(ALL_SETTINGS.map((s) => s.category));
      for (const cat of expectedCategories) {
        expect(present.has(cat)).toBe(true);
      }
    });

    it('getSettingsByCategory returns only settings from that category', () => {
      for (const cat of expectedCategories) {
        const settings = getSettingsByCategory(cat);
        expect(settings.length).toBeGreaterThan(0);
        for (const s of settings) {
          expect(s.category).toBe(cat);
        }
      }
    });

    it('getCategoryOrder returns all categories in schema order', () => {
      const order = getCategoryOrder();
      expect(order).toEqual(expectedCategories);
    });
  });

  // ---------------------------------------------------------------------------
  // SETTING_MAP
  // ---------------------------------------------------------------------------

  describe('SETTING_MAP', () => {
    it('contains exactly the same keys as ALL_SETTINGS', () => {
      const allKeys = ALL_SETTINGS.map((s) => s.key);
      const mapKeys = Array.from(SETTING_MAP.keys());
      expect(mapKeys.sort()).toEqual(allKeys.sort());
    });

    it('getDefaultsMap returns a value for every setting', () => {
      const defaults = getDefaultsMap();
      for (const s of ALL_SETTINGS) {
        expect(defaults[s.key]).toBe(s.defaultValue);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Specific settings
  // ---------------------------------------------------------------------------

  describe('specific setting defaults', () => {
    it('connection defaults', () => {
      const conn = getSettingsByCategory('connection');
      const byKey = Object.fromEntries(conn.map((s) => [s.key, s.defaultValue]));
      expect(byKey['autoConnect']).toBe(true);
      expect(byKey['reconnectMaxAttempts']).toBe(5);
    });

    it('terminal defaults', () => {
      const term = getSettingsByCategory('terminal');
      const byKey = Object.fromEntries(term.map((s) => [s.key, s.defaultValue]));
      expect(byKey['fontSize']).toBe(14);
      expect(byKey['scrollback']).toBe(10000);
      expect(byKey['shell']).toBe('/bin/bash');
      expect(byKey['cursorStyle']).toBe('block');
    });

    it('agent defaults', () => {
      const agent = getSettingsByCategory('agent');
      const byKey = Object.fromEntries(agent.map((s) => [s.key, s.defaultValue]));
      expect(byKey['detectionInterval']).toBe(5000);
      expect(byKey['conversationAutoTail']).toBe(true);
      expect(byKey['maxConversations']).toBe(10);
    });

    it('utility defaults', () => {
      const util = getSettingsByCategory('utility');
      const byKey = Object.fromEntries(util.map((s) => [s.key, s.defaultValue]));
      expect(byKey['usageRefreshInterval']).toBe(60000);
      expect(byKey['logMaxLines']).toBe(5000);
    });
  });
});
