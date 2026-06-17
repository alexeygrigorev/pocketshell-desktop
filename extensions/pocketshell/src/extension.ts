/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConnectionService } from './connection-service';
import { SftpFsProvider } from './sftp-fs-provider';
import { HostTreeProvider } from './host-tree-provider';
import { pickHost, resolveHostId } from './host-picking';
import { FEATURES, type FeatureDeps } from './feature';
import { registerPocketshellSettings } from './feature/settings';
import { registerStartupAutoConnect } from './feature/startup';
import { resolveHostsFromConfig, type SkippedHost } from './backend/ssh/data/ssh-host-resolver';
import { parseSshConfig } from './backend/ssh/data/ssh-config-parser';
import { SettingsStore, type AppSettings } from './backend/app/settings';
import { SettingsPanel, type SettingsStoreLike } from './backend/ui/settings/settings-panel';
import type { SettingDefinition } from './backend/ui/settings/settings-schema';
import { buildHostDetailModel, renderHostDetailHtml, type HostDetailTmuxPane } from './backend/ui/host-detail';
import type { Host, NewHost } from './backend/ssh/data/host-store';
import type { WatchedFolder } from './backend/ssh/data/watched-folder-store';
import type { SshKey } from './backend/ssh/data/key-store';
import { assignManagedKeyToHost, createHostKeyAssignmentPlan } from './backend/ssh/data/key-assignment';
import {
	DiagnosticsEventStore,
	buildDiagnosticsReport,
	normalizeDiagnosticError,
	type DiagnosticRecordInput,
	type DiagnosticsConfig,
} from './backend/diagnostics';
import type { FeatureRegistration } from './feature/manifest';
import { PortForwardManager } from './backend/port-forwarding';

/**
 * Extension entry point.
 *
 * Registers:
 *   - FileSystemProvider for "pocketshell" scheme
 *   - TreeDataProvider for the host list sidebar
 *   - Commands: connect, addHost, disconnect, editHost, deleteHost, openRemoteFile
 */
