/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * In-app extension-delta updater wiring (#96).
 *
 * This is the extension-host glue between the pure updater backend
 * (`backend/updates/updater.ts`) and the VS Code UX. It owns:
 *
 *   - Reading the running app's `baseVersion` + `currentVersion` (the contract
 *     the release.yml implementer fills via `base-version.json`).
 *   - The activate-time auto check (gated by `autoUpdateCheckOnStartup` AND
 *     by `POCKETSHELL_E2E=1` so E2E never hits the network or pops a modal).
 *   - Two manual commands: `pocketshell.update.check` and
 *     `pocketshell.update.apply`.
 *
 * Everything is wrapped so the updater can never throw into `activate()`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { SettingsStore, type AppSettings } from '../../backend/app/settings';
import { checkForUpdate, applyUpdate, type UpdateManifest } from '../../backend/updates/updater';

// ---------------------------------------------------------------------------
// Constants & contracts
// ---------------------------------------------------------------------------

/**
 * Release channel: the `latest.json` manifest is attached to the latest
 * GitHub release (uploaded by `.github/workflows/release.yml`).
 */
const MANIFEST_URL =
	'https://github.com/alexeygrigorev/pocketshell-desktop/releases/latest/download/latest.json';

/**
 * Full-download URL shown to the user when only a base (core) update is
 * possible — delta cannot apply because the VS Code/Electron core changed.
 */
const FULL_DOWNLOAD_URL =
	'https://github.com/alexeygrigorev/pocketshell-desktop/releases/latest';

/**
 * Sentinel baseVersion used when the build-time `base-version.json` is absent
 * (dev runs, E2E, or a build that predates the release.yml contract). The
 * backend treats this as an opaque string compared for equality against the
 * manifest's `baseVersion`, so a delta built against a real base will simply
 * report `base-mismatch` in dev — the expected, safe behavior.
 */
const DEV_BASE_VERSION = 'dev';

/**
 * Shape of the build-time `base-version.json` written into the extension
 * folder by `.github/workflows/release.yml`.
 */
interface BaseVersionFile {
	baseVersion: string;
}

// ---------------------------------------------------------------------------
// Runtime version reading
// ---------------------------------------------------------------------------

/**
 * Resolve the running app's base version.
 *
 * Reads `<extensionPath>/base-version.json` if present (written at build time
 * by release.yml); otherwise falls back to the `'dev'` sentinel.
 *
 * @param context The extension context (`context.extensionPath` is the ext dir).
 */
export function readRuntimeBaseVersion(context: vscode.ExtensionContext): string {
	const file = path.join(context.extensionPath, 'base-version.json');
	try {
		if (!fs.existsSync(file)) {
			return DEV_BASE_VERSION;
		}
		const raw = fs.readFileSync(file, 'utf-8');
		const parsed = JSON.parse(raw) as Partial<BaseVersionFile>;
		if (parsed && typeof parsed.baseVersion === 'string' && parsed.baseVersion.trim().length > 0) {
			return parsed.baseVersion;
		}
		return DEV_BASE_VERSION;
	} catch {
		return DEV_BASE_VERSION;
	}
}

/**
 * Resolve the running extension version from its package.json.
 *
 * Passed through verbatim; the backend's `isNewer` is numeric-tuple tolerant
 * so leading `v` / non-semver values degrade safely to 0.0.0.
 */
