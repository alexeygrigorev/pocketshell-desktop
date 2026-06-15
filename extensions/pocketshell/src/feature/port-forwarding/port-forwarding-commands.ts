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
	PortForwardManager,
	buildPortForwardPanelModel,
	normalizePortForwardOpenArgs,
	normalizeSavedPortForward,
	renderPortForwardHtml,
	resolveActivePortForwardLocalUrl,
	validatePortForwardInput,
	type PortForwardFormState,
	type PortForwardPanelStatus,
	type SavedPortForwardPanelMapping,
} from '../../backend/port-forwarding';

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
}

const SAVED_STATE_KEY_PREFIX = 'pocketshell.portForwarding.saved';

export function registerPortForwarding(
	service: ConnectionService,
	ctx: vscode.ExtensionContext,
	deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];
	const panels = new Map<number, PortForwardPanelEntry>();
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
			await renderPanel(ctx, manager, host, entry);
			panel.onDidDispose(() => {
				entry.disposeForwardListener();
				panels.delete(hostId);
			}, null, disposables);
			return entry;
		}),
	);

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
					await startMapping(service, manager, saved);
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
				await startMapping(service, manager, saved);
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
				entry.status = { tone: 'success', message: 'Forward stopped.' };
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
	};
	const existingIndex = saved.findIndex((mapping) => mapping.id === id);
	if (existingIndex >= 0) {
		saved[existingIndex] = next;
	} else {
		saved.push(next);
	}
	await storeSavedMappings(ctx, hostId, saved);
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
	await storeSavedMappings(
		ctx,
		hostId,
		loadSavedMappings(ctx, hostId).filter((mapping) => mapping.id !== savedId),
	);
	return true;
}

async function startMapping(
	service: ConnectionService,
	manager: PortForwardManager,
	mapping: SavedPortForwardPanelMapping,
): Promise<void> {
	const connection = await getOrConnect(service, mapping.hostId);
	if (!connection) {
		throw new Error('SSH connection is not active.');
	}
	await manager.start(mapping, connection);
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

function loadSavedMappings(
	ctx: vscode.ExtensionContext,
	hostId: number,
): SavedPortForwardPanelMapping[] {
	const raw = ctx.workspaceState.get<unknown[]>(savedStateKey(hostId), []);
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw
		.map((item) => normalizeSavedPortForward(item, hostId))
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