export function activate(context: vscode.ExtensionContext): void {
	// Storage dir follows VS Code's user-data-dir (--user-data-dir in dev)
	const storageDir = context.globalStorageUri.fsPath;
	fs.mkdirSync(storageDir, { recursive: true });

	const service = ConnectionService.getInstance();
	service.setStorageDir(storageDir);
	const portForwardManager = new PortForwardManager({
		connections: service.connectionManager,
	});
	const settings = new SettingsStore(path.join(storageDir, 'settings.json'));
	const appSettings = settings.load();
	const diagnostics = new DiagnosticsEventStore(settingsToDiagnosticsConfig(appSettings));
	const recordDiagnostics = (input: DiagnosticRecordInput): void => {
		diagnostics.record(input);
	};
	service.setDiagnosticsRecorder(recordDiagnostics);
	recordDiagnostics({
		category: 'app',
		name: 'extension_activated',
		metadata: {
			storagePath: storageDir,
			extensionPath: context.extensionPath,
		},
	});
	service.setPassphraseProvider(async (host) => vscode.window.showInputBox({
		prompt: vscode.l10n.t('Passphrase for SSH key used by {0}', host.name || host.hostname),
		password: true,
		ignoreFocusOut: true,
	}));
	const unhandledExceptionListener = (err: Error): void => {
		recordDiagnostics({
			category: 'extension',
			name: 'uncaught_exception',
			metadata: normalizeDiagnosticError(err),
		});
	};
	const unhandledRejectionListener = (reason: unknown): void => {
		recordDiagnostics({
			category: 'extension',
			name: 'unhandled_rejection',
			metadata: normalizeDiagnosticError(reason),
		});
	};
	process.on('uncaughtExceptionMonitor', unhandledExceptionListener);
	process.on('unhandledRejection', unhandledRejectionListener);
	context.subscriptions.push({
		dispose: () => {
			process.off('uncaughtExceptionMonitor', unhandledExceptionListener);
			process.off('unhandledRejection', unhandledRejectionListener);
		},
	});
	const registerCommand = createDiagnosticCommandRegistrar(recordDiagnostics);

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
	let hostDetailPanel: vscode.WebviewPanel | undefined;

	void focusPocketShellViewOnStartup(recordDiagnostics);

	// ~/.ssh/config is the single source of truth for hosts. Migrate any
	// legacy stored rows into the metadata store once, then refresh the tree
	// so the live config parse is shown.
	void migrateLegacyHostsOnStartup(service, recordDiagnostics).then(() => treeProvider.refresh());

	// -- Commands ----------------------------------------------------------------

	context.subscriptions.push(
		registerCommand('pocketshell.hostDetail.open', async (element?: Host | number) => {
			const id = await resolveHostId(service, element, { connectedOnly: false });
			if (id === undefined) {
				return;
			}

			const host = await service.getHost(id);
			if (!host) {
				vscode.window.showErrorMessage(vscode.l10n.t('Host not found.'));
				return;
			}

			const watchedFolders = await service.getWatchedFolders(id);
			const tmuxSnapshot = await loadHostDetailTmuxPanes(service, id);
			const model = buildHostDetailModel(host, {
				connectionState: service.getState(id),
				watchedFolders,
				tmuxPanes: tmuxSnapshot.panes,
				tmuxError: tmuxSnapshot.error,
			});
			const title = vscode.l10n.t('PocketShell: {0}', model.title);

			if (!hostDetailPanel) {
				hostDetailPanel = vscode.window.createWebviewPanel(
					'pocketshell.hostDetail',
					title,
					vscode.ViewColumn.Active,
					{
						enableCommandUris: true,
						retainContextWhenHidden: true,
					},
				);
				hostDetailPanel.onDidDispose(() => {
					hostDetailPanel = undefined;
				}, null, context.subscriptions);
			}

			hostDetailPanel.title = title;
			hostDetailPanel.webview.html = renderHostDetailHtml(model);
			hostDetailPanel.reveal(vscode.ViewColumn.Active);
		}),
	);

	context.subscriptions.push(
		registerCommand('pocketshell.watchedFolders.openSession', async (element?: unknown) => {
			await vscode.commands.executeCommand('pocketshell.sessions.create', element);
		}),
	);

	context.subscriptions.push(
		registerCommand('pocketshell.watchedFolders.add', async (element?: Host | number) => {
			const id = await resolveHostId(service, element, { connectedOnly: false });
			if (id === undefined) {
				return;
			}
			const folder = await promptWatchedFolder();
			if (!folder) {
				return;
			}
			try {
				await service.addWatchedFolder({ hostId: id, ...folder, source: 'manual', enabled: true });
				await vscode.commands.executeCommand('pocketshell.hostDetail.open', id);
			} catch (err) {
				vscode.window.showErrorMessage(vscode.l10n.t('Failed to add watched folder: {0}', String(err)));
			}
		}),
	);

	context.subscriptions.push(
		registerCommand('pocketshell.watchedFolders.edit', async (element?: unknown) => {
			const folder = await pickWatchedFolder(service, element);
			if (!folder) {
				return;
			}
			const edited = await promptWatchedFolder(folder);
			if (!edited) {
				return;
			}
			try {
				const updated = await service.updateWatchedFolder(folder.id, edited);
				if (!updated) {
					vscode.window.showWarningMessage(
						vscode.l10n.t('That folder path is already watched on this host.'),
					);
					return;
				}
				await vscode.commands.executeCommand('pocketshell.hostDetail.open', folder.hostId);
			} catch (err) {
				vscode.window.showErrorMessage(vscode.l10n.t('Failed to edit watched folder: {0}', String(err)));
			}
		}),
	);

	context.subscriptions.push(
		registerCommand('pocketshell.watchedFolders.delete', async (element?: unknown) => {
			const folder = await pickWatchedFolder(service, element);
			if (!folder) {
				return;
			}
			const deleteLabel = vscode.l10n.t('Delete');
			const confirm = await vscode.window.showWarningMessage(
				vscode.l10n.t('Delete watched folder "{0}"?', folder.label),
				{ modal: true },
				deleteLabel,
			);
			if (confirm !== deleteLabel) {
				return;
			}
			try {
				await service.deleteWatchedFolder(folder.id);
				await vscode.commands.executeCommand('pocketshell.hostDetail.open', folder.hostId);
			} catch (err) {
				vscode.window.showErrorMessage(vscode.l10n.t('Failed to delete watched folder: {0}', String(err)));
			}
		}),
	);

	context.subscriptions.push(
		registerCommand('pocketshell.watchedFolders.moveUp', async (element?: unknown) => {
			await moveWatchedFolder(service, element, 'up');
		}),
		registerCommand('pocketshell.watchedFolders.moveDown', async (element?: unknown) => {
			await moveWatchedFolder(service, element, 'down');
		}),
	);

	context.subscriptions.push(
		registerCommand('pocketshell.watchedFolders.discover', async (element?: Host | number) => {
			const id = await resolveHostId(service, element, { connectedOnly: false });
			if (id === undefined) {
				return;
			}
			try {
				const folders = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: vscode.l10n.t('Discovering project roots...'),
						cancellable: false,
					},
					() => service.discoverWatchedFolders(id),
				);
				vscode.window.showInformationMessage(
					vscode.l10n.t('Watched folders updated ({0} total).', String(folders.length)),
				);
				await vscode.commands.executeCommand('pocketshell.hostDetail.open', id);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Project root discovery failed: {0}', String(err)),
				);
			}
		}),
	);

	context.subscriptions.push(
		registerCommand('pocketshell.watchedFolders.manage', async (element?: Host | number) => {
			const id = await resolveHostId(service, element, { connectedOnly: false });
			if (id === undefined) {
				return;
			}
			const action = await vscode.window.showQuickPick([
				{ label: vscode.l10n.t('Add Folder'), command: 'pocketshell.watchedFolders.add' },
				{ label: vscode.l10n.t('Edit Folder'), command: 'pocketshell.watchedFolders.edit' },
				{ label: vscode.l10n.t('Delete Folder'), command: 'pocketshell.watchedFolders.delete' },
				{ label: vscode.l10n.t('Move Folder Up'), command: 'pocketshell.watchedFolders.moveUp' },
				{ label: vscode.l10n.t('Move Folder Down'), command: 'pocketshell.watchedFolders.moveDown' },
				{ label: vscode.l10n.t('Discover Roots'), command: 'pocketshell.watchedFolders.discover' },
			], {
				placeHolder: vscode.l10n.t('Manage watched folders'),
			});
			if (!action) {
				return;
			}
			await vscode.commands.executeCommand(action.command, id);
		}),
	);

	// Connect to a host (optionally passed hostId from tree item click).
	// The terminal-surface rework routes connect through the surface feature so
	// the terminal opens as a full-width EDITOR TAB (one per session, backed by
	// tmux -CC) instead of the VS Code bottom panel. The surface command owns
	// the tab-reuse + tmux wiring; see feature/surface/surface-commands.ts.
	context.subscriptions.push(
		registerCommand('pocketshell.connect', async (element?: Host | number) => {
			await vscode.commands.executeCommand('pocketshell.surface.connect', element);
			treeProvider.refresh();
		}),
	);

	// Add a new host — ~/.ssh/config is the single source of truth, so this
	// helps the user add a Host stanza to the config (the entry then appears
	// live in the host list) instead of copying details into a separate store.
	context.subscriptions.push(
		registerCommand('pocketshell.addHost', async () => {
			const action = await vscode.window.showQuickPick(
				[
					{ label: vscode.l10n.t('Add Host Stanza...'), value: 'stanza' as const },
					{ label: vscode.l10n.t('Open ~/.ssh/config'), value: 'open' as const },
				],
				{ placeHolder: vscode.l10n.t('Hosts live in ~/.ssh/config. How do you want to add one?') },
			);
			if (!action) {
				return;
			}

			if (action.value === 'open') {
				await openSshConfigForEditing();
				return;
			}

			const name = await vscode.window.showInputBox({
				placeHolder: vscode.l10n.t('My Server'),
				prompt: vscode.l10n.t('Host alias (the `Host` line in ~/.ssh/config)'),
			});
			if (name === undefined || name.trim() === '') {
				return;
			}

			const hostname = await vscode.window.showInputBox({
				placeHolder: vscode.l10n.t('example.com'),
				prompt: vscode.l10n.t('HostName (hostname or IP address)'),
			});
			if (hostname === undefined) {
				return;
			}

			const portStr = await vscode.window.showInputBox({
				placeHolder: '22',
				prompt: vscode.l10n.t('Port'),
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
				prompt: vscode.l10n.t('User'),
			});
			if (username === undefined) {
				return;
			}

			const keyPath = await vscode.window.showInputBox({
				placeHolder: '~/.ssh/id_rsa',
				prompt: vscode.l10n.t('IdentityFile (path to SSH private key)'),
				value: '~/.ssh/id_rsa',
			});
			if (keyPath === undefined) {
				return;
			}

			const newHost: NewHost = {
				name: name.trim(),
				hostname: hostname || name.trim(),
				port,
				username,
				keyPath: keyPath || '~/.ssh/id_rsa',
				maxAutoPort: 10000,
				skipPortsBelow: 1000,
				scanIntervalSec: 5,
				enabled: true,
			};

			try {
				await service.addHost(newHost);
				recordDiagnostics({
					category: 'ssh',
					name: 'host_added_to_config',
					metadata: {
						alias: newHost.name,
						hostname: newHost.hostname,
						username: newHost.username,
						port: newHost.port,
						keyPath: newHost.keyPath,
					},
				});
				vscode.window.showInformationMessage(
					vscode.l10n.t('Added Host "{0}" to ~/.ssh/config.', newHost.name),
				);
			} catch (err) {
				recordDiagnostics({
					category: 'ssh',
					name: 'host_add_failed',
					metadata: {
						alias: newHost.name,
						hostname: newHost.hostname,
						username: newHost.username,
						port: newHost.port,
						keyPath: newHost.keyPath,
						...normalizeDiagnosticError(err),
					},
				});
				vscode.window.showErrorMessage(
					vscode.l10n.t('Failed to add host to ~/.ssh/config: {0}', String(err)),
				);
				return;
			}

			treeProvider.refresh();
		}),
	);

	// Open ~/.ssh/config for editing (the single source of truth).
	context.subscriptions.push(
		registerCommand('pocketshell.openSshConfig', async () => {
			await openSshConfigForEditing();
		}),
	);

	// Report SSH config entries that cannot be used as PocketShell hosts.
	context.subscriptions.push(
		registerCommand('pocketshell.sshConfig.skipped', async () => {
			const parsed = parseSshConfig();
			const { skipped } = resolveHostsFromConfig(parsed);
			reportSkippedHosts(skipped);
		}),
	);

	// Manage SSH keys
	context.subscriptions.push(
		registerCommand('pocketshell.keys.manage', async () => {
			const action = await vscode.window.showQuickPick([
				{ label: vscode.l10n.t('List Managed Keys'), command: 'pocketshell.keys.list' },
				{ label: vscode.l10n.t('Import Private Key'), command: 'pocketshell.keys.import' },
				{ label: vscode.l10n.t('Generate ed25519 Key'), command: 'pocketshell.keys.generate' },
				{ label: vscode.l10n.t('Assign Key to Host'), command: 'pocketshell.keys.assignToHost' },
			], {
				placeHolder: vscode.l10n.t('Manage SSH keys'),
			});
			if (!action) {
				return;
			}
			await vscode.commands.executeCommand(action.command);
		}),
	);

	context.subscriptions.push(
		registerCommand('pocketshell.keys.list', async () => {
			const keys = await service.getKeys();
			const output = vscode.window.createOutputChannel('PocketShell SSH Keys');
			context.subscriptions.push(output);
			output.clear();
			output.appendLine('Managed SSH keys');
			output.appendLine('');
			if (keys.length === 0) {
				output.appendLine('No managed keys.');
			} else {
				for (const key of keys) {
					output.appendLine(`${key.name}`);
					output.appendLine(`  Path: ${key.privateKeyPath}`);
					output.appendLine(`  Fingerprint: ${key.fingerprint}`);
					output.appendLine(`  Passphrase: ${key.hasPassphrase ? 'yes' : 'no'}`);
				}
			}
			output.show(true);
		}),
	);

	context.subscriptions.push(
		registerCommand('pocketshell.keys.import', async () => {
			const picked = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
				openLabel: vscode.l10n.t('Import Key'),
			});
			if (!picked || picked.length === 0) {
				return;
			}

			const sourcePath = picked[0].fsPath;
			const defaultName = path.basename(sourcePath);
			const name = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('Managed key name'),
				value: defaultName,
			});
			if (name === undefined) {
				return;
			}

			const encrypted = await vscode.window.showQuickPick([
				{ label: vscode.l10n.t('Detect automatically'), value: undefined },
				{ label: vscode.l10n.t('Requires passphrase'), value: true },
				{ label: vscode.l10n.t('No passphrase'), value: false },
			], {
				placeHolder: vscode.l10n.t('Does this key require a passphrase?'),
			});
			if (!encrypted) {
				return;
			}

			try {
				const key = await service.importKey(name || defaultName, sourcePath, encrypted.value);
				recordDiagnostics({
					category: 'ssh',
					name: 'key_imported',
					metadata: {
						keyName: key.name,
						keyPath: key.privateKeyPath,
						hasPassphrase: key.hasPassphrase,
					},
				});
				vscode.window.showInformationMessage(
					vscode.l10n.t('Imported SSH key "{0}".', key.name),
				);
			} catch (err) {
				recordDiagnostics({
					category: 'ssh',
					name: 'key_import_failed',
					metadata: {
						sourcePath,
						keyName: name || defaultName,
						...normalizeDiagnosticError(err),
					},
				});
				vscode.window.showErrorMessage(vscode.l10n.t('Failed to import key: {0}', String(err)));
			}
		}),
	);

	context.subscriptions.push(
		registerCommand('pocketshell.keys.generate', async () => {
			const name = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('New ed25519 key name'),
				value: 'id_ed25519_pocketshell',
			});
			if (name === undefined) {
				return;
			}

			try {
				const key = await service.generateKey(name || 'id_ed25519_pocketshell');
				recordDiagnostics({
					category: 'ssh',
					name: 'key_generated',
					metadata: {
						keyName: key.name,
						keyPath: key.privateKeyPath,
					},
				});
				vscode.window.showInformationMessage(
					vscode.l10n.t('Generated SSH key "{0}".', key.name),
				);
			} catch (err) {
				recordDiagnostics({
					category: 'ssh',
					name: 'key_generate_failed',
					metadata: {
						keyName: name || 'id_ed25519_pocketshell',
						...normalizeDiagnosticError(err),
					},
				});
				vscode.window.showErrorMessage(vscode.l10n.t('Failed to generate key: {0}', String(err)));
			}
		}),
	);

	context.subscriptions.push(
		registerCommand('pocketshell.keys.assignToHost', async (element?: Host | number) => {
			const hosts = await service.getHosts();
			const host = await pickHostForKeyAssignment(service, hosts, element);
			if (!host) {
				return;
			}

			const key = await pickManagedKey(service);
			if (!key) {
				return;
			}

			const plan = createHostKeyAssignmentPlan(host, key);
			if (!plan.changed) {
				vscode.window.showInformationMessage(
					vscode.l10n.t('Host "{0}" already uses "{1}".', plan.hostName, key.name),
				);
				return;
			}

			try {
				await service.updateHost(assignManagedKeyToHost(host, key));
				treeProvider.refresh();
				vscode.window.showInformationMessage(
					vscode.l10n.t('Assigned SSH key "{0}" to host "{1}".', key.name, plan.hostName),
				);
			} catch (err) {
				vscode.window.showErrorMessage(vscode.l10n.t('Failed to assign key: {0}', String(err)));
			}
		}),
	);

	// Disconnect from a host
	context.subscriptions.push(
		registerCommand('pocketshell.disconnect', async (element?: Host | number) => {
			const id = await resolveHostId(service, element, { connectedOnly: true });
			if (id === undefined) {
				return;
			}

			service.disconnect(id);
			treeProvider.refresh();
			vscode.window.showInformationMessage(vscode.l10n.t('Disconnected.'));
		}),
	);

	// Edit an existing host
	context.subscriptions.push(
		registerCommand('pocketshell.editHost', async (element?: Host | number) => {
			const hosts = await service.getHosts();
			let host: Host | undefined;
			if (element && typeof element !== 'number') {
				host = element;
			} else if (typeof element === 'number') {
				host = hosts.find(h => h.id === element);
			} else {
				const id = await pickHost(service);
				if (id === undefined) {
					return;
				}
				host = hosts.find(h => h.id === id);
			}

			if (!host) {
				vscode.window.showErrorMessage(vscode.l10n.t('Host not found.'));
				return;
			}

			const name = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('Host display name'),
				value: host.name,
			});
			if (name === undefined) {
				return;
			}

			const hostname = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('Hostname or IP address'),
				value: host.hostname,
			});
			if (hostname === undefined) {
				return;
			}

			const portStr = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('SSH port'),
				value: String(host.port),
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
				prompt: vscode.l10n.t('SSH username'),
				value: host.username,
			});
			if (username === undefined) {
				return;
			}

			const keyPath = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('Path to SSH private key'),
				value: host.keyPath,
			});
			if (keyPath === undefined) {
				return;
			}

			const updated: Host = {
				...host,
				name: name || hostname,
				hostname,
				port,
				username,
				keyPath: keyPath || host.keyPath,
			};

			try {
				await service.updateHost(updated);
				vscode.window.showInformationMessage(
					vscode.l10n.t('Host "{0}" updated.', updated.name),
				);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Failed to update host: {0}', String(err)),
				);
				return;
			}

			treeProvider.refresh();
		}),
	);

	// Delete a host
	context.subscriptions.push(
		registerCommand('pocketshell.deleteHost', async (element?: Host | number) => {
			const hosts = await service.getHosts();
			let host: Host | undefined;
			if (element && typeof element !== 'number') {
				host = element;
			} else if (typeof element === 'number') {
				host = hosts.find(h => h.id === element);
			} else {
				const id = await pickHost(service);
				if (id === undefined) {
					return;
				}
				host = hosts.find(h => h.id === id);
			}

			if (!host) {
				vscode.window.showErrorMessage(vscode.l10n.t('Host not found.'));
				return;
			}

			const confirmed = await vscode.window.showWarningMessage(
				vscode.l10n.t('Delete host "{0}" ({1}:{2})?', host.name, host.hostname, String(host.port)),
				{ modal: true },
				vscode.l10n.t('Delete'),
			);
			if (confirmed !== vscode.l10n.t('Delete')) {
				return;
			}

			// Disconnect if currently connected
			if (service.getConnection(host.id)) {
				service.disconnect(host.id);
			}

			try {
				const removed = await service.deleteHost(host.id);
				if (removed) {
					vscode.window.showInformationMessage(
						vscode.l10n.t('Host "{0}" removed from ~/.ssh/config.', host.name),
					);
				} else {
					vscode.window.showWarningMessage(
						vscode.l10n.t('Host "{0}" was not found in ~/.ssh/config; nothing removed.', host.name),
					);
				}
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Failed to delete host: {0}', String(err)),
				);
				return;
			}

			treeProvider.refresh();
		}),
	);

	// Open a remote file
	context.subscriptions.push(
		registerCommand('pocketshell.openRemoteFile', async () => {
			const hosts = await service.getHosts();
			const connected = hosts.filter(h => service.getConnection(h.id) !== null);
			if (connected.length === 0) {
				vscode.window.showWarningMessage(vscode.l10n.t('No active connections. Connect to a host first.'));
				return;
			}

			const items = connected.map(host => ({
				label: host.name || host.hostname,
				description: `${host.username}@${host.hostname}:${host.port}`,
				hostId: host.id,
				username: host.username,
			}));

			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: vscode.l10n.t('Select a connected host'),
			});
			if (!picked) {
				return;
			}

			const remotePath = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('Remote file path'),
				value: `/home/${picked.username}/`,
			});
			if (remotePath === undefined) {
				return;
			}

			try {
				await vscode.commands.executeCommand('pocketshell.files.openPreview', {
					hostId: picked.hostId,
					path: remotePath,
				});
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Failed to open remote file: {0}', String(err)),
				);
			}
		}),
	);

	// Show PocketShell settings from the shared settings schema.
	context.subscriptions.push(
		registerCommand('pocketshell.settings.open', async () => {
			settings.load();
			const panel = new SettingsPanel(createSettingsPanelStore(settings));
			const output = vscode.window.createOutputChannel('PocketShell Settings');
			context.subscriptions.push(output);

			renderSettingsSummary(panel, output);
			output.show(true);

			const picked = await pickSettingsAction(panel);
			if (!picked) {
				return;
			}

			if (picked.action === 'reset') {
				const confirmed = await vscode.window.showWarningMessage(
					vscode.l10n.t('Reset all PocketShell settings to defaults?'),
					{ modal: true },
					vscode.l10n.t('Reset'),
				);
				if (confirmed !== vscode.l10n.t('Reset')) {
					return;
				}
				panel.resetToDefaults();
				diagnostics.configure(settingsToDiagnosticsConfig(settings.get()));
				renderSettingsSummary(panel, output);
				vscode.window.showInformationMessage(vscode.l10n.t('PocketShell settings reset to defaults.'));
				return;
			}

			const currentValue = panel.getValues()[picked.setting.key];
			const nextValue = await promptForSettingValue(picked.setting, currentValue);
			if (nextValue.cancelled) {
				return;
			}

			const errors = panel.updateValue(picked.setting.key, nextValue.value);
			if (errors.length > 0) {
				vscode.window.showErrorMessage(
					vscode.l10n.t(
						'Invalid value for {0}: {1}',
						picked.setting.label,
						errors.map((error) => error.rule.message).join('; '),
					),
				);
				return;
			}

			renderSettingsSummary(panel, output);
			diagnostics.configure(settingsToDiagnosticsConfig(settings.get()));
			vscode.window.showInformationMessage(
				vscode.l10n.t('Updated {0}.', picked.setting.label),
			);
		}),
	);

	context.subscriptions.push(
		registerCommand('pocketshell.diagnostics.showReport', async () => {
			recordDiagnostics({ category: 'diagnostics', name: 'report_show_requested' });
			const report = createDiagnosticsReport(diagnostics, context, storageDir);
			const output = vscode.window.createOutputChannel('PocketShell Diagnostics');
			context.subscriptions.push(output);
			output.clear();
			output.append(report);
			output.show(true);
		}),
	);

	context.subscriptions.push(
		registerCommand('pocketshell.diagnostics.copyReport', async () => {
			recordDiagnostics({ category: 'diagnostics', name: 'report_copy_requested' });
			const report = createDiagnosticsReport(diagnostics, context, storageDir);
			await vscode.env.clipboard.writeText(report);
			vscode.window.showInformationMessage(vscode.l10n.t('PocketShell diagnostics report copied to clipboard.'));
		}),
	);

	// -- Feature modules (auto-registered) -------------------------------------
	const deps: FeatureDeps = {
		refreshTrees: () => treeProvider.refresh(),
		getSettings: () => ({ ...settings.get() } as Record<string, unknown>),
		portForwardManager,
	};
	for (const feature of FEATURES) {
		const disposables = registerFeatureWithDiagnostics(feature.register, service, context, deps, recordDiagnostics);
		context.subscriptions.push(...disposables);
	}

	// -- PocketShell Settings view (#89) ---------------------------------------
	context.subscriptions.push(...registerPocketshellSettings(context));

	// -- Startup auto-connect (#94) ------------------------------------------
	// Construct the connector (inline, like registerPocketshellSettings above)
	// and fire it once. The connector internally awaits service.getHosts(),
	// so no pre-fetch is needed; errors surface via the pocketshell.surface
	// connect command path it invokes. Fire-and-forget: activate() is sync.
	const [startupAutoConnectDisposables, connector] = registerStartupAutoConnect(service, context, deps);
	context.subscriptions.push(...startupAutoConnectDisposables);
	void connector.run(appSettings);

	// -- Cleanup on deactivate ---------------------------------------------------

	context.subscriptions.push({
		dispose: () => {
			void portForwardManager.dispose();
			service.dispose();
		},
	});
}

