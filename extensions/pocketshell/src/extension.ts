/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionService } from './connection-service';
import { SshPseudoterminal } from './ssh-terminal';
import { SftpFsProvider } from './sftp-fs-provider';
import { HostTreeProvider } from './host-tree-provider';
import { pickHost, resolveHostId, getOrConnect } from './host-picking';
import { FEATURES, type FeatureDeps } from './feature';
import { createSshConfigImportPlan, type SshConfigImportCandidate, type SshConfigImportSkipped } from './backend/ssh/data/ssh-config-import';
import { parseSshConfig } from './backend/ssh/data/ssh-config-parser';
import { SettingsStore, type AppSettings } from './backend/app/settings';
import { SettingsPanel, type SettingsStoreLike } from './backend/ui/settings/settings-panel';
import type { SettingDefinition } from './backend/ui/settings/settings-schema';
import type { Host, NewHost } from './backend/ssh/data/host-store';
import type { SshKey } from './backend/ssh/data/key-store';
import { assignManagedKeyToHost, createHostKeyAssignmentPlan } from './backend/ssh/data/key-assignment';

/**
 * Extension entry point.
 *
 * Registers:
 *   - Terminal profile provider for "pocketshell.ssh"
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
	service.setPassphraseProvider(async (host) => vscode.window.showInputBox({
		prompt: vscode.l10n.t('Passphrase for SSH key used by {0}', host.name || host.hostname),
		password: true,
		ignoreFocusOut: true,
	}));

	// -- Terminal profile provider -----------------------------------------------

	const profileProvider: vscode.TerminalProfileProvider = {
		async provideTerminalProfile(_token: vscode.CancellationToken): Promise<vscode.TerminalProfile | undefined> {
			const hosts = await service.getHosts();
			if (hosts.length === 0) {
				vscode.window.showWarningMessage(vscode.l10n.t('No hosts configured. Use "PocketShell: Add Host" first.'));
				return undefined;
			}

			// Show quick-pick of hosts
			const items = hosts.map(host => ({
				label: host.name || host.hostname,
				description: `${host.username}@${host.hostname}:${host.port}`,
				hostId: host.id,
			}));

			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: vscode.l10n.t('Select a host for terminal'),
			});

			if (!picked) {
				return undefined;
			}

			const host = hosts.find(h => h.id === picked.hostId);
			if (!host) {
				return undefined;
			}

			// Connect if not already connected
			const conn = await getOrConnect(service, host.id);
			if (!conn) {
				return undefined;
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
		vscode.commands.registerCommand('pocketshell.connect', async (element?: Host | number) => {
			const id = await resolveHostId(service, element, { connectedOnly: false });
			if (id === undefined) {
				return;
			}

			const host = await service.getHost(id);
			if (!host) {
				vscode.window.showErrorMessage(vscode.l10n.t('Host not found.'));
				return;
			}

			// Check if already connected
			const conn = await getOrConnect(service, id);
			if (!conn) {
				return;
			}

			// Open terminal
			const pty = new SshPseudoterminal(conn, host.name || host.hostname);
			const terminal = vscode.window.createTerminal({
				name: `PocketShell: ${host.name || host.hostname}`,
				pty,
				iconPath: new vscode.ThemeIcon('remote'),
			});
			terminal.show();

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

			const keyPath = await vscode.window.showInputBox({
				placeHolder: '~/.ssh/id_rsa',
				prompt: vscode.l10n.t('Path to SSH private key'),
				value: '~/.ssh/id_rsa',
			});
			if (keyPath === undefined) {
				return;
			}

			const newHost: NewHost = {
				name: name || hostname,
				hostname,
				port,
				username,
				keyPath: keyPath || '~/.ssh/id_rsa',
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

	// Import hosts from ~/.ssh/config
	context.subscriptions.push(
		vscode.commands.registerCommand('pocketshell.importSshConfig', async () => {
			const output = vscode.window.createOutputChannel('PocketShell SSH Import');
			context.subscriptions.push(output);

			let parsed: ReturnType<typeof parseSshConfig>;
			try {
				parsed = parseSshConfig();
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Failed to read SSH config: {0}', String(err)),
				);
				return;
			}

			if (parsed.length === 0) {
				vscode.window.showInformationMessage(vscode.l10n.t('No hosts found in ~/.ssh/config.'));
				return;
			}

			const existingHosts = await service.getHosts();
			const plan = createSshConfigImportPlan(parsed, existingHosts);
			reportSshImportSkipped(output, plan.skipped);

			if (plan.importable.length === 0) {
				const detail = plan.skipped.length > 0
					? vscode.l10n.t('See "PocketShell SSH Import" output for skipped entries.')
					: '';
				vscode.window.showWarningMessage(
					vscode.l10n.t('No importable SSH config hosts found. {0}', detail),
				);
				if (plan.skipped.length > 0) {
					output.show(true);
				}
				return;
			}

			if (plan.skipped.length > 0) {
				vscode.window.showWarningMessage(
					vscode.l10n.t(
						'Skipped {0} SSH config entr{1}. See "PocketShell SSH Import" output for details.',
						String(plan.skipped.length),
						plan.skipped.length === 1 ? 'y' : 'ies',
					),
				);
			}

			const items = plan.importable.map(candidate => ({
				label: candidate.alias,
				description: `${candidate.host.username}@${candidate.host.hostname}:${candidate.host.port}`,
				detail: formatImportCandidateDetail(candidate),
				candidate,
				picked: true,
			}));

			const picked = await vscode.window.showQuickPick(items, {
				canPickMany: true,
				placeHolder: vscode.l10n.t('Select SSH config hosts to import'),
			});
			if (!picked || picked.length === 0) {
				return;
			}

			let imported = 0;
			for (const item of picked) {
				try {
					await service.addHost(item.candidate.host);
					imported += 1;
				} catch (err) {
					output.appendLine(`Failed to import ${item.candidate.alias}: ${String(err)}`);
				}
			}

			treeProvider.refresh();
			if (imported === picked.length) {
				vscode.window.showInformationMessage(
					vscode.l10n.t('Imported {0} SSH config host{1}.', String(imported), imported === 1 ? '' : 's'),
				);
			} else {
				output.show(true);
				vscode.window.showWarningMessage(
					vscode.l10n.t(
						'Imported {0} of {1} selected SSH config hosts. See output for details.',
						String(imported),
						String(picked.length),
					),
				);
			}
		}),
	);

	// Manage SSH keys
	context.subscriptions.push(
		vscode.commands.registerCommand('pocketshell.keys.manage', async () => {
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
		vscode.commands.registerCommand('pocketshell.keys.list', async () => {
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
		vscode.commands.registerCommand('pocketshell.keys.import', async () => {
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
				vscode.window.showInformationMessage(
					vscode.l10n.t('Imported SSH key "{0}".', key.name),
				);
			} catch (err) {
				vscode.window.showErrorMessage(vscode.l10n.t('Failed to import key: {0}', String(err)));
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pocketshell.keys.generate', async () => {
			const name = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('New ed25519 key name'),
				value: 'id_ed25519_pocketshell',
			});
			if (name === undefined) {
				return;
			}

			try {
				const key = await service.generateKey(name || 'id_ed25519_pocketshell');
				vscode.window.showInformationMessage(
					vscode.l10n.t('Generated SSH key "{0}".', key.name),
				);
			} catch (err) {
				vscode.window.showErrorMessage(vscode.l10n.t('Failed to generate key: {0}', String(err)));
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pocketshell.keys.assignToHost', async (element?: Host | number) => {
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
		vscode.commands.registerCommand('pocketshell.disconnect', async (element?: Host | number) => {
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
		vscode.commands.registerCommand('pocketshell.editHost', async (element?: Host | number) => {
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
		vscode.commands.registerCommand('pocketshell.deleteHost', async (element?: Host | number) => {
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
				await service.deleteHost(host.id);
				vscode.window.showInformationMessage(
					vscode.l10n.t('Host "{0}" deleted.', host.name),
				);
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
		vscode.commands.registerCommand('pocketshell.openRemoteFile', async () => {
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

			const uri = vscode.Uri.parse(`pocketshell://${picked.hostId}${remotePath}`);
			try {
				const doc = await vscode.workspace.openTextDocument(uri);
				await vscode.window.showTextDocument(doc);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Failed to open remote file: {0}', String(err)),
				);
			}
		}),
	);

	// Show PocketShell settings from the shared settings schema.
	context.subscriptions.push(
		vscode.commands.registerCommand('pocketshell.settings.open', async () => {
			const settings = new SettingsStore(path.join(storageDir, 'settings.json'));
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
			vscode.window.showInformationMessage(
				vscode.l10n.t('Updated {0}.', picked.setting.label),
			);
		}),
	);

	// -- Feature modules (auto-registered) -------------------------------------
	const deps: FeatureDeps = { refreshTrees: () => treeProvider.refresh() };
	for (const feature of FEATURES) {
		for (const disposable of feature.register(service, context, deps)) {
			context.subscriptions.push(disposable);
		}
	}

	// -- Cleanup on deactivate ---------------------------------------------------

	context.subscriptions.push({
		dispose: () => service.dispose(),
	});
}

function reportSshImportSkipped(
	output: vscode.OutputChannel,
	skipped: SshConfigImportSkipped[],
): void {
	output.clear();
	if (skipped.length === 0) {
		return;
	}

	output.appendLine('Skipped SSH config entries:');
	for (const entry of skipped) {
		const proxy = entry.proxyMetadata ? ` (${entry.proxyMetadata})` : '';
		output.appendLine(`- ${entry.alias}: ${entry.reason}${proxy}`);
	}
}

function formatImportCandidateDetail(candidate: SshConfigImportCandidate): string {
	const key = `IdentityFile ${candidate.host.keyPath}`;
	return candidate.proxyMetadata ? `${key}; ${candidate.proxyMetadata}` : key;
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
