/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from '../manifest';
import { registerTmux } from './tmux-commands';

export const TMUX_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.tmux.list', title: 'Tmux: List Sessions', category: 'PocketShell', icon: '$(list-tree)' },
			{ command: 'pocketshell.tmux.new', title: 'Tmux: New Session', category: 'PocketShell', icon: '$(add)' },
			{ command: 'pocketshell.tmux.send', title: 'Tmux: Send Keys', category: 'PocketShell' },
			{ command: 'pocketshell.tmux.detach', title: 'Tmux: Detach', category: 'PocketShell', icon: '$(debug-disconnect)' },
		],
	},
	register: registerTmux,
};
