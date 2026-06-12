/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConnectionService } from './connection-service';
import { SshPseudoterminal } from './ssh-terminal';
import { SftpFsProvider } from './sftp-fs-provider';
import { HostTreeProvider } from './host-tree-provider';
import type { NewHost } from './backend/ssh/data/host-store';

/**
 * Extension entry point.
 *
 * Registers:
 *   - Terminal profile provider for "pocketshell.ssh"
 *   - FileSystemProvider for "pocketshell" scheme
 *   - TreeDataProvider for the host list sidebar
 *   - Commands: connect, addHost, disconnect
 */
export function activate(context: vscode.ExtensionContext): void {
	const service = ConnectionService.getInstance();

	// -- Terminal profile provider -----------------------------------------------

	const profileProvider: vscode.TerminalProfileProvider = {
		async provideTerminalProfile(_token: vscode.CancellationToken): Promise<vscode.TerminalProfile> {
			const hosts = await service.getHosts();
			if (hosts.length === 0) {
				throw new Error(vscode.l10n.t('No hosts configured. Use "PocketShell: Add Host" first.'));
			}

			// Use the first host as the default for the profile.
			// Users can pick a specific host via the "Connect to Host" command.
			const host = hosts[0];
			const conn = service.getConnection(host.id);

			if (!conn) {
				// Not connected yet — prompt the user to connect first.
				throw new Error(vscode.l10n.t('Not connected to {0}. Use "PocketShell: Connect to Host" first.', host.name || host.hostname));
			}

			return new vscode.TerminalProfile({
				name: `PocketShell: ${host.name || host.hostname}`,
				pty: new SshPseudoterminal(conn, host.name || host.hostname),
				iconPath: new vscode.ThemeIcon('remote'),
			});
		},
	};

	context.subscriptions.push(
		vscode.window.registerTerminalProfileProvider('pocketshell.ssh', profileProvider),
	);

	// -- FileSystem provider -----------------------------------------------------

	const fsProvider = new SftpFsProvider(service);
	context.subscriptions.push(
		vscode.workspace.registerFileSystemProvider('pocketshell', fsProvider, {
			isCaseSensitive: true,
			isReadonly: false,
		}),
	);

	// -- Host tree view ----------------------------------------------------------

	const treeProvider = new HostTreeProvider(service);
	const treeView = vscode.window.createTreeView('pocketshell.hosts', {
		treeDataProvider: treeProvider,
		showCollapseAll: false,
	});
	context.subscriptions.push(treeView);

	// -- Commands ----------------------------------------------------------------

	// Connect to a host (optionally passed hostId from tree item click)
	context.subscriptions.push(
		vscode.commands.registerCommand('pocketshell.connect', async (hostId?: number) => {
			const id = hostId ?? await pickHost(service);
			if (id === undefined) {
				return;
			}

			const host = await service.getHost(id);
			if (!host) {
				vscode.window.showErrorMessage(vscode.l10n.t('Host not found.'));
				return;
			}

			// Check if already connected
			let conn = service.getConnection(id);
			if (!conn) {
				try {
					await vscode.window.withProgress(
						{
							location: vscode.ProgressLocation.Notification,
							title: vscode.l10n.t('Connecting to {0}...', host.name || host.hostname),
							cancellable: false,
						},
						() => service.connect(id),
					);
					conn = service.getConnection(id);
				} catch (err) {
					vscode.window.showErrorMessage(
						vscode.l10n.t('Failed to connect to {0}: {1}', host.name || host.hostname, String(err)),
					);
					return;
				}
			}

			// Open terminal
			if (conn) {
				const pty = new SshPseudoterminal(conn, host.name || host.hostname);
				const terminal = vscode.window.createTerminal({
					name: `PocketShell: ${host.name || host.hostname}`,
					pty,
					iconPath: new vscode.ThemeIcon('remote'),
				});
				terminal.show();
			}

			// Refresh tree to show updated status
			treeProvider.refresh();
		}),
	);

	// Add a new host
	context.subscriptions.push(
		vscode.commands.registerCommand('pocketshell.addHost', async () => {
			const name = await vscode.window.showInputBox({
				placeHolder: vscode.l10n.t('My Server'),
				prompt: vscode.l10n.t('Host display name'),
			});
			if (name === undefined) {
				return;
			}

			const hostname = await vscode.window.showInputBox({
				placeHolder: vscode.l10n.t('example.com'),
				prompt: vscode.l10n.t('Hostname or IP address'),
			});
			if (hostname === undefined) {
				return;
			}

			const portStr = await vscode.window.showInputBox({
				placeHolder: '22',
				prompt: vscode.l10n.t('SSH port'),
				value: '22',
			});
			if (portStr === undefined) {
				return;
			}
			const port = parseInt(portStr, 10);
			if (isNaN(port) || port <= 0) {
				vscode.window.showErrorMessage(vscode.l10n.t('Invalid port number.'));
				return;
			}

			const username = await vscode.window.showInputBox({
				placeHolder: vscode.l10n.t('user'),
				prompt: vscode.l10n.t('SSH username'),
			});
			if (username === undefined) {
				return;
			}

			const newHost: NewHost = {
				name: name || hostname,
				hostname,
				port,
				username,
				keyPath: '~/.ssh/id_rsa', // v0.1.0: uses default key
				maxAutoPort: 10000,
				skipPortsBelow: 1000,
				scanIntervalSec: 5,
				enabled: true,
			};

			try {
				const id = await service.addHost(newHost);
				vscode.window.showInformationMessage(
					vscode.l10n.t('Host "{0}" added (id={1}).', newHost.name, String(id)),
				);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Failed to add host: {0}', String(err)),
				);
				return;
			}

			treeProvider.refresh();
		}),
	);

	// Disconnect from a host
	context.subscriptions.push(
		vscode.commands.registerCommand('pocketshell.disconnect', async (hostId?: number) => {
			const id = hostId ?? await pickConnectedHost(service);
			if (id === undefined) {
				return;
			}

			service.disconnect(id);
			treeProvider.refresh();
			vscode.window.showInformationMessage(vscode.l10n.t('Disconnected.'));
		}),
	);

	// -- Cleanup on deactivate ---------------------------------------------------

	context.subscriptions.push({
		dispose: () => service.dispose(),
	});
}

/**
 * Show a quick-pick to select a host from all configured hosts.
 * Returns the host id, or undefined if cancelled.
 */
async function pickHost(service: ConnectionService): Promise<number | undefined> {
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
async function pickConnectedHost(service: ConnectionService): Promise<number | undefined> {
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
