/**
 * SettingsPanel — orchestrates sections, values, validation, and persistence.
 *
 * Accepts a SettingsStore-like interface as a constructor parameter so the
 * panel stays decoupled from the concrete store implementation.
 */

import {
  SETTING_MAP,
  getDefaultsMap,
  getCategoryOrder,
} from './settings-schema';
import { SettingsSection, type ValidationError } from './settings-section';

// ---------------------------------------------------------------------------
// Store interface (decoupled from concrete SettingsStore)
// ---------------------------------------------------------------------------

export interface SettingsStoreLike {
  get(): Record<string, unknown>;
  update(partial: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Listener type
// ---------------------------------------------------------------------------

export type SettingsChangeListener = (changedKey: string, newValue: unknown) => void;

// ---------------------------------------------------------------------------
// SettingsPanel
// ---------------------------------------------------------------------------

export class SettingsPanel {
  private store: SettingsStoreLike;
  private sections: SettingsSection[];
  private listeners: Set<SettingsChangeListener> = new Set();

  constructor(store: SettingsStoreLike) {
    this.store = store;
    this.sections = getCategoryOrder().map(
      (cat) => new SettingsSection(cat),
    );
  }

  // -------------------------------------------------------------------------
  // Sections
  // -------------------------------------------------------------------------

  /** Return all sections (in schema order). */
  getSections(): SettingsSection[] {
    return this.sections;
  }

  // -------------------------------------------------------------------------
  // Values
  // -------------------------------------------------------------------------

  /** Return the current values for all settings, sourced from the store. */
  getValues(): Record<string, unknown> {
    return { ...getDefaultsMap(), ...this.store.get() };
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  /**
   * Validate and persist a single setting change.
   *
   * @returns an array of validation errors (empty on success).
   */
  updateValue(key: string, value: unknown): ValidationError[] {
    const def = SETTING_MAP.get(key);
    if (!def) {
      return [{ key, rule: { message: `Unknown setting key: ${key}` }, value }];
    }

    // Find the section that owns this key and validate.
    const section = this.sections.find((s) =>
      s.settings.some((sd) => sd.key === key),
    );
    if (section) {
      const errors = section.validate({ [key]: value });
      if (errors.length > 0) {
        return errors;
      }
    }

    // Persist
    this.store.update({ [key]: value });

    // Notify listeners
    for (const cb of this.listeners) {
      cb(key, value);
    }

    return [];
  }

  // -------------------------------------------------------------------------
  // Reset
  // -------------------------------------------------------------------------

  /** Reset all settings to their schema-defined defaults. */
  resetToDefaults(): void {
    const defaults = getDefaultsMap();
    this.store.update(defaults);

    // Notify listeners for every key
    for (const key of Object.keys(defaults)) {
      for (const cb of this.listeners) {
        cb(key, defaults[key]);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  /**
   * Return validation errors for a single setting, given a candidate value.
   *
   * Does **not** persist the value — purely a check.
   */
  getValidationErrors(key: string, value: unknown): ValidationError[] {
    const def = SETTING_MAP.get(key);
    if (!def) {
      return [{ key, rule: { message: `Unknown setting key: ${key}` }, value }];
    }

    const section = this.sections.find((s) =>
      s.settings.some((sd) => sd.key === key),
    );
    return section ? section.validate({ [key]: value }) : [];
  }

  // -------------------------------------------------------------------------
  // Subscribe
  // -------------------------------------------------------------------------

  /**
   * Register a listener that is called whenever a setting value changes.
   *
   * @returns an unsubscribe function.
   */
  subscribe(callback: SettingsChangeListener): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }
}
