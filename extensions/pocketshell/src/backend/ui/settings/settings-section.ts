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
  type SettingValue,
  ALL_SETTINGS,
  validateSettingValue,
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
    defaultValue: SettingValue;
    enumValues?: string[];
  }>;
}

// ---------------------------------------------------------------------------
// Category display names
// ---------------------------------------------------------------------------

const CATEGORY_TITLES: Record<SettingCategory, string> = {
  connection: 'Connection',
  terminal: 'Terminal',
  tmux: 'tmux',
  agent: 'Agent',
  usage: 'Usage',
  helper: 'Helper',
  diagnostics: 'Diagnostics',
  utility: 'Utility',
  assistant: 'Assistant',
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
      for (const rule of validateSettingValue(def, value)) {
        errors.push({ key: def.key, rule, value });
      }
    }

    return errors;
  }
}
