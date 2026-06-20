/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from '../manifest';
import { registerUsage } from './usage-commands';

export const USAGE_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.usage.openPanel', title: 'Usage: Open Panel', category: 'PocketShell', icon: '$(graph)' },
			{ command: 'pocketshell.usage.panel', title: 'Usage: Show', category: 'PocketShell' },
			{ command: 'pocketshell.usage.refresh', title: 'Usage: Refresh', category: 'PocketShell', icon: '$(refresh)' },
			{ command: 'pocketshell.usage.show', title: 'Usage: Show Host', category: 'PocketShell' },
			{ command: 'pocketshell.usage.provider', title: 'Usage: By Provider', category: 'PocketShell' },
			{ command: 'pocketshell.usage.output', title: 'Usage: Show as Text', category: 'PocketShell' },
		],
		menus: {
			'view/item/context': [
				{ command: 'pocketshell.usage.openPanel', when: 'view == pocketshell.hosts', group: '2_usage' },
				{ command: 'pocketshell.usage.refresh', when: 'view == pocketshell.hosts', group: '2_usage' },
			],
			'terminal/context': [
				{ command: 'pocketshell.usage.openPanel', group: 'pocketshell_usage' },
				{ command: 'pocketshell.usage.refresh', group: 'pocketshell_usage' },
			],
			'commandPalette': [
				{ command: 'pocketshell.usage.openPanel' },
				{ command: 'pocketshell.usage.refresh' },
				{ command: 'pocketshell.usage.provider' },
				{ command: 'pocketshell.usage.output' },
			],
		},
	},
	register: registerUsage,
};