function readRuntimeAppVersion(context: vscode.ExtensionContext): string {
	const pkg = context.extension?.packageJSON as { version?: string } | undefined;
	return pkg?.version ?? '0.0.0';
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * Wires the extension-delta updater into VS Code.
 *
 * Constructed once in `activate()` with the live {@link SettingsStore}; the
 * auto check is fired fire-and-forget, and two manual commands are registered
 * via {@link register}.
 */
export class UpdateController {
	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly settings: SettingsStore,
	) {}

	// --- activate-time auto check ------------------------------------------

	/**
	 * Run a single update check, surfacing a message only when an update is
	 * available or a full download is required. Never throws.
	 *
	 * Skipped silently when the user has disabled auto checks
	 * (`autoUpdateCheckOnStartup === false`).
	 *
	 * CRITICAL: the activate-time call site MUST additionally guard on
	 * `process.env.POCKETSHELL_E2E === '1'` to keep E2E offline/modal-free.
	 * That guard lives in `activate()`, not here, so manual commands can still
	 * run the same path when explicitly invoked.
	 */
	async checkAndNotify(): Promise<void> {
		try {
			if (this.settings.get().autoUpdateCheckOnStartup === false) {
				return;
			}
			await this.runCheck({ silentWhenCurrent: true });
		} catch {
			// Never propagate to activate().
		}
	}

	/**
	 * Shared check + notify core.
	 *
	 * @param silentWhenCurrent When true (auto path), `up-to-date` and
	 *   `check-failed` produce no message. When false (manual path), a brief
	 *   informational message is shown for `up-to-date`.
	 */
	private async runCheck(opts: { silentWhenCurrent: boolean }): Promise<void> {
		const currentVersion = readRuntimeAppVersion(this.context);
		const currentBaseVersion = readRuntimeBaseVersion(this.context);

		const result = await checkForUpdate(MANIFEST_URL, {
			currentVersion,
			currentBaseVersion,
		});

		switch (result.status) {
			case 'available': {
				const manifest = result.manifest as UpdateManifest;
				const choice = await vscode.window.showInformationMessage(
					`PocketShell ${manifest.version} is available. Update now?`,
					'Update',
					'Later',
				);
				if (choice === 'Update') {
					await this.applyAndReload(manifest);
				}
				return;
			}
			case 'base-mismatch':
			case 'below-min-app': {
				const choice = await vscode.window.showInformationMessage(
					'A full PocketShell update is available — the app core changed.',
					'Download',
				);
				if (choice === 'Download') {
					await vscode.env.openExternal(vscode.Uri.parse(FULL_DOWNLOAD_URL));
				}
				return;
			}
			case 'up-to-date': {
				if (!opts.silentWhenCurrent) {
					vscode.window.showInformationMessage('PocketShell is up to date.');
				}
				return;
			}
			case 'check-failed':
			default: {
				// Silent: never nag the user about a failed check.
				return;
			}
		}
	}

	/**
	 * Download, verify, and install the delta, then reload the window so the
	 * new extension code loads. Errors are surfaced via a modal message.
	 */
	private async applyAndReload(manifest: UpdateManifest): Promise<void> {
		try {
			await applyUpdate(manifest, this.context.extensionPath);
			await vscode.commands.executeCommand('workbench.action.reloadWindow');
		} catch (err) {
			vscode.window.showErrorMessage(
				`PocketShell update failed: ${String(err)}`,
			);
		}
	}

	// --- manual commands ----------------------------------------------------

	/**
	 * Register the two manual update commands and return their disposables.
	 *
	 *   - `pocketshell.update.check` — check, ignoring the setting, inform even
	 *     when up-to-date.
	 *   - `pocketshell.update.apply` — check; if available, apply + reload.
	 */
	register(): vscode.Disposable[] {
		const checkCmd = vscode.commands.registerCommand(
			'pocketshell.update.check',
			async () => {
				try {
					await this.runCheck({ silentWhenCurrent: false });
				} catch (err) {
					vscode.window.showErrorMessage(
						`PocketShell update check failed: ${String(err)}`,
					);
				}
			},
		);

		const applyCmd = vscode.commands.registerCommand(
			'pocketshell.update.apply',
			async () => {
				try {
					const currentVersion = readRuntimeAppVersion(this.context);
					const currentBaseVersion = readRuntimeBaseVersion(this.context);
					const result = await checkForUpdate(MANIFEST_URL, {
						currentVersion,
						currentBaseVersion,
					});
					if (result.status === 'available' && result.manifest) {
						await this.applyAndReload(result.manifest);
					} else {
						// Reuse the messaging path so base-mismatch / below-min-app
						// still surface their Download prompt.
						await this.runCheck({ silentWhenCurrent: false });
					}
				} catch (err) {
					vscode.window.showErrorMessage(
						`PocketShell update failed: ${String(err)}`,
					);
				}
			},
		);

		return [checkCmd, applyCmd];
	}
}

// ---------------------------------------------------------------------------
// Settings TestBridge (E2E only — see issue #89)
// ---------------------------------------------------------------------------

/**
 * Register test-only commands exposing the live {@link SettingsStore}.
 *
 * These are registered ONLY when `process.env.POCKETSHELL_E2E === '1'` so the
 * in-host E2E suite can read and mutate settings to verify the settings
 * write-path. They are harmless in normal use but intentionally not surfaced
 * to users (no titles in the command palette; registered purely as RPC
 * endpoints for the test driver).
 *
 *   - `pocketshell.__test.settings.get`    → returns a JSON snapshot.
 *   - `pocketshell.__test.settings.update` → merges a partial, returns the
 *     new snapshot.
 */
export function registerSettingsTestBridge(
	settings: SettingsStore,
): vscode.Disposable[] {
	if (process.env.POCKETSHELL_E2E !== '1') {
		return [];
	}
	const getCmd = vscode.commands.registerCommand(
		'pocketshell.__test.settings.get',
		(): AppSettings => settings.get(),
	);
	const updateCmd = vscode.commands.registerCommand(
		'pocketshell.__test.settings.update',
		(partial: Record<string, unknown>): AppSettings => {
			settings.update(partial as Partial<AppSettings>);
			return settings.get();
		},
	);
	return [getCmd, updateCmd];
}