interface WatchedFolderPromptResult {
	label: string;
	path: string;
}

interface WatchedFolderTarget {
	hostId: number;
	folderId?: number;
	path?: string;
}

async function promptWatchedFolder(
	existing?: WatchedFolder,
): Promise<WatchedFolderPromptResult | undefined> {
	const folderPath = await vscode.window.showInputBox({
		prompt: vscode.l10n.t('Remote folder path'),
		value: existing?.path ?? '~/git',
	});
	if (folderPath === undefined) {
		return undefined;
	}
	const label = await vscode.window.showInputBox({
		prompt: vscode.l10n.t('Watched folder label'),
		value: existing?.label ?? labelFromRemotePath(folderPath),
	});
	if (label === undefined) {
		return undefined;
	}
	return {
		path: folderPath,
		label: label || labelFromRemotePath(folderPath),
	};
}

async function pickWatchedFolder(
	service: ConnectionService,
	element: unknown,
): Promise<WatchedFolder | undefined> {
	const target = resolveWatchedFolderTarget(element);
	if (target?.folderId !== undefined) {
		const folder = await service.getWatchedFolder(target.folderId);
		if (folder) {
			return folder;
		}
	}

	const hostId = await resolveHostId(service, target?.hostId ?? element, { connectedOnly: false });
	if (hostId === undefined) {
		return undefined;
	}
	const folders = await service.getWatchedFolders(hostId);
	if (folders.length === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t('No watched folders configured.'));
		return undefined;
	}
	const picked = await vscode.window.showQuickPick(
		folders.map((folder) => ({
			label: folder.label,
			description: folder.path,
			detail: folder.source,
			folder,
		})),
		{ placeHolder: vscode.l10n.t('Select a watched folder') },
	);
	return picked?.folder;
}

