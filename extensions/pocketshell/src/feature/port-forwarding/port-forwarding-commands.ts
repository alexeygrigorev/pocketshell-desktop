/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { ConnectionService } from '../../connection-service';
import { getOrConnect, resolveHostId } from '../../host-picking';
import type { FeatureDeps } from '../manifest';
import {
	PortForwardError,
	PortForwardManager,
	buildRemoteListeningPortsCommand,
	buildPortForwardRestorePlan,
	buildPortForwardPanelModel,
	deleteSavedPortForward,
	formatLocalUrl,
	markSavedPortForwardStarted,
	markSavedPortForwardStopped,
	mergeDetectedPortCandidates,
	normalizePortForwardOpenArgs,
	normalizeSavedPortForwardState,
	parseRemoteListeningPorts,
	renderPortForwardHtml,
	remoteListeningPortsToCandidates,
	resolveActivePortForwardLocalUrl,
	savedMappingToStartSpec,
	setSavedPortForwardRestore,
	upsertSavedPortForward,
	validatePortForwardInput,
	type DetectedPortCandidate,
	type DetectedPortProtocol,
	type PortForwardFormState,
	type PortForwardPanelStatus,
	type SavedPortForwardPanelMapping,
} from '../../backend/port-forwarding';
import {
	ConnectionEvent,
	ConnectionState,
	type StateChange,
} from '../../backend/ssh/connection/connection-manager';
import type { SshConnection } from '../../backend/ssh/connection/ssh-client';

interface PortForwardPanelEntry {
	hostId: number;
	panel: vscode.WebviewPanel;
	nonce: string;
	prefill: PortForwardFormState;
	status?: PortForwardPanelStatus;
	disposeForwardListener: () => void;
}

interface PortForwardWebviewMessage {
	action?: string;
	form?: PortForwardFormState;
	savedId?: string;
	activeId?: string;
	restoreOnReconnect?: boolean;
}

const SAVED_STATE_KEY_PREFIX = 'pocketshell.portForwarding.saved';

export function registerPortForwarding(
	service: ConnectionService,
	ctx: vscode.ExtensionContext,
	deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];
	const panels = new Map<number, PortForwardPanelEntry>();
	const restoringHosts = new Set<number>();
	const manager = resolvePortForwardManager(service, deps, disposables);

	disposables.push(
		vscode.commands.registerCommand('pocketshell.portForwarding.open', async (element?: unknown) => {
			const args = normalizePortForwardOpenArgs(element);
			const hostId = args.hostId ?? await resolveHostId(service, element, { connectedOnly: false });
			if (hostId === undefined) {
				return undefined;
			}

			const host = await service.getHost(hostId);
			if (!host) {
				void vscode.window.showErrorMessage(vscode.l10n.t('Host not found.'));
				return undefined;
			}

			const existing = panels.get(hostId);
			if (existing) {
				existing.prefill = args.prefill;
				existing.panel.reveal(vscode.ViewColumn.Active);
				if (args.start) {
					await startPrefilledMapping(service, ctx, manager, host, existing, args.openInBrowser, args.openProtocol);
					return existing;
				}
				await renderPanel(ctx, manager, host, existing);
				return existing;
			}

			const panel = vscode.window.createWebviewPanel(
				'pocketshell.portForwarding',
				vscode.l10n.t('Ports: {0}', host.name || host.hostname),
				vscode.ViewColumn.Active,
				{
					enableScripts: true,
					retainContextWhenHidden: true,
				},
			);
			const entry: PortForwardPanelEntry = {
				hostId,
				panel,
				nonce: createNonce(),
				prefill: args.prefill,
				disposeForwardListener: manager.onChange((forward) => {
					if (forward.hostId === hostId) {
						void renderPanel(ctx, manager, host, entry);
					}
				}),
			};

			panels.set(hostId, entry);
			wirePanelMessages(service, ctx, manager, host, entry);
			if (args.start) {
				await startPrefilledMapping(service, ctx, manager, host, entry, args.openInBrowser, args.openProtocol);
			} else {
				await renderPanel(ctx, manager, host, entry);
			}
			panel.onDidDispose(() => {
				entry.disposeForwardListener();
				panels.delete(hostId);
			}, null, disposables);
			return entry;
		}),
	);

	disposables.push(
		vscode.commands.registerCommand('pocketshell.portForwarding.listRemotePorts', async (element?: unknown) => {
			const hostId = await resolveHostId(service, element, { connectedOnly: false });
			if (hostId === undefined) {
				return undefined;
			}
			const connection = await getOrConnect(service, hostId);
			if (!connection) {
				return undefined;
			}

			const result = await connection.exec(buildRemoteListeningPortsCommand(), 5_000);
			const candidates = mergeDetectedPortCandidates(
				remoteListeningPortsToCandidates(parseRemoteListeningPorts(`${result.stdout}\n${result.stderr}`)),
			);
			if (candidates.length === 0) {
				void vscode.window.showInformationMessage(vscode.l10n.t('No interesting listening TCP ports found.'));
				return undefined;
			}
			return pickDetectedPortAction(hostId, candidates);
		}),
	);

	disposables.push({
		dispose: service.connectionManager.onStateChange((change) => {
			void restoreSavedPortForwardsOnConnect(ctx, deps, service, manager, change, restoringHosts);
		}),
	});

	disposables.push({
		dispose: () => {
			for (const entry of panels.values()) {
				entry.disposeForwardListener();
				entry.panel.dispose();
			}
			panels.clear();
		},
	});

	return disposables;
}

