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
 * Matches the {@link FeatureRegistration.register} shape
 * `(service, ctx, deps) => vscode.Disposable[]` so the integration step can
 * either call it inline from `extension.ts` or add a `STARTUP_FEATURE`
 * `FeatureRegistration` to `FEATURES`.
 *
 * This hook does NOT run the connector itself — the "run on startup" trigger
 * is deferred to the integration step (which decides when activation /
 * host-tree readiness has occurred). It only constructs the connector and
 * exposes it so the caller can `await connector.run(deps)` at the right time.
 *
 * The constructed connector is stashed on `ctx` via a typed extension so a
 * later integration step can retrieve it without re-reading deps.
 *
 * @returns A `Disposable[]` (possibly empty). Currently always empty because
 *          this feature registers no commands/views/listeners of its own; the
 *          array is returned for shape compatibility and to leave room for
 *          future disposables (e.g. a settings-change listener that re-runs
 *          the decision) without changing the signature.
 */
export function registerStartupAutoConnect(
	service: ConnectionService,
	_ctx: vscode.ExtensionContext,
	deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	// Build the connector eagerly; the integration step reads it back and
	// invokes run() once the host tree / activation is ready.
	const connector = new StartupAutoConnector(service);

	// Surface the connector through deps so the integration step can drive it.
	// (FeatureDeps is an open record type; we attach without mutating input.)
	(deps as FeatureDeps & { startupConnector?: StartupAutoConnector }).startupConnector = connector;

	return disposables;
}

// Re-export the pure types for convenience.
export type { StartupAction, StartupHost };
