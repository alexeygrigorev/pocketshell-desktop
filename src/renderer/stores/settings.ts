import { defineStore } from 'pinia';
import { reactive, toRefs, watch } from 'vue';
import {
  EDITOR_FONT_SIZE_DEFAULT,
  parseFontSize,
  sanitiseFontFamily,
  TERMINAL_FONT_SIZE_DEFAULT,
} from '../fonts';

/**
 * App-level preferences — the settings screen's model.
 *
 * "App-level" is the whole point of this store existing separately. The
 * composer store already persists preferences, but they are preferences ABOUT
 * THE COMPOSER, written by the composer as a side effect of using it (where
 * the card sits, whether it is open). What lives here is the other kind: things
 * the user goes somewhere to *decide*, which no feature writes on its own, and
 * which a feature elsewhere then obeys. Keeping those in the feature stores is
 * how preferences ended up scattered across `pocketshell.composer.*` and a bare
 * `pocketshell.sessionPanelWidth` key inside a view — three storage schemes for
 * one idea.
 *
 * ---------------------------------------------------------------------------
 * HOW TO ADD A SETTING — three lines, one place each, and nothing else.
 * ---------------------------------------------------------------------------
 *   1. Add the field to {@link AppSettings}. That is the type the whole app
 *      sees; `toRefs` below means the store exposes it automatically, so
 *      `useSettingsStore().myNewKey` starts working with no other change.
 *   2. Add one entry to {@link SETTING_SPECS} — its default and its parser.
 *      The parser is what makes a hand-edited or half-written blob survivable:
 *      a value that fails it falls back to that key's default and the REST OF
 *      THE BLOB IS STILL HONOURED. Never write a parser that trusts the stored
 *      type; it is user-writable JSON on disk, not a value we produced.
 *   3. Render a control for it in `views/SettingsView.vue`.
 * There is no fourth step: persistence, restore and validation are generic over
 * the specs, so nothing here needs touching per key.
 *
 * ---------------------------------------------------------------------------
 * WHY localStorage AND NOT electron-store
 * ---------------------------------------------------------------------------
 * `electron-store` is already a dependency and is already used in main
 * (src/main/portfwd/PortfwdStore.ts), so it was the obvious candidate. It is
 * the wrong tool here for two reasons:
 *
 *   - It lives in the MAIN process. The renderer is sandboxed
 *     (contextIsolation, no node integration), so reaching it means a new pair
 *     of IPC channels and an inherently ASYNC read. Settings are read during
 *     the first render — `defaultHost` decides whether the host picker even
 *     appears — so an async read means either an await before mount or a frame
 *     of wrong UI. localStorage is synchronous and available at store
 *     construction, which is exactly the shape this data needs.
 *   - The composer store already established the convention for renderer-owned
 *     preferences (a versioned key, a tolerant loader, a silent failure path).
 *     A second mechanism for the same class of data would leave the app with
 *     two answers to "where are preferences?", which is the problem this store
 *     is meant to end.
 *
 * The rule that falls out: preferences the RENDERER owns live here; anything
 * main must read at boot (window bounds, forward rules) stays in electron-store
 * where main can reach it without a renderer being alive.
 */

/**
 * Every app-level preference, in one shape.
 *
 * `typingOpensComposer` and `closeComposerOnSend` are consumed by the prompt
 * composer, which owns its own files; this store only holds the answers. The
 * names are a contract with that code — do not rename them here.
 */
export interface AppSettings {
  /**
   * Typing into the terminal opens the prompt composer and routes the
   * keystrokes into it, instead of sending them to the remote shell.
   */
  typingOpensComposer: boolean;
  /** The composer closes itself after a send, reopening the next time you type. */
  closeComposerOnSend: boolean;
  /**
   * `Host` alias (as it appears in ~/.ssh/config) to connect to on launch, or
   * null to always start on the host picker. A name that no longer resolves to
   * a config host is NOT an error and is NOT rewritten — see
   * `src/renderer/autoConnect.ts`.
   */
  defaultHost: string | null;
  /**
   * One monospace family for every mono surface — terminal, file editor and the
   * app's mono chrome alike — or null for the shipped stack. Stored as a bare
   * family NAME, never a stack: `src/renderer/fonts.ts` appends the fallbacks,
   * which is what stops an uninstalled choice landing on a proportional face.
   */
  monospaceFontFamily: string | null;
  /** Terminal cell size, in px. Changing it re-fits the PTY's rows/columns. */
  terminalFontSize: number;
  /** File-editor text size, in px. Separate from the terminal's — see fonts.ts. */
  editorFontSize: number;
}

/**
 * One setting's default and its parser. `parse` returns `undefined` for a value
 * that cannot be trusted, which the loader reads as "use the default".
 */
interface SettingSpec<K extends keyof AppSettings> {
  default: AppSettings[K];
  parse: (raw: unknown) => AppSettings[K] | undefined;
}

type SettingSpecs = { [K in keyof AppSettings]: SettingSpec<K> };

function asBoolean(raw: unknown): boolean | undefined {
  return typeof raw === 'boolean' ? raw : undefined;
}

/**
 * A host alias, or null. An empty/whitespace string is normalised to null
 * rather than rejected: "" is what a `<select>` bound to a nullable value can
 * emit, and it means the same thing the user meant — no default host.
 */
