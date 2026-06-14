/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from '../manifest';
import { TerminalManager } from '../../backend/terminal';
import { registerTerminal } from './terminal-commands';

// -----------------------------------------------------------------------------
// Singleton accessor
// -----------------------------------------------------------------------------

/**
 * Module-scoped TerminalManager singleton, populated by register().
 *
 * Later batches (tmux-ui) read the manager via getTerminalManager() so they
 * never need to re-edit extension.ts.
 */
let terminalManager: TerminalManager | undefined;

/**
 * Return the TerminalManager singleton, or undefined before the terminal
 * feature has been registered.
 */
export function getTerminalManager(): TerminalManager | undefined {
	return terminalManager;
}

// -----------------------------------------------------------------------------
// Feature registration
// -----------------------------------------------------------------------------

export const TERMINAL_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.terminal.new', title: 'Terminal: New Session', category: 'PocketShell', icon: '$(terminal)' },
			{ command: 'pocketshell.terminal.list', title: 'Terminal: List Sessions', category: 'PocketShell', icon: '$(list-tree)' },
			{ command: 'pocketshell.terminal.close', title: 'Terminal: Close Session', category: 'PocketShell', icon: '$(trash)' },
		],
	},
	register: (service, ctx, deps) => {
		// Instantiate the singleton before registering commands so that
		// getTerminalManager() is populated for command handlers and for
		// downstream features (tmux-ui) alike.
		terminalManager = new TerminalManager();
		return registerTerminal(service, ctx, deps);
	},
};