function wirePanelMessages(
	service: ConnectionService,
	ctx: vscode.ExtensionContext,
	manager: PortForwardManager,
	host: { id: number; name: string; hostname: string; username: string; port: number },
	entry: PortForwardPanelEntry,
): void {
	entry.panel.webview.onDidReceiveMessage(async (message: PortForwardWebviewMessage) => {
		try {
			if (message.action === 'save' || message.action === 'save-start') {
				const saved = await saveMapping(ctx, host.id, message.form ?? {});
				entry.prefill = {};
				entry.status = { tone: 'success', message: 'Forward saved.' };
				if (message.action === 'save-start') {
					await startMapping(service, ctx, manager, saved);
					entry.status = { tone: 'success', message: 'Forward started.' };
				}
				await renderPanel(ctx, manager, host, entry);
				return;
			}
			if (message.action === 'delete') {
				const deleted = await deleteMapping(ctx, host.id, message.savedId);
				if (deleted) {
					entry.status = { tone: 'success', message: 'Saved forward deleted.' };
				}
				await renderPanel(ctx, manager, host, entry);
				return;
			}
			if (message.action === 'start') {
				const saved = loadSavedMappings(ctx, host.id).find((mapping) => mapping.id === message.savedId);
				if (!saved) {
					throw new Error('Saved forward not found.');
				}
				entry.status = { tone: 'info', message: 'Starting forward...' };
				await renderPanel(ctx, manager, host, entry);
				await startMapping(service, ctx, manager, saved);
				entry.status = { tone: 'success', message: 'Forward started.' };
				await renderPanel(ctx, manager, host, entry);
				return;
			}
			if (message.action === 'stop') {
				if (!message.activeId) {
					throw new Error('Active forward not found.');
				}
				entry.status = { tone: 'info', message: 'Stopping forward...' };
				await renderPanel(ctx, manager, host, entry);
				await manager.stop(message.activeId);
				await storeSavedMappings(ctx, host.id, markSavedPortForwardStopped(loadSavedMappings(ctx, host.id), message.activeId));
				entry.status = { tone: 'success', message: 'Forward stopped.' };
				await renderPanel(ctx, manager, host, entry);
				return;
			}
			if (message.action === 'toggle-restore') {
				if (!message.savedId) {
					throw new Error('Saved forward not found.');
				}
				await storeSavedMappings(
					ctx,
					host.id,
					setSavedPortForwardRestore(loadSavedMappings(ctx, host.id), message.savedId, message.restoreOnReconnect === true),
				);
				entry.status = message.restoreOnReconnect === true
					? { tone: 'success', message: 'Forward will be restored on reconnect.' }
					: { tone: 'muted', message: 'Forward restore disabled.' };
				await renderPanel(ctx, manager, host, entry);
				return;
			}
			if (message.action === 'copy') {
				const url = resolvePanelLocalUrl(manager, host.id, message.activeId);
				await vscode.env.clipboard.writeText(url);
				entry.status = { tone: 'success', message: 'Local URL copied.' };
				await renderPanel(ctx, manager, host, entry);
				return;
			}
			if (message.action === 'open') {
				const url = resolvePanelLocalUrl(manager, host.id, message.activeId);
				await vscode.env.openExternal(vscode.Uri.parse(url));
				return;
			}
		} catch (err) {
			entry.status = { tone: 'error', message: errorMessage(err) };
			await renderPanel(ctx, manager, host, entry);
		}
	});
}

