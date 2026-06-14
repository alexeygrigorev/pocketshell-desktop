/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import type { ConnectionService } from '../connection-service';

export interface FeatureManifest {
	commands: { command: string; title: string; category?: string; icon?: string }[];
	menus?: Record<string, { command: string; when?: string; group?: string }[]>;
}

export interface FeatureDeps {
	/** Refresh the host tree after a feature mutates state. */
	refreshTrees: () => void;
	/** Reserved for cross-feature deps filled in later batches (e.g. terminalManager). */
	[key: string]: unknown;
}

export interface FeatureRegistration {
	manifest: FeatureManifest;
	register: (service: ConnectionService, ctx: vscode.ExtensionContext, deps: FeatureDeps) => vscode.Disposable[];
}
