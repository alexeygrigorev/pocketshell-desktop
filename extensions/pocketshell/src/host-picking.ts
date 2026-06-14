/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConnectionService } from './connection-service';
import type { SshConnection } from './backend/ssh/connection/ssh-client';

/**
 * Show a quick-pick to select a host from all configured hosts.
 * Returns the host id, or undefined if cancelled.
 */
export async function pickHost(service: ConnectionService): Promise<number | undefined> {
	const hosts = await service.getHosts();
	if (hosts.length === 0) {
		vscode.window.showWarningMessage(vscode.l10n.t('No hosts configured. Use "PocketShell: Add Host" first.'));
		return undefined;
	}

	const items = hosts.map(host => ({
		label: host.name || host.hostname,
		description: `${host.username}@${host.hostname}:${host.port}`,
		hostId: host.id,
	}));

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: vscode.l10n.t('Select a host'),
	});

	return picked?.hostId;
}

/**
 * Show a quick-pick to select from currently connected hosts.
 * Returns the host id, or undefined if cancelled.
 */
export async function pickConnectedHost(service: ConnectionService): Promise<number | undefined> {
	const hosts = await service.getHosts();
	const connected = hosts.filter(h => service.getConnection(h.id) !== null);
	if (connected.length === 0) {
		vscode.window.showWarningMessage(vscode.l10n.t('No active connections.'));
		return undefined;
	}

	const items = connected.map(host => ({
		label: host.name || host.hostname,
		description: `${host.username}@${host.hostname}:${host.port}`,
		hostId: host.id,
	}));

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: vscode.l10n.t('Select a host to disconnect'),
	});

	return picked?.hostId;
}

/**
 * Resolve a host id from a tree-item element (number or `{ id: number }`),
 * or fall back to a quick-pick. `connectedOnly` selects which quick-pick is shown.
 */
export async function resolveHostId(
	service: ConnectionService,
	element: unknown,
	opts: { connectedOnly?: boolean } = {},
): Promise<number | undefined> {
	if (typeof element === 'number') {
		return element;
	}
	if (element && typeof element === 'object' && 'id' in element) {
		return (element as { id: number }).id;
	}
	return opts.connectedOnly ? pickConnectedHost(service) : pickHost(service);
}

/**
 * Return an existing connection for `hostId`, or connect and return the new
 * connection. Shows a progress notification while connecting and an error
 * message on failure. Returns null on failure (UI already shown).
 */
export async function getOrConnect(service: ConnectionService, hostId: number): Promise<SshConnection | null> {
	const existing = service.getConnection(hostId);
	if (existing) {
		return existing;
	}

	const host = await service.getHost(hostId);
	const label = host?.name || host?.hostname || 'host';

	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: vscode.l10n.t('Connecting to {0}...', label),
				cancellable: false,
			},
			() => service.connect(hostId),
		);
		return service.getConnection(hostId);
	} catch (err) {
		vscode.window.showErrorMessage(
			vscode.l10n.t('Failed to connect to {0}: {1}', label, String(err)),
		);
		return null;
	}
}