async function pickDetectedPortAction(
	hostId: number,
	candidates: readonly DetectedPortCandidate[],
): Promise<unknown> {
	const picked = await vscode.window.showQuickPick(
		candidates.map((candidate) => ({
			label: candidate.label,
			description: candidate.description,
			detail: candidate.detail,
			candidate,
		})),
		{ placeHolder: vscode.l10n.t('Select a remote port to forward') },
	);
	if (!picked) {
		return undefined;
	}

	const actions = [
		{ label: vscode.l10n.t('Open Port Panel'), start: false, openInBrowser: false },
		{ label: vscode.l10n.t('Start Tunnel'), start: true, openInBrowser: false },
		{ label: vscode.l10n.t('Start Tunnel and Open Browser'), start: true, openInBrowser: true },
	];
	const action = await vscode.window.showQuickPick(actions, {
		placeHolder: vscode.l10n.t('Forward {0}', picked.candidate.label),
	});
	if (!action) {
		return undefined;
	}
	return vscode.commands.executeCommand('pocketshell.portForwarding.open', {
		hostId,
		prefill: prefillFromDetectedPort(picked.candidate),
		start: action.start,
		openInBrowser: action.openInBrowser,
		openProtocol: picked.candidate.protocol ?? 'http',
	});
}

function resolvePanelLocalUrl(
	manager: PortForwardManager,
	hostId: number,
	activeId: string | undefined,
): string {
	const url = resolveActivePortForwardLocalUrl(manager.list(), hostId, activeId);
	if (!url) {
		throw new Error('Active listening forward not found for this host.');
	}
	return url;
}

async function saveMapping(
	ctx: vscode.ExtensionContext,
	hostId: number,
	form: PortForwardFormState,
): Promise<SavedPortForwardPanelMapping> {
	const validation = validatePortForwardInput(form, hostId);
	if (!validation.ok || !validation.value) {
		throw new Error(validation.errors.join(' '));
	}

	const saved = loadSavedMappings(ctx, hostId);
	const id = validation.value.id || createSavedMappingId();
	const next: SavedPortForwardPanelMapping = {
		...validation.value,
		id,
		lastLocalPort: saved.find((mapping) => mapping.id === id)?.lastLocalPort,
		restoreOnReconnect: saved.find((mapping) => mapping.id === id)?.restoreOnReconnect,
	};
	await storeSavedMappings(ctx, hostId, upsertSavedPortForward(saved, next));
	return next;
}

async function deleteMapping(
	ctx: vscode.ExtensionContext,
	hostId: number,
	savedId: string | undefined,
): Promise<boolean> {
	if (!savedId) {
		throw new Error('Saved forward not found.');
	}
	const deleteLabel = vscode.l10n.t('Delete');
	const confirm = await vscode.window.showWarningMessage(
		vscode.l10n.t('Delete this saved port forward?'),
		{ modal: true },
		deleteLabel,
	);
	if (confirm !== deleteLabel) {
		return false;
	}
	await storeSavedMappings(ctx, hostId, deleteSavedPortForward(loadSavedMappings(ctx, hostId), savedId));
	return true;
}

