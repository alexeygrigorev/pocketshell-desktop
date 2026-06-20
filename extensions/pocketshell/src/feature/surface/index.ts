/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from '../manifest';
import { registerSurface } from './surface-commands';

/**
 * Terminal-surface feature: the reworked terminal workflow that matches the
 * PocketShell Android app.
 *
 * - Connecting to a host opens a tmux-backed terminal as a full-width editor
 *   tab (not in the VS Code bottom terminal panel), attach-or-create via
 *   `tmux new-session -A -s <name>`.
 * - ONE SSH connection per host (warm lease), N tmux sessions: one editor tab
 *   per (host, tmux session). `surface.connect` opens the default host session
 *   (idempotent); `surface.openSession` opens an additional named session.
 * - The left "Sessions" panel is the canonical session tree (sessions grouped
 *   by host), driven by the SessionTerminalRegistry.
 *
 * Registration only appends new commands/view contributions; it does not
 * remove or alter existing registrations.
 */
export const SURFACE_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.surface.connect', title: 'PocketShell: Connect & Open Terminal', category: 'PocketShell', icon: '$(terminal)' },
			{ command: 'pocketshell.surface.openSession', title: 'PocketShell: Open Additional Session', category: 'PocketShell', icon: '$(add)' },
			{ command: 'pocketshell.session.focusTerminal', title: 'Sessions: Focus Terminal', category: 'PocketShell', icon: '$(terminal-tmux)' },
			{ command: 'pocketshell.session.closeTerminal', title: 'Sessions: Close Terminal', category: 'PocketShell', icon: '$(trash)' },
		],
	},
	register: registerSurface,
};