async function moveWatchedFolder(
	service: ConnectionService,
	element: unknown,
	direction: 'up' | 'down',
): Promise<void> {
	const folder = await pickWatchedFolder(service, element);
	if (!folder) {
		return;
	}
	try {
		await service.moveWatchedFolder(folder.id, direction);
		await vscode.commands.executeCommand('pocketshell.hostDetail.open', folder.hostId);
	} catch (err) {
		vscode.window.showErrorMessage(vscode.l10n.t('Failed to move watched folder: {0}', String(err)));
	}
}

function resolveWatchedFolderTarget(element: unknown): WatchedFolderTarget | undefined {
	if (!element || typeof element !== 'object' || !('hostId' in element)) {
		return undefined;
	}
	const value = element as { hostId: unknown; folderId?: unknown; path?: unknown };
	if (typeof value.hostId !== 'number') {
		return undefined;
	}
	return {
		hostId: value.hostId,
		folderId: typeof value.folderId === 'number' ? value.folderId : undefined,
		path: typeof value.path === 'string' ? value.path : undefined,
	};
}

function labelFromRemotePath(folderPath: string): string {
	const parts = folderPath.replace(/\/+$/, '').split('/').filter(Boolean);
	return parts[parts.length - 1] || folderPath;
}

async function loadHostDetailTmuxPanes(
	service: ConnectionService,
	hostId: number,
): Promise<{ panes: HostDetailTmuxPane[]; error?: string }> {
	const conn = service.getConnection(hostId);
	if (!conn) {
		return { panes: [] };
	}

	const format = '#{session_id}\\t#{session_name}\\t#{session_activity}\\t#{window_id}\\t#{window_name}\\t#{window_activity}\\t#{pane_id}\\t#{pane_current_path}\\t#{pane_title}';
	try {
		const result = await conn.exec(`tmux list-panes -a -F '${format}'`, 5_000);
		if (result.exitCode !== 0) {
			const message = (result.stderr || result.stdout || 'tmux list-panes failed').trim();
			return { panes: [], error: message };
		}
		return { panes: parseHostDetailTmuxPanes(result.stdout) };
	} catch (err) {
		return { panes: [], error: String(err) };
	}
}

