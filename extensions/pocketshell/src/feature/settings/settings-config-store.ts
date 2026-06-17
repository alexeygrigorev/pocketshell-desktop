/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConfigStore, SettingValue } from '../../backend/pocketshell-settings';

/**
 * vscode-backed `ConfigStore` over `vscode.workspace.getConfiguration('pocketshell')`.
 *
 * Bridges the pure settings model to VS Code's configuration system. The
 * target (Global/Workspace/WorkspaceFolder) is fixed at construction so the
 * provider can scope writes to user settings by default.
 */
export class SettingsConfigStore implements ConfigStore {
	private readonly scope = 'pocketshell';
	private readonly target: vscode.ConfigurationTarget;

	constructor(target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global) {
		this.target = target;
	}

	has(key: string): boolean {
		const cfg = vscode.workspace.getConfiguration(this.scope);
		const inspection = cfg.inspect(key);
		if (!inspection) {
			return false;
		}
		return (
			inspection.globalValue !== undefined ||
			inspection.workspaceValue !== undefined ||
			inspection.workspaceFolderValue !== undefined
		);
	}

	get<T extends SettingValue>(key: string): T | undefined {
		const cfg = vscode.workspace.getConfiguration(this.scope);
		const value = cfg.get<T>(key);
		return value;
	}

	async update(key: string, value: SettingValue): Promise<void> {
		const cfg = vscode.workspace.getConfiguration(this.scope);
		await cfg.update(key, value, this.target);
	}
}