async function startMapping(
	service: ConnectionService,
	ctx: vscode.ExtensionContext,
	manager: PortForwardManager,
	mapping: SavedPortForwardPanelMapping,
): Promise<{ id: string }> {
	const connection = await getOrConnect(service, mapping.hostId);
	if (!connection) {
		throw new Error('SSH connection is not active.');
	}
	const handle = await startMappingWithPortFallback(manager, mapping, connection, false);
	await storeStartedMapping(ctx, mapping.hostId, manager, handle.id);
	return handle;
}

async function startPrefilledMapping(
	service: ConnectionService,
	ctx: vscode.ExtensionContext,
	manager: PortForwardManager,
	host: { id: number; name: string; hostname: string; username: string; port: number },
	entry: PortForwardPanelEntry,
	openInBrowser?: boolean,
	openProtocol: DetectedPortProtocol = 'http',
): Promise<void> {
	try {
		const validation = validatePortForwardInput(entry.prefill, host.id);
		if (!validation.ok || !validation.value) {
			throw new Error(validation.errors.join(' '));
		}
		entry.status = { tone: 'info', message: 'Starting forward...' };
		await renderPanel(ctx, manager, host, entry);
		const connection = await getOrConnect(service, host.id);
		if (!connection) {
			throw new Error('SSH connection is not active.');
		}
		const handle = await manager.start({
			...validation.value,
			id: validation.value.id || undefined,
		}, connection);
		if (validation.value.id) {
			await storeStartedMapping(ctx, host.id, manager, handle.id);
		}
		entry.prefill = {};
		entry.status = { tone: 'success', message: 'Forward started.' };
		if (openInBrowser) {
			const forward = manager.get(handle.id);
			const url = forward ? formatLocalUrl(forward, openProtocol) : undefined;
			if (!url) {
				throw new Error('Started forward is not listening yet.');
			}
			await vscode.env.openExternal(vscode.Uri.parse(url));
		}
	} catch (err) {
		entry.status = { tone: 'error', message: errorMessage(err) };
	}
	await renderPanel(ctx, manager, host, entry);
}

async function restoreSavedPortForwardsOnConnect(
	ctx: vscode.ExtensionContext,
	deps: FeatureDeps,
	service: ConnectionService,
	manager: PortForwardManager,
	change: StateChange,
	restoringHosts: Set<number>,
): Promise<void> {
	if (
		change.newState !== ConnectionState.Connected ||
		(change.event !== ConnectionEvent.Connect && change.event !== ConnectionEvent.Reconnect) ||
		!isPortForwardRestoreEnabled(deps) ||
		restoringHosts.has(change.hostId)
	) {
		return;
	}

	const connection = service.getConnection(change.hostId);
	if (!connection) {
		return;
	}

	const plan = buildPortForwardRestorePlan(
		change.hostId,
		loadSavedMappings(ctx, change.hostId),
	);
	if (plan.mappings.length === 0) {
		return;
	}

	restoringHosts.add(change.hostId);
	const failed: string[] = [];
	try {
		for (const mapping of plan.mappings) {
			try {
				if (manager.get(mapping.id)) {
					await manager.stop(mapping.id);
				}
				const handle = await startMappingWithPortFallback(manager, mapping, connection, true);
				await storeStartedMapping(ctx, change.hostId, manager, handle.id);
			} catch (err) {
				failed.push(`${mapping.name || `${mapping.remoteHost}:${mapping.remotePort}`}: ${errorMessage(err)}`);
			}
		}
	} finally {
		restoringHosts.delete(change.hostId);
	}

	if (failed.length > 0) {
		void vscode.window.showWarningMessage(
			vscode.l10n.t('Some port forwards could not be restored: {0}', failed.join('; ')),
		);
	}
}