function parseHostDetailTmuxPanes(output: string): HostDetailTmuxPane[] {
	return output
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.map((line): HostDetailTmuxPane | undefined => {
			const parts = line.split('\t');
			if (parts.length < 9) {
				return undefined;
			}
			const [
				sessionId,
				sessionName,
				sessionActivity,
				windowId,
				windowName,
				windowActivity,
				paneId,
				cwd,
			] = parts;
			if (!sessionId || !windowId || !paneId) {
				return undefined;
			}
			const parsedSessionActivity = Number.parseInt(sessionActivity, 10);
			const parsedWindowActivity = Number.parseInt(windowActivity, 10);
			const activity = Number.isFinite(parsedWindowActivity)
				? parsedWindowActivity
				: Number.isFinite(parsedSessionActivity)
					? parsedSessionActivity
					: null;
			return {
				id: paneId,
				sessionId,
				sessionName: sessionName || sessionId,
				windowId,
				windowName: windowName || windowId,
				cwd: cwd || null,
				activity,
			};
		})
		.filter((pane): pane is HostDetailTmuxPane => pane !== undefined);
}

function reportSkippedHosts(skipped: SkippedHost[]): void {
	const output = vscode.window.createOutputChannel('PocketShell SSH Config');
	output.clear();
	if (skipped.length === 0) {
		vscode.window.showInformationMessage(
			vscode.l10n.t('All ~/.ssh/config entries are usable. Nothing skipped.'),
		);
		return;
	}

	output.appendLine('SSH config entries not usable as PocketShell hosts:');
	for (const entry of skipped) {
		output.appendLine(`- ${entry.alias}: ${entry.reason}`);
	}
	output.show(true);
	vscode.window.showWarningMessage(
		vscode.l10n.t(
			'{0} SSH config entr{1} not usable. See "PocketShell SSH Config" output.',
			String(skipped.length),
			skipped.length === 1 ? 'y' : 'ies',
		),
	);
}

