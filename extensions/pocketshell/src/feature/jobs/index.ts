/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from '../manifest';
import { registerJobs } from './jobs-commands';

export const JOBS_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.jobs.openPanel', title: 'Jobs: Open Panel', category: 'PocketShell', icon: '$(clock)' },
			{ command: 'pocketshell.jobs.list', title: 'Jobs: List', category: 'PocketShell', icon: '$(list-unordered)' },
			{ command: 'pocketshell.jobs.logs', title: 'Jobs: Logs', category: 'PocketShell', icon: '$(output)' },
			{ command: 'pocketshell.jobs.cancel', title: 'Jobs: Cancel', category: 'PocketShell', icon: '$(close)' },
		],
		menus: {
			'view/item/context': [
				{ command: 'pocketshell.jobs.openPanel', when: 'view == pocketshell.hosts', group: '4_jobs' },
			],
			'commandPalette': [
				{ command: 'pocketshell.jobs.openPanel' },
				{ command: 'pocketshell.jobs.list' },
				{ command: 'pocketshell.jobs.logs' },
				{ command: 'pocketshell.jobs.cancel' },
			],
		},
	},
	register: registerJobs,
};
