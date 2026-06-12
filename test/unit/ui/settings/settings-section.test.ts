/**
 * Unit tests for SettingsSection.
 */

import { describe, it, expect } from 'vitest';
import { SettingsSection, type ValidationError } from '../../../../src/ui/settings/settings-section';
import { type SettingCategory } from '../../../../src/ui/settings/settings-schema';

describe('SettingsSection', () => {
  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  describe('construction', () => {
    it('creates a section with the correct category and title', () => {
      const section = new SettingsSection('connection');
      expect(section.category).toBe('connection');
      expect(section.title).toBe('Connection');
    });

    it('populates settings from the global schema when none are provided', () => {
      const section = new SettingsSection('terminal');
      expect(section.settings.length).toBeGreaterThan(0);
      for (const s of section.settings) {
        expect(s.category).toBe('terminal');
      }
    });

    it('uses provided settings when given', () => {
      const section = new SettingsSection('connection', [
        {
          key: 'customKey',
          label: 'Custom',
          description: 'A custom setting for testing.',
          type: 'boolean',
          category: 'connection',
          defaultValue: false,
          validation: [],
        },
      ]);
      expect(section.settings).toHaveLength(1);
      expect(section.settings[0].key).toBe('customKey');
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  describe('render', () => {
    it('returns a plain object with title, category, and settings array', () => {
      const section = new SettingsSection('terminal');
      const rendered = section.render();

      expect(rendered.title).toBe('Terminal');
      expect(rendered.category).toBe('terminal');
      expect(Array.isArray(rendered.settings)).toBe(true);
    });

    it('every rendered setting has the expected fields', () => {
      const section = new SettingsSection('agent');
      const rendered = section.render();

      for (const s of rendered.settings) {
        expect(s.key).toBeTypeOf('string');
        expect(s.label).toBeTypeOf('string');
        expect(s.description).toBeTypeOf('string');
        expect(s.type).toBeTypeOf('string');
        expect(s.defaultValue).toBeDefined();
      }
    });

    it('includes enumValues only for enum-type settings', () => {
      const section = new SettingsSection('terminal');
      const rendered = section.render();

      const cursor = rendered.settings.find((s) => s.key === 'cursorStyle')!;
      expect(cursor.enumValues).toEqual(['block', 'underline', 'bar']);

      const fontSize = rendered.settings.find((s) => s.key === 'fontSize')!;
      expect(fontSize.enumValues).toBeUndefined();
    });

    it('rendered settings count matches section settings count', () => {
      const section = new SettingsSection('connection');
      expect(section.render().settings).toHaveLength(section.settings.length);
    });
  });

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  describe('validate', () => {
    it('returns no errors for valid default values', () => {
      const section = new SettingsSection('connection');
      const defaults = Object.fromEntries(
        section.settings.map((s) => [s.key, s.defaultValue]),
      );
      const errors = section.validate(defaults);
      expect(errors).toHaveLength(0);
    });

    it('returns errors for out-of-range numbers', () => {
      const section = new SettingsSection('terminal');
      const errors = section.validate({ fontSize: 2 });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].key).toBe('fontSize');
    });

    it('returns errors for strings that violate a pattern', () => {
      const section = new SettingsSection('terminal');
      const errors = section.validate({ shell: 'not-an-absolute-path' });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].key).toBe('shell');
    });

    it('returns no errors when values are valid', () => {
      const section = new SettingsSection('terminal');
      const errors = section.validate({
        fontSize: 16,
        scrollback: 5000,
        shell: '/bin/zsh',
        cursorStyle: 'bar',
      });
      expect(errors).toHaveLength(0);
    });

    it('ignores unknown keys', () => {
      const section = new SettingsSection('connection');
      const errors = section.validate({ unknownSetting: 42 });
      expect(errors).toHaveLength(0);
    });

    it('returns no errors for null/undefined values (rules do not enforce presence)', () => {
      const section = new SettingsSection('connection');
      const errors = section.validate({ reconnectMaxAttempts: undefined });
      expect(errors).toHaveLength(0);
    });

    it('validates all settings in the section at once', () => {
      const section = new SettingsSection('terminal');
      const errors = section.validate({
        fontSize: 2,     // invalid
        scrollback: 50,  // invalid
        shell: '/bin/sh',
        cursorStyle: 'bar',
      });
      expect(errors).toHaveLength(2);
      const keys = errors.map((e) => e.key);
      expect(keys).toContain('fontSize');
      expect(keys).toContain('scrollback');
    });
  });

  // ---------------------------------------------------------------------------
  // All categories
  // ---------------------------------------------------------------------------

  const categories: SettingCategory[] = ['connection', 'terminal', 'agent', 'utility'];
  for (const cat of categories) {
    describe(`category "${cat}"`, () => {
      it('can be instantiated and rendered', () => {
        const section = new SettingsSection(cat);
        const rendered = section.render();
        expect(rendered.category).toBe(cat);
        expect(rendered.settings.length).toBeGreaterThan(0);
      });
    });
  }
});