async function openSshConfigForEditing(): Promise<void> {
	const configPath = path.join(os.homedir(), '.ssh', 'config');
	const document = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
	await vscode.window.showTextDocument(document);
}

async function migrateLegacyHostsOnStartup(
	svc: ConnectionService,
	recordDiagnostics: (input: DiagnosticRecordInput) => void,
): Promise<void> {
	try {
		const result = await svc.migrateLegacyHostMetadata();
		if (result.matched.length === 0 && result.unmatched.length === 0) {
			return;
		}
		recordDiagnostics({
			category: 'ssh',
			name: 'legacy_host_migration',
			metadata: {
				matched: result.matched.length,
				unmatched: result.unmatched.length,
			},
		});
		if (result.matched.length > 0) {
			vscode.window.showInformationMessage(
				vscode.l10n.t(
					'Kept PocketShell metadata for {0} host{1} from your previous setup (now read from ~/.ssh/config).',
					String(result.matched.length),
					result.matched.length === 1 ? '' : 's',
				),
			);
		}
		if (result.unmatched.length > 0) {
			const output = vscode.window.createOutputChannel('PocketShell SSH Migration');
			output.appendLine('Hosts from the previous setup with no matching ~/.ssh/config entry:');
			for (const u of result.unmatched) {
				output.appendLine(`- ${u.legacyName} (${u.username}@${u.hostname}:${u.port}): ${u.reason}`);
			}
			output.show(true);
		}
	} catch (err) {
		recordDiagnostics({
			category: 'ssh',
			name: 'legacy_host_migration_failed',
			metadata: normalizeDiagnosticError(err),
		});
	}
}

