/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import type { FeatureDeps } from '../manifest';
import {
	decideStartupAction,
	type StartupAction,
	type StartupHost,
} from '../../backend/startup';

// ---------------------------------------------------------------------------
// Settings bridge
// ---------------------------------------------------------------------------

/**
 * Minimal read view over the persisted PocketShell app settings.
 *
 * The pure decider only needs `autoConnect` and `lastHostId`. We model the
 * dependency as a narrow structural interface (rather than importing the
 * vscode-adjacent `src/app/settings` `SettingsStore`) so the integration step
 * can pass either a real `SettingsStore` or a thin adapter. The structural
 * `get()` shape matches {@link FeatureDeps.getSettings} when it returns the
 * full AppSettings record.
 */
export interface StartupSettingsSource {
	/** Current auto-connect setting (null/undefined treated as false). */
	autoConnect: boolean | undefined;
	/** Last-connected host id hint (null/undefined treated as null). */
	lastHostId: number | null | undefined;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Resolves the startup action for the current settings + host list and runs it.
 *
 *   - `connect` → fires `pocketshell.surface.connect` with the host id.
 *   - `pick`    → shows a quick-pick of host labels, then fires
 *                 `pocketshell.surface.connect` with the chosen id on selection
 *                 (dismiss is a no-op).
 *   - `noop`    → does nothing.
 *
 * `pocketshell.surface.connect` accepts a `Host | number` (see
 * `feature/surface/surface-commands.ts` → `resolveHostId`); we pass a bare
 * `number`, which `resolveHostId` returns directly.
 */
export class StartupAutoConnector {
	constructor(
		private readonly service: ConnectionService,
	) {}

	/** Read inputs, decide, and execute the resulting action. */
	async run(settings: StartupSettingsSource): Promise<StartupAction> {
		const hosts = await this.toStartupHosts(await this.service.getHosts());

		const action = decideStartupAction({
			autoConnect: settings.autoConnect === true,
			lastHostId: settings.lastHostId ?? null,
			hosts,
		});

		switch (action.kind) {
			case 'connect':
				await vscode.commands.executeCommand('pocketshell.surface.connect', action.hostId);
				break;
			case 'pick':
				await this.pickAndConnect(action.hosts);
				break;
			case 'noop':
				break;
		}

		return action;
	}

	/**
	 * Show a quick-pick of the available hosts and connect to the chosen one.
	 * Dismissal (undefined) is a silent no-op.
	 */
	private async pickAndConnect(hosts: StartupHost[]): Promise<void> {
		const items = hosts.map((host) => ({
			label: host.name || host.hostname,
			description: `${host.username}@${host.hostname}:${host.port}`,
			hostId: host.id,
		}));

		const picked = await vscode.window.showQuickPick(items, {
			placeHolder: vscode.l10n.t('Select a host to connect to'),
		});
		if (!picked) {
			return;
		}
		await vscode.commands.executeCommand('pocketshell.surface.connect', picked.hostId);
	}

	/** Narrow the richer Host type to the structural subset the decider needs. */
	private toStartupHosts(hosts: { id: number; name: string; hostname: string; username: string; port: number }[]): StartupHost[] {
		return hosts.map((host) => ({
			id: host.id,
			name: host.name,
			hostname: host.hostname,
			username: host.username,
			port: host.port,
		}));
	}
}

// ---------------------------------------------------------------------------
// Feature registration hook (deferred wiring)
// ---------------------------------------------------------------------------

/**
 * Deferred-wire hook for the startup auto-connect feature.
 *
 * Returns a tuple `[disposables, connector]`: the connector is constructed
 * here but NOT run — the "run on startup" trigger is deferred to the
 * integration step (`extension.ts` activate()), which decides when activation
 * is complete and then `await connector.run(settings)`.
 *
 * This hook owns no manifest/commands/views, so it is NOT added to `FEATURES`.
 * It is invoked inline from `extension.ts` (mirroring
 * `registerPocketshellSettings`), which destructures the connector.
 *
 * @returns `[Disposable[], StartupAutoConnector]`. The disposables array is
 *          currently always empty (the feature registers no commands/views);
 *          returned for shape compatibility and to leave room for future
 *          disposables (e.g. a settings-change listener that re-runs the
 *          decision) without changing the signature.
 */
export function registerStartupAutoConnect(
	service: ConnectionService,
	_ctx: vscode.ExtensionContext,
	_deps: FeatureDeps,
): [vscode.Disposable[], StartupAutoConnector] {
	const disposables: vscode.Disposable[] = [];
	const connector = new StartupAutoConnector(service);
	return [disposables, connector];
}

// Re-export the pure types for convenience.
export type { StartupAction, StartupHost };
