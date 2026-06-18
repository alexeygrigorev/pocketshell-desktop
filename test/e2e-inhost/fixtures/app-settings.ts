/**
 * Fixture: seed the PocketShell `settings.json` so `activate()` reads
 * `autoConnect: true` and `lastHostId: <fixture>` at launch.
 *
 * The extension loads settings from `<storageDir>/settings.json` where
 * `storageDir = context.globalStorageUri.fsPath`. Under a custom
 * `--user-data-dir=<X>`, that resolves to
 * `<X>/User/globalStorage/pocketshell.pocketshell/settings.json` (confirmed;
 * see `extension.ts:47,55`). This file must exist BEFORE launch so
 * `activate()` → `settings.load()` → `connector.run(appSettings)` picks the
 * `connect` startup action.
 *
 * The record is a valid `AppSettings` (see
 * `extensions/pocketshell/src/backend/app/settings.ts` `DEFAULT_SETTINGS`).
 * `SettingsStore.load()` does `{ ...DEFAULT_SETTINGS, ...parsed }`, so we only
 * need to set the fields under test plus a few sensible values; missing fields
 * fall back to defaults.
 */

import * as fs from 'fs';
import * as path from 'path';

/** The extension id whose globalStorage holds `settings.json`. */
export const EXTENSION_ID = 'pocketshell.pocketshell';

/**
 * Write a valid settings.json with autoConnect enabled and lastHostId set to
 * the fixture host.
 *
 * @returns the absolute path to the written settings.json.
 */
export function seedAppSettings(
	userDataDir: string,
	lastHostId: number,
): string {
	const storageDir = path.join(
		userDataDir,
		'User',
		'globalStorage',
		EXTENSION_ID,
	);
	fs.mkdirSync(storageDir, { recursive: true });

	const settingsPath = path.join(storageDir, 'settings.json');
	const settings = {
		autoConnect: true,
		lastHostId,
		restoreSessionOnStartup: false,
		sessionRestoreBehavior: 'ask',
		portForwardRestoreActiveTunnels: false,
		theme: 'dark',
		diagnosticsEnabled: false,
		diagnosticsMaxEvents: 1000,
		diagnosticsRedactionMode: 'balanced',
	};
	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

	return settingsPath;
}
