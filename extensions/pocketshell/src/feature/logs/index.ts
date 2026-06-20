/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from '../manifest';
import { registerLogs } from './logs-commands';

export const LOGS_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.logs.openPanel', title: 'Logs: Open Panel', category: 'PocketShell', icon: '$(output)' },
			{ command: 'pocketshell.logs.show', title: 'Logs: Show', category: 'PocketShell' },
			{ command: 'pocketshell.logs.tail', title: 'Logs: Tail', category: 'PocketShell' },
			{ command: 'pocketshell.logs.clear', title: 'Logs: Clear', category: 'PocketShell' },
		],
		menus: {
			'view/item/context': [
				{ command: 'pocketshell.logs.openPanel', when: 'view == pocketshell.hosts', group: '5_logs' },
			],
			'commandPalette': [
				{ command: 'pocketshell.logs.openPanel' },
				{ command: 'pocketshell.logs.show' },
				{ command: 'pocketshell.logs.tail' },
				{ command: 'pocketshell.logs.clear' },
			],
		},
	},
	register: registerLogs,
};