function settingsToDiagnosticsConfig(settings: AppSettings): DiagnosticsConfig {
	return {
		enabled: settings.diagnosticsEnabled,
		maxEvents: settings.diagnosticsMaxEvents,
		redactionMode: settings.diagnosticsRedactionMode,
	};
}

async function focusPocketShellViewOnStartup(
	recordDiagnostics: (input: DiagnosticRecordInput) => void,
): Promise<void> {
	try {
		await executeStartupCommand('workbench.action.closeAllEditors', recordDiagnostics);
		await executeStartupCommand('workbench.action.closeAuxiliaryBar', recordDiagnostics);
		await vscode.commands.executeCommand('workbench.view.extension.pocketshell');
		recordDiagnostics({ category: 'navigation', name: 'startup_focus_pocketshell_view' });
	} catch (err) {
		recordDiagnostics({
			category: 'navigation',
			name: 'startup_focus_pocketshell_view_failed',
			metadata: normalizeDiagnosticError(err),
		});
	}
}

async function executeStartupCommand(
	commandId: string,
	recordDiagnostics: (input: DiagnosticRecordInput) => void,
): Promise<void> {
	try {
		await vscode.commands.executeCommand(commandId);
	} catch (err) {
		recordDiagnostics({
			category: 'navigation',
			name: 'startup_command_failed',
			metadata: {
				commandId,
				...normalizeDiagnosticError(err),
			},
		});
	}
}

function createDiagnosticCommandRegistrar(record: (input: DiagnosticRecordInput) => void) {
	return function registerDiagnosticCommand<T extends (...args: any[]) => unknown>(
		commandId: string,
		handler: T,
		thisArg?: unknown,
	): vscode.Disposable {
		return vscode.commands.registerCommand(commandId, wrapDiagnosticCommand(commandId, handler, record), thisArg);
	};
}

function wrapDiagnosticCommand<T extends (...args: any[]) => unknown>(
	commandId: string,
	handler: T,
	record: (input: DiagnosticRecordInput) => void,
): T {
	const wrapped = async (...args: Parameters<T>) => {
		const startedAt = Date.now();
		const category = diagnosticCategoryForCommand(commandId);
		record({
			category,
			name: 'command_started',
			metadata: {
				commandId,
				argumentCount: args.length,
			},
		});
		try {
			const result = await Promise.resolve(handler(...args));
			record({
				category,
				name: 'command_succeeded',
				metadata: {
					commandId,
					durationMs: Date.now() - startedAt,
				},
			});
			return result;
		} catch (err) {
			record({
				category,
				name: 'command_failed',
				metadata: {
					commandId,
					durationMs: Date.now() - startedAt,
					...normalizeDiagnosticError(err),
				},
			});
			throw err;
		}
	};
	return wrapped as T;
}

function diagnosticCategoryForCommand(commandId: string): DiagnosticRecordInput['category'] {
	if (commandId.includes('.tmux')) {
		return 'tmux';
	}
	if (
		commandId.includes('.connect')
		|| commandId.includes('.disconnect')
		|| commandId.includes('.keys')
		|| commandId.includes('Ssh')
		|| commandId.includes('ssh')
	) {
		return 'ssh';
	}
	if (
		commandId.includes('.bootstrap')
		|| commandId.includes('.logs')
		|| commandId.includes('.jobs')
		|| commandId.includes('.env')
		|| commandId.includes('.usage')
		|| commandId.includes('.pocketshell')
	) {
		return 'helper';
	}
	if (commandId.includes('.settings') || commandId.includes('.openRemoteFile') || commandId.includes('.files')) {
		return 'navigation';
	}
	if (commandId.includes('.diagnostics')) {
		return 'diagnostics';
	}
	return 'action';
}

function registerFeatureWithDiagnostics(
	register: FeatureRegistration['register'],
	service: ConnectionService,
	context: vscode.ExtensionContext,
	deps: FeatureDeps,
	record: (input: DiagnosticRecordInput) => void,
): vscode.Disposable[] {
	const original = vscode.commands.registerCommand;
	const commands = vscode.commands as unknown as {
		registerCommand: typeof vscode.commands.registerCommand;
	};
	try {
		commands.registerCommand = ((commandId: string, handler: (...args: any[]) => unknown, thisArg?: unknown) => {
			return original.call(vscode.commands, commandId, wrapDiagnosticCommand(commandId, handler, record), thisArg);
		}) as typeof vscode.commands.registerCommand;
	} catch (err) {
		record({
			category: 'extension',
			name: 'feature_command_instrumentation_failed',
			metadata: normalizeDiagnosticError(err),
		});
		return register(service, context, deps);
	}
	try {
		return register(service, context, deps);
	} finally {
		try {
			commands.registerCommand = original;
		} catch {
			// Leave command registration intact if VS Code exposes it as read-only.
		}
	}
}

