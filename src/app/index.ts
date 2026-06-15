/**
 * App module barrel export.
 *
 * Exposes the settings store, auto-connect service, and startup orchestrator.
 */

export { SettingsStore, DEFAULT_SETTINGS, type AppSettings } from './settings';
export { AutoConnectService, type AutoConnectEvent } from './auto-connect';
export { initializeApp, type AppContext } from './startup';