function asHostAlias(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/** The registry the loader, the defaults and the validator are all generic over. */
export const SETTING_SPECS: SettingSpecs = {
  // Both composer defaults are TRUE: typing into a terminal that fronts an
  // agent is far more often the start of a prompt than a shell command, and a
  // composer that clears itself out of the way after sending is what makes the
  // terminal readable while the agent answers.
  typingOpensComposer: { default: true, parse: asBoolean },
  closeComposerOnSend: { default: true, parse: asBoolean },
  defaultHost: { default: null, parse: asHostAlias },
  // Typography. Every default here is EXACTLY what shipped before the setting
  // existed — the shipped stack, TERMINAL_OPTIONS.fontSize, and the `--fs-300`
  // the editor theme has always used — so upgrading changes nothing on screen
  // until the user asks for a change.
  monospaceFontFamily: { default: null, parse: sanitiseFontFamily },
  terminalFontSize: { default: TERMINAL_FONT_SIZE_DEFAULT, parse: parseFontSize },
  editorFontSize: { default: EDITOR_FONT_SIZE_DEFAULT, parse: parseFontSize },
};

const STORAGE_KEY = 'pocketshell.settings.v1';

/**
 * The setting names, typed. `Object.keys` widens to `string[]`, and this is the
 * one place that narrowing is asserted rather than proved — everything
 * downstream stays generic in a single key and is checked normally.
 */
function settingKeys(): (keyof AppSettings)[] {
  return Object.keys(SETTING_SPECS) as (keyof AppSettings)[];
}

/**
 * Per-key writes live in these two helpers, each generic in ONE key `K`. That
 * is what keeps the loops below type-safe without a cast per assignment:
 * `SETTING_SPECS[key]` is `SettingSpec<K>`, so its `default` and its `parse`
 * result are exactly `AppSettings[K]` and the target slot accepts them.
 */
function applyDefault<K extends keyof AppSettings>(out: Partial<AppSettings>, key: K): void {
  out[key] = SETTING_SPECS[key].default;
}

function applyParsed<K extends keyof AppSettings>(
  out: Partial<AppSettings>,
  key: K,
  raw: unknown,
): void {
  const parsed = SETTING_SPECS[key].parse(raw);
  // `undefined` is the spec's "do not trust this"; every other value —
  // `false`, `null`, `''` — is a legitimate stored setting, so the check is
  // against undefined specifically and never a truthiness test.
  if (parsed === undefined) return;
  out[key] = parsed;
}

/** A fresh, fully-defaulted settings object. */
export function settingsDefaults(): AppSettings {
  const out: Partial<AppSettings> = {};
  for (const key of settingKeys()) applyDefault(out, key);
  // Every key of AppSettings was just written, which the loop cannot prove to
  // the compiler; this is the assertion of that fact and the only one here.
  return out as AppSettings;
}

/**
 * Turn whatever was on disk into a complete {@link AppSettings}.
 *
 * Degradation is per key, not per blob. A single bad value — a hand edit, a
 * field whose type changed across versions, a truncated write — must not cost
 * the user every other preference they set, so each key is parsed on its own
 * and only the failures fall back. Unknown keys are dropped: they are either
 * from a newer build or from a rename, and neither is something this build can
 * act on.
 */
export function coerceSettings(raw: unknown): AppSettings {
  const out = settingsDefaults();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  const source = raw as Record<string, unknown>;
  for (const key of settingKeys()) {
    if (!(key in source)) continue;
    applyParsed(out, key, source[key]);
  }
  return out;
}

function load(): AppSettings {
  if (typeof localStorage === 'undefined') return settingsDefaults();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return settingsDefaults();
    return coerceSettings(JSON.parse(raw));
  } catch {
    // Corrupt JSON, or a profile we cannot read. Booting with defaults beats
    // not booting: this store is constructed before the first render.
    return settingsDefaults();
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const values = reactive<AppSettings>(load());

  /**
   * Written on EVERY mutation, synchronously (`flush: 'sync'`).
   *
   * The composer debounces its writes because it persists on every keystroke.
   * Settings change when a human clicks a switch — a handful of times a
   * session — so there is nothing to coalesce, and a synchronous write means
   * the value is durable the moment the user sees the control move. It also
   * means no persistence is lost if the window is closed in the same tick.
   */
  watch(
    values,
    () => {
      if (typeof localStorage === 'undefined') return;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
      } catch {
        // Quota, or a locked profile. Losing a preference on restart is not
        // worth throwing out of a click handler.
      }
    },
    { deep: true, flush: 'sync' },
  );

  /**
   * Type-safe generic write, for call sites that are themselves generic (a
   * settings row rendered from a list, a future import/restore). Direct
   * assignment — `settings.defaultHost = 'hetzner'` — is equally valid and is
   * what the hand-written controls use.
   */
  function set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    values[key] = value;
  }

  // `toRefs` is what makes step 1 of "how to add a setting" sufficient: every
  // key of AppSettings becomes a writable ref on the store automatically, so
  // consumers write `useSettingsStore().typingOpensComposer` and nothing in
  // this file enumerates the keys by hand.
  return { ...toRefs(values), set };
});