function createDiagnosticsReport(
	diagnostics: DiagnosticsEventStore,
	context: vscode.ExtensionContext,
	storageDir: string,
): string {
	const extensionPackage = context.extension?.packageJSON as { version?: string; displayName?: string; name?: string } | undefined;
	const logUri = (context as vscode.ExtensionContext & { logUri?: vscode.Uri }).logUri;
	return buildDiagnosticsReport(diagnostics.list(), {
		appName: extensionPackage?.displayName ?? 'PocketShell',
		extensionVersion: extensionPackage?.version,
		platform: process.platform,
		arch: process.arch,
		nodeVersion: process.version,
		vscodeVersion: vscode.version,
		settings: diagnostics.getConfig(),
		locations: [
			{ label: 'extension global storage', path: storageDir },
			{ label: 'hosts database', path: path.join(storageDir, 'hosts.db') },
			{ label: 'keys database', path: path.join(storageDir, 'keys.db') },
			{ label: 'managed keys directory', path: path.join(storageDir, 'keys') },
			...(logUri ? [{ label: 'VS Code extension log', path: logUri.fsPath }] : []),
		],
		notes: [
			'Remote helper logs are available through PocketShell: Logs commands when the helper is installed on a connected host.',
			'Diagnostics intentionally exclude terminal contents, prompts, keystrokes, secrets, tokens, passphrases, and private-key material.',
		],
	});
}

async function pickHostForKeyAssignment(
	service: ConnectionService,
	hosts: Host[],
	element?: Host | number,
): Promise<Host | undefined> {
	if (element && typeof element !== 'number') {
		return element;
	}
	if (typeof element === 'number') {
		return hosts.find(h => h.id === element);
	}

	const id = await pickHost(service);
	if (id === undefined) {
		return undefined;
	}
	return hosts.find(h => h.id === id);
}

async function pickManagedKey(service: ConnectionService): Promise<SshKey | undefined> {
	const keys = await service.getKeys();
	if (keys.length === 0) {
		vscode.window.showWarningMessage(vscode.l10n.t('No managed SSH keys. Import or generate a key first.'));
		return undefined;
	}

	const picked = await vscode.window.showQuickPick(keys.map(key => ({
		label: key.name,
		description: key.hasPassphrase ? vscode.l10n.t('passphrase') : undefined,
		detail: `${key.fingerprint}  ${key.privateKeyPath}`,
		key,
	})), {
		placeHolder: vscode.l10n.t('Select a managed SSH key'),
	});
	return picked?.key;
}

function createSettingsPanelStore(settings: SettingsStore): SettingsStoreLike {
	return {
		get: () => ({ ...settings.get() } as Record<string, unknown>),
		update: (partial: Record<string, unknown>) => {
			settings.update(partial as Partial<AppSettings>);
		},
	};
}

function renderSettingsSummary(panel: SettingsPanel, output: vscode.OutputChannel): void {
	output.clear();
	output.appendLine('PocketShell Settings');
	output.appendLine('');

	const values = panel.getValues();
	for (const section of panel.getSections()) {
		const rendered = section.render();
		output.appendLine(`[${rendered.title}]`);
		for (const setting of rendered.settings) {
			const value = formatSettingValue(values[setting.key]);
			output.appendLine(`${setting.label} (${setting.key}) = ${value}`);
			output.appendLine(`  ${setting.description}`);
			if (setting.enumValues) {
				output.appendLine(`  Allowed: ${setting.enumValues.join(', ')}`);
			}
		}
		output.appendLine('');
	}
}

type SettingsActionPick =
	| { action: 'edit'; setting: SettingDefinition }
	| { action: 'reset' };

async function pickSettingsAction(panel: SettingsPanel): Promise<SettingsActionPick | undefined> {
	const values = panel.getValues();
	const items: Array<vscode.QuickPickItem & SettingsActionPick> = [
		{
			label: 'Reset all settings to defaults',
			description: 'Restore schema defaults',
			action: 'reset',
		},
	];

	for (const section of panel.getSections()) {
		const rendered = section.render();
		for (const setting of section.settings) {
			items.push({
				label: `${rendered.title}: ${setting.label}`,
				description: `${setting.key} = ${formatSettingValue(values[setting.key])}`,
				detail: setting.description,
				action: 'edit',
				setting,
			});
		}
	}

	return vscode.window.showQuickPick(items, {
		placeHolder: vscode.l10n.t('Select a PocketShell setting to edit'),
		matchOnDescription: true,
		matchOnDetail: true,
	});
}

async function promptForSettingValue(
	setting: SettingDefinition,
	currentValue: unknown,
): Promise<{ cancelled: true } | { cancelled: false; value: unknown }> {
	if (setting.type === 'boolean') {
		const picked = await vscode.window.showQuickPick(
			[
				{ label: 'true', value: true, picked: currentValue === true },
				{ label: 'false', value: false, picked: currentValue === false },
			],
			{ placeHolder: vscode.l10n.t('Select value for {0}', setting.label) },
		);
		return picked ? { cancelled: false, value: picked.value } : { cancelled: true };
	}

	if (setting.type === 'enum') {
		const picked = await vscode.window.showQuickPick(
			(setting.enumValues ?? []).map((value) => ({
				label: value,
				value,
				picked: currentValue === value,
			})),
			{ placeHolder: vscode.l10n.t('Select value for {0}', setting.label) },
		);
		return picked ? { cancelled: false, value: picked.value } : { cancelled: true };
	}

	const input = await vscode.window.showInputBox({
		prompt: setting.nullable
			? vscode.l10n.t('Enter value for {0}. Leave empty for null.', setting.label)
			: vscode.l10n.t('Enter value for {0}', setting.label),
		value: currentValue === null || currentValue === undefined ? '' : String(currentValue),
	});
	if (input === undefined) {
		return { cancelled: true };
	}

	if (setting.type === 'number') {
		const trimmed = input.trim();
		if (setting.nullable && trimmed === '') {
			return { cancelled: false, value: null };
		}
		const value = Number(trimmed);
		return { cancelled: false, value: Number.isNaN(value) ? input : value };
	}

	return { cancelled: false, value: input };
}

function formatSettingValue(value: unknown): string {
	if (value === null) {
		return 'null';
	}
	if (value === undefined) {
		return '';
	}
	return String(value);
}
