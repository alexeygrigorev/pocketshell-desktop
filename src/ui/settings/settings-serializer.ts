/**
 * Settings serializer — import/export utilities for settings JSON.
 *
 * All functions are pure and operate on the SettingsPanel interface.
 */

import { type SettingsPanel } from './settings-panel';
import { SETTING_MAP, getDefaultsMap } from './settings-schema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SerializedSettings {
  /** Schema version for forward-compatibility. */
  _version: number;
  settings: Record<string, unknown>;
}

export interface ImportValidationResult {
  valid: boolean;
  errors: Array<{ key: string; message: string }>;
}

// ---------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

const CURRENT_VERSION = 1;

// ---------------------------------------------------------------------------
// Export
// -------------------------------------------------------------------------

/**
 * Serialize all current settings to a JSON-compatible object.
 */
export function exportToJson(panel: SettingsPanel): SerializedSettings {
  return {
    _version: CURRENT_VERSION,
    settings: { ...panel.getValues() },
  };
}

/**
 * Produce a pretty-printed JSON string of the exported settings.
 */
export function exportToJsonString(panel: SettingsPanel): string {
  return JSON.stringify(exportToJson(panel), null, 2);
}

// ---------------------------------------------------------------------------
// Import validation
// -------------------------------------------------------------------------

/**
 * Validate a JSON object as a potential settings import, **without** applying
 * any changes.
 */
export function validateImport(json: unknown): ImportValidationResult {
  const errors: Array<{ key: string; message: string }> = [];

  // ---- Top-level shape ----
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { valid: false, errors: [{ key: '', message: 'Root must be an object' }] };
  }

  const obj = json as Record<string, unknown>;

  if (obj._version !== CURRENT_VERSION) {
    return {
      valid: false,
      errors: [{ key: '_version', message: `Unsupported version: ${obj._version}` }],
    };
  }

  if (obj.settings === null || typeof obj.settings !== 'object' || Array.isArray(obj.settings)) {
    return {
      valid: false,
      errors: [{ key: 'settings', message: '"settings" must be an object' }],
    };
  }

  const settings = obj.settings as Record<string, unknown>;

  // ---- Per-key checks ----
  for (const [key, value] of Object.entries(settings)) {
    const def = SETTING_MAP.get(key);
    if (!def) {
      errors.push({ key, message: `Unknown setting: ${key}` });
      continue;
    }

    // Type check
    if (def.type === 'boolean' && typeof value !== 'boolean') {
      errors.push({ key, message: `Expected boolean, got ${typeof value}` });
    } else if (def.type === 'number' && typeof value !== 'number') {
      errors.push({ key, message: `Expected number, got ${typeof value}` });
    } else if (def.type === 'string' && typeof value !== 'string') {
      errors.push({ key, message: `Expected string, got ${typeof value}` });
    } else if (def.type === 'enum') {
      if (typeof value !== 'string') {
        errors.push({ key, message: `Expected string (enum), got ${typeof value}` });
      } else if (def.enumValues && !def.enumValues.includes(value)) {
        errors.push({
          key,
          message: `Value "${value}" not in allowed values: ${def.enumValues.join(', ')}`,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Import
// -------------------------------------------------------------------------

/**
 * Validate and apply settings from a JSON object.
 *
 * Only known keys with valid values are applied; everything else is silently
 * skipped.  Returns the import validation result so the caller can show
 * warnings for skipped keys.
 */
export function importFromJson(json: unknown, panel: SettingsPanel): ImportValidationResult {
  const result = validateImport(json);
  if (!result.valid) {
    return result;
  }

  const obj = json as SerializedSettings;
  const settings = obj.settings;

  // Apply only known, valid keys
  for (const [key, value] of Object.entries(settings)) {
    const def = SETTING_MAP.get(key);
    if (!def) continue; // should not happen after validation, but guard anyway

    const errors = panel.getValidationErrors(key, value);
    if (errors.length === 0) {
      panel.updateValue(key, value);
    }
  }

  return result;
}

/**
 * Parse a JSON string and import settings.
 */
export function importFromJsonString(jsonStr: string, panel: SettingsPanel): ImportValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { valid: false, errors: [{ key: '', message: 'Invalid JSON' }] };
  }
  return importFromJson(parsed, panel);
}
