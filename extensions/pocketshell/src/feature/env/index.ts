/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from '../manifest';
import { registerEnv } from './env-commands';

export const ENV_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.env.list', title: 'Env: List', category: 'PocketShell' },
			{ command: 'pocketshell.env.set', title: 'Env: Set', category: 'PocketShell' },
			{ command: 'pocketshell.env.unset', title: 'Env: Unset', category: 'PocketShell' },
		],
	},
	register: registerEnv,
};
