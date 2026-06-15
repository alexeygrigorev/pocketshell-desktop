/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from '../manifest';
import { registerTmuxUi } from './tmux-ui-commands';

export const TMUX_UI_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.tmux-ui.showTree', title: 'Tmux UI: Show Session Tree', category: 'PocketShell', icon: '$(list-tree)' },
			{ command: 'pocketshell.tmux-ui.newSession', title: 'Tmux UI: New Session', category: 'PocketShell', icon: '$(add)' },
			{ command: 'pocketshell.tmux-ui.openSession', title: 'Tmux UI: Open Session Terminal', category: 'PocketShell', icon: '$(terminal-tmux)' },
			{ command: 'pocketshell.tmux-ui.splitPane', title: 'Tmux UI: Split Pane', category: 'PocketShell' },
			{ command: 'pocketshell.tmux-ui.capturePane', title: 'Tmux UI: Capture Pane', category: 'PocketShell', icon: '$(eye)' },
		],
	},
	register: registerTmuxUi,
};