async function startMappingWithPortFallback(
	manager: PortForwardManager,
	mapping: SavedPortForwardPanelMapping,
	connection: SshConnection,
	preferRememberedPort: boolean,
): Promise<{ id: string }> {
	try {
		return await manager.start(savedMappingToStartSpec(mapping, {
			preferLastLocalPort: preferRememberedPort,
		}), connection);
	} catch (err) {
		if (
			preferRememberedPort &&
			mapping.localPort === undefined &&
			mapping.lastLocalPort !== undefined &&
			err instanceof PortForwardError &&
			err.code === 'LOCAL_PORT_IN_USE'
		) {
			void vscode.window.showWarningMessage(
				vscode.l10n.t(
					'Local port {0} is unavailable; restored {1} on another local port.',
					mapping.lastLocalPort,
					mapping.name || `${mapping.remoteHost}:${mapping.remotePort}`,
				),
			);
			return manager.start(savedMappingToStartSpec(mapping), connection);
		}
		throw err;
	}
}

async function storeStartedMapping(
	ctx: vscode.ExtensionContext,
	hostId: number,
	manager: PortForwardManager,
	activeId: string,
): Promise<void> {
	const forward = manager.get(activeId);
	if (!forward) {
		return;
	}
	await storeSavedMappings(ctx, hostId, markSavedPortForwardStarted(loadSavedMappings(ctx, hostId), forward));
}

function isPortForwardRestoreEnabled(deps: FeatureDeps): boolean {
	const settings = deps.getSettings?.();
	return settings?.portForwardRestoreActiveTunnels !== false;
}

async function renderPanel(
	ctx: vscode.ExtensionContext,
	manager: PortForwardManager,
	host: { id: number; name: string; hostname: string; username: string; port: number },
	entry: PortForwardPanelEntry,
): Promise<void> {
	const model = buildPortForwardPanelModel({
		host,
		savedForwards: loadSavedMappings(ctx, host.id),
		activeForwards: manager.list(),
		prefill: entry.prefill,
		status: entry.status,
	});
	entry.panel.title = vscode.l10n.t('Ports: {0}', model.title);
	entry.panel.webview.html = renderPortForwardHtml(model, {
		cspSource: entry.panel.webview.cspSource,
		nonce: entry.nonce,
	});
}

function prefillFromDetectedPort(candidate: DetectedPortCandidate): PortForwardFormState {
	return {
		name: candidate.source === 'pane-url'
			? candidate.label
			: candidate.process ? `${candidate.process} ${candidate.remotePort}` : `Port ${candidate.remotePort}`,
		remoteHost: candidate.remoteHost,
		remotePort: candidate.remotePort,
	};
}

function loadSavedMappings(
	ctx: vscode.ExtensionContext,
	hostId: number,
): SavedPortForwardPanelMapping[] {
	const raw = ctx.workspaceState.get<unknown[]>(savedStateKey(hostId), []);
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw
		.map((item) => normalizeSavedPortForwardState(item, hostId))
		.filter((item): item is SavedPortForwardPanelMapping => item !== undefined);
}

async function storeSavedMappings(
	ctx: vscode.ExtensionContext,
	hostId: number,
	saved: SavedPortForwardPanelMapping[],
): Promise<void> {
	await ctx.workspaceState.update(savedStateKey(hostId), saved);
}

function savedStateKey(hostId: number): string {
	return `${SAVED_STATE_KEY_PREFIX}.${hostId}`;
}

function resolvePortForwardManager(
	service: ConnectionService,
	deps: FeatureDeps,
	disposables: vscode.Disposable[],
): PortForwardManager {
	const existing = deps.portForwardManager;
	if (existing instanceof PortForwardManager) {
		return existing;
	}
	const manager = new PortForwardManager({ connections: service.connectionManager });
	disposables.push({ dispose: () => void manager.dispose() });
	return manager;
}

function createSavedMappingId(): string {
	return `pf-saved-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

function createNonce(): string {
	return randomBytes(16).toString('base64');
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
