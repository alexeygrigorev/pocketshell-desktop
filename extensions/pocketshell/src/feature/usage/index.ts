/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from '../manifest';
import { registerUsage } from './usage-commands';

export const USAGE_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.usage.show', title: 'Usage: Show', category: 'PocketShell' },
			{ command: 'pocketshell.usage.provider', title: 'Usage: By Provider', category: 'PocketShell' },
		],
	},
	register: registerUsage,
};
