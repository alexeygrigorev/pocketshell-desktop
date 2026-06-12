/**
 * SettingsSection — a named group of related settings.
 *
 * Provides rendering (plain-object representation for the UI layer to consume)
 * and bulk validation of all settings in the group.
 */

import {
  type SettingDefinition,
  type SettingCategory,
  type ValidationRule,
  ALL_SETTINGS,
  SETTING_MAP,
} from './settings-schema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Validation error for a single setting. */
export interface ValidationError {
  key: string;
  rule: ValidationRule;
  value: unknown;
}

/** Rendered representation of a section (plain object, no DOM). */
export interface RenderedSection {
  title: string;
  category: SettingCategory;
  settings: Array<{
    key: string;
    label: string;
    description: string;
    type: string;
    defaultValue: boolean | number | string;
    enumValues?: string[];
  }>;
}

// ---------------------------------------------------------------------------
// Category display names
// ---------------------------------------------------------------------------

const CATEGORY_TITLES: Record<SettingCategory, string> = {
  connection: 'Connection',
  terminal: 'Terminal',
  agent: 'Agent',
  utility: 'Utility',
};

// ---------------------------------------------------------------------------
// SettingsSection class
// ---------------------------------------------------------------------------

export class SettingsSection {
  /** Human-readable section title. */
  public readonly title: string;

  /** Category this section represents. */
  public readonly category: SettingCategory;

  /** Setting definitions belonging to this section. */
  public readonly settings: ReadonlyArray<SettingDefinition>;

  constructor(category: SettingCategory, settings?: SettingDefinition[]) {
    this.category = category;
    this.title = CATEGORY_TITLES[category] ?? category;
    this.settings = settings ?? ALL_SETTINGS.filter((s) => s.category === category);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /**
   * Return a structured plain-object representation of the section.
   *
   * This is **not** a DOM node — it is a serialisable description that the
   * UI layer (React, Vue, or hand-rolled DOM) can consume to build widgets.
   */
  render(): RenderedSection {
    return {
      title: this.title,
      category: this.category,
      settings: this.settings.map((s) => ({
        key: s.key,
        label: s.label,
        description: s.description,
        type: s.type,
        defaultValue: s.defaultValue,
        ...(s.enumValues ? { enumValues: s.enumValues } : {}),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  /**
   * Validate the supplied values against every setting in the section.
   *
   * @param values — a key→value map.  Only keys belonging to this section are
   *   checked; unknown keys are silently ignored.
   * @returns an array of validation errors (empty when everything is valid).
   */
  validate(values: Record<string, unknown>): ValidationError[] {
    const errors: ValidationError[] = [];

    for (const def of this.settings) {
      const value = values[def.key];
      for (const rule of def.validation) {
        if (!this._passesRule(value, def.type, rule)) {
          errors.push({ key: def.key, rule, value });
        }
      }
    }

    return errors;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private _passesRule(value: unknown, type: string, rule: ValidationRule): boolean {
    if (value === undefined || value === null) {
      // Absent values are handled by the caller; rules do not enforce presence.
      return true;
    }

    if (type === 'number') {
      if (typeof value !== 'number') return false;
      if (rule.min !== undefined && value < rule.min) return false;
      if (rule.max !== undefined && value > rule.max) return false;
    }

    if (type === 'string') {
      if (typeof value !== 'string') return false;
      if (rule.pattern && !new RegExp(rule.pattern).test(value)) return false;
      if (rule.minLength !== undefined && value.length < rule.minLength) return false;
      if (rule.maxLength !== undefined && value.length > rule.maxLength) return false;
    }

    return true;
  }
}
