/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from '../manifest';
import { registerLogs } from './logs-commands';

export const LOGS_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.logs.show', title: 'Logs: Show', category: 'PocketShell' },
			{ command: 'pocketshell.logs.tail', title: 'Logs: Tail', category: 'PocketShell' },
			{ command: 'pocketshell.logs.clear', title: 'Logs: Clear', category: 'PocketShell' },
		],
	},
	register: registerLogs,
};
