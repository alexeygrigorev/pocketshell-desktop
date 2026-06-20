/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConnectionService } from './connection-service';
import type { Host } from './backend/ssh/data/host-store';
import { ConnectionState } from './backend/ssh/connection/connection-manager';

/**
 * Tree data provider for the SSH Hosts sidebar — the PocketShell **landing
 * surface** (#98).
 *
 * Mirrors the PocketShell Android app's `HostListScreen`: every host from
 * `~/.ssh/config` is a row showing the host alias, a `user@host:port`
 * description, and a connection-status badge. Selecting (clicking) a host runs
 * the app-faithful flow: **connect → reveal that server's sessions** (the
 * `pocketshell.sessions` canonical session tree). Host detail / direct terminal
 * remain available as explicit inline actions.
 */
export class HostTreeProvider implements vscode.TreeDataProvider<Host> {
	private readonly changeEmitter = new vscode.EventEmitter<Host | Host[] | undefined | null>();
	readonly onDidChangeTreeData: vscode.Event<Host | Host[] | undefined | null> = this.changeEmitter.event;

	constructor(private readonly service: ConnectionService) {}

	/** Trigger a refresh of the tree view. */
	refresh(): void {
		this.changeEmitter.fire(undefined);
	}

	getTreeItem(host: Host): vscode.TreeItem {
		const state = this.service.getState(host.id);
		const badge = buildHostStatusBadge(state);

		const label = host.name || host.hostname;
		const address = `${host.username}@${host.hostname}:${host.port}`;
		// Description = address + status badge (matches the app's card subtitle).
		const description = `${address} · ${badge.label}`;

		const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
		item.description = description;
		item.tooltip = `${label}\n${address}\nStatus: ${badge.label}`;

		// Status icon
		item.iconPath = new vscode.ThemeIcon(badge.icon, badge.color ? new vscode.ThemeColor(badge.color) : undefined);

		// Click -> connect (idempotent) and reveal THAT server's sessions.
		// This is the app's "tap a host -> connect -> FolderList" flow; the
		// host-detail webview and explicit connect remain inline actions.
		item.command = {
			command: 'pocketshell.connect',
			title: vscode.l10n.t('Connect'),
			arguments: [host.id],
		};

		item.contextValue = state === ConnectionState.Connected ? 'connectedHost' : 'disconnectedHost';

		return item;
	}

	getChildren(_element?: Host): Thenable<Host[]> {
		return this.service.getHosts();
	}
}

// ---------------------------------------------------------------------------
// Pure status-badge builder
// ---------------------------------------------------------------------------

export interface HostStatusBadge {
	/** Short human-readable status label (shown in the row description). */
	label: string;
	/** Theme icon id for the row. */
	icon: string;
	/** Optional theme color id (e.g. 'issuesStatus.warningForeground'). */
	color?: string;
}

/**
 * Map a host's {@link ConnectionState} to the app-parity status badge.
 *
 * The PocketShell Android app's host-card badge values are:
 * `Unknown / NoActiveSessions / N sessions / Attached / NeedsSetup /
 * ConnectionError`. The desktop's connection layer only models the transport
 * state (not session counts or setup state), so this maps to the closest
 * transport-equivalent badge. Pure + side-effect free so it can be unit-tested
 * directly.
 */
export function buildHostStatusBadge(state: ConnectionState): HostStatusBadge {
	switch (state) {
		case ConnectionState.Connected:
			return { label: vscode.l10n.t('Connected'), icon: 'plug', color: 'testing.iconPassed' };
		case ConnectionState.Connecting:
			return { label: vscode.l10n.t('Connecting…'), icon: 'loading~spin' };
		case ConnectionState.Disconnecting:
			return { label: vscode.l10n.t('Disconnecting…'), icon: 'loading~spin' };
		case ConnectionState.Error:
			return { label: vscode.l10n.t('Error'), icon: 'error', color: 'testing.iconFailed' };
		case ConnectionState.Disconnected:
			return { label: vscode.l10n.t('Disconnected'), icon: 'circle-slash' };
		case ConnectionState.Idle:
		default:
			// App-equivalent: "Unknown" — never connected this session.
			return { label: vscode.l10n.t('Unknown'), icon: 'server' };
	}
}
