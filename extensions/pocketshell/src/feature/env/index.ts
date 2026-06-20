/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from '../manifest';
import { registerEnv } from './env-commands';

export const ENV_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.env.openPanel', title: 'Env: Open Panel', category: 'PocketShell', icon: '$(symbol-variable)' },
			{ command: 'pocketshell.env.list', title: 'Env: List', category: 'PocketShell' },
			{ command: 'pocketshell.env.manage', title: 'Env: Manage Folder', category: 'PocketShell', icon: '$(symbol-variable)' },
			{ command: 'pocketshell.env.set', title: 'Env: Set', category: 'PocketShell' },
			{ command: 'pocketshell.env.unset', title: 'Env: Unset', category: 'PocketShell' },
		],
		menus: {
			'view/item/context': [
				{ command: 'pocketshell.env.openPanel', when: 'view == pocketshell.hosts', group: '3_env' },
			],
			'commandPalette': [
				{ command: 'pocketshell.env.openPanel' },
				{ command: 'pocketshell.env.list' },
				{ command: 'pocketshell.env.manage' },
				{ command: 'pocketshell.env.set' },
				{ command: 'pocketshell.env.unset' },
			],
		},
	},
	register: registerEnv,
};
