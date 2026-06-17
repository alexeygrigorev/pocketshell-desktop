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
 * - Connecting to a host opens ONE tmux-backed terminal as a full-width editor
 *   tab (not in the VS Code bottom terminal panel).
 * - One editor tab per session (host); reconnecting/switching reuses the tab.
 * - The left "Sessions" panel lists current sessions.
 *
 * Registration only appends new commands/view contributions; it does not
 * remove or alter existing registrations.
 */
export const SURFACE_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.surface.connect', title: 'PocketShell: Connect & Open Terminal', category: 'PocketShell', icon: '$(terminal)' },
			{ command: 'pocketshell.session.focusTerminal', title: 'Sessions: Focus Terminal', category: 'PocketShell', icon: '$(terminal-tmux)' },
			{ command: 'pocketshell.session.closeTerminal', title: 'Sessions: Close Terminal', category: 'PocketShell', icon: '$(trash)' },
		],
	},
	register: registerSurface,
};
