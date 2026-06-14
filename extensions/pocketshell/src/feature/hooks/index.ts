/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from '../manifest';
import { registerHooks } from './hooks-commands';

export const HOOKS_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.hooks.status', title: 'Hooks: Status', category: 'PocketShell', icon: '$(extensions)' },
			{ command: 'pocketshell.hooks.list', title: 'Hooks: List', category: 'PocketShell' },
			{ command: 'pocketshell.hooks.add', title: 'Hooks: Add', category: 'PocketShell', icon: '$(add)' },
			{ command: 'pocketshell.hooks.remove', title: 'Hooks: Remove', category: 'PocketShell', icon: '$(trash)' },
		],
	},
	register: registerHooks,
};
