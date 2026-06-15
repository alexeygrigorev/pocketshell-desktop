/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConnectionService } from './connection-service';
import type { Host } from './backend/ssh/data/host-store';
import { ConnectionState } from './backend/ssh/connection/connection-manager';

/**
 * Tree data provider for the SSH Hosts sidebar.
 *
 * Shows all configured hosts with their connection status.
 * Clicking a host opens the per-host workspace/detail surface.
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
		const isConnected = state === ConnectionState.Connected;

		const label = host.name || host.hostname;
		const description = `${host.username}@${host.hostname}:${host.port}`;

		const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
		item.description = description;
		item.tooltip = `${label}\n${description}\nState: ${state}`;

		// Status icon
		if (isConnected) {
			item.iconPath = new vscode.ThemeIcon('plug');
		} else {
			item.iconPath = new vscode.ThemeIcon('server');
		}

		// Click -> host detail/workspace surface. Direct terminal remains an explicit action.
		item.command = {
			command: 'pocketshell.hostDetail.open',
			title: 'Open Host',
			arguments: [host.id],
		};

		item.contextValue = isConnected ? 'connectedHost' : 'disconnectedHost';

		return item;
	}

	getChildren(_element?: Host): Thenable<Host[]> {
		return this.service.getHosts();
	}
}
