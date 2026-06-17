/**
 * Pure settings model: read/write/validate against a `ConfigStore`.
 *
 * No vscode import. The feature provider injects a vscode-backed
 * `ConfigStore`; tests inject an in-memory fake. All validation and
 * coercion lives here so it is exhaustively unit-tested.
 */

import type { ConfigStore, SettingDefinition, SettingValue, ValidationResult } from './types';
import {
  CATEGORY_ORDER,
  CATEGORY_TITLES,
  POCKETSHELL_SETTINGS,
  getSettingDefinition,
} from './schema';

/**
 * Coerce an arbitrary stored value to the declared type, defaulting on
 * type mismatch. Strings/numbers are accepted only when they match the
 * declared primitive; everything else falls back to the default.
 */
export function coerceValue(def: SettingDefinition, raw: unknown): SettingValue {
  switch (def.type) {
    case 'boolean':
      return typeof raw === 'boolean' ? raw : def.defaultValue;
    case 'number': {
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        return raw;
      }
      if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
        return Number(raw);
      }
      return def.defaultValue;
    }
    case 'enum':
      return typeof raw === 'string' && def.enumValues?.includes(raw)
        ? raw
        : def.defaultValue;
    case 'string':
      return typeof raw === 'string' ? raw : def.defaultValue;
    default:
      return def.defaultValue;
  }
}

/**
 * Validate a candidate value against a setting's rules.
 *
 * Checks: non-null, correct type, enum membership, and numeric bounds.
 * Returns `{ ok: true }` on success or `{ ok: false, error }` with a
 * human-readable reason. Empty strings are allowed for free-form string
 * settings (e.g. defaultShell) but rejected for enum settings.
 */
export function validateValue(def: SettingDefinition, value: unknown): ValidationResult {
  if (value === null || value === undefined) {
    return { ok: false, error: `${def.label} must not be empty.` };
  }

  switch (def.type) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        return { ok: false, error: `${def.label} must be true or false.` };
      }
      return { ok: true };

    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, error: `${def.label} must be a number.` };
      }
      if (def.min !== undefined && value < def.min) {
        return { ok: false, error: `${def.label} must be at least ${def.min}.` };
      }
      if (def.max !== undefined && value > def.max) {
        return { ok: false, error: `${def.label} must be at most ${def.max}.` };
      }
      return { ok: true };
    }

    case 'string':
      if (typeof value !== 'string') {
        return { ok: false, error: `${def.label} must be text.` };
      }
      return { ok: true };

    case 'enum': {
      if (typeof value !== 'string' || value === '') {
        return { ok: false, error: `${def.label} must not be empty.` };
      }
      if (!def.enumValues || !def.enumValues.includes(value)) {
        return {
          ok: false,
          error: `${def.label} must be one of: ${(def.enumValues ?? []).join(', ')}.`,
        };
      }
      return { ok: true };
    }

    default:
      return { ok: false, error: `Unknown setting type for ${def.label}.` };
  }
}

/** A single setting as rendered in the view: definition + effective value. */
export interface SettingEntry {
  def: SettingDefinition;
  value: SettingValue;
  /** True when an explicit user/workspace value exists (not the default). */
  isExplicit: boolean;
}

/** All entries grouped by category, in display order. */
export interface SettingsSnapshot {
  categories: {
    category: keyof typeof CATEGORY_TITLES;
    title: string;
    entries: SettingEntry[];
  }[];
}

/**
 * Read the entire setting set from a `ConfigStore`, applying defaults and
 * coercion for any malformed stored values. Grouped by category in the
 * canonical display order.
 */
export function readSettings(store: ConfigStore): SettingsSnapshot {
  const categories = CATEGORY_ORDER.map((category) => {
    const entries = POCKETSHELL_SETTINGS.filter((def) => def.category === category).map(
      (def) => {
        const isExplicit = store.has(def.key);
        const raw = isExplicit ? store.get<SettingValue>(def.key) : undefined;
        const value = coerceValue(def, raw);
        return { def, value, isExplicit };
      },
    );
    return { category, title: CATEGORY_TITLES[category], entries };
  });

  return { categories };
}

/**
 * Validate and persist one setting.
 *
 * Coerces the candidate to the declared type, validates it, and — only on
 * success — writes it via the store. Returns the validation result so the
 * caller can surface errors in the UI without an exception.
 */
export async function writeSetting(
  store: ConfigStore,
  key: string,
  candidate: unknown,
): Promise<ValidationResult & { applied?: SettingValue }> {
  const def = getSettingDefinition(key);
  if (!def) {
    return { ok: false, error: `Unknown setting: ${key}` };
  }

  const coerced = coerceValue(def, candidate);
  const result = validateValue(def, coerced);
  if (!result.ok) {
    return result;
  }

  await store.update(key, coerced);
  return { ok: true, applied: coerced };
}

/**
 * Reset a setting to its default by deleting the explicit value.
 *
 * Implementations whose `ConfigStore` cannot truly delete a key may instead
 * write the default; both produce the same effective value via `coerceValue`.
 */
export async function resetSetting(
  store: ConfigStore,
  key: string,
): Promise<ValidationResult> {
  const def = getSettingDefinition(key);
  if (!def) {
    return { ok: false, error: `Unknown setting: ${key}` };
  }
  await store.update(key, def.defaultValue);
  return { ok: true };
}
