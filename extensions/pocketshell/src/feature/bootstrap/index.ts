/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from '../manifest';
import { registerBootstrap } from './bootstrap-commands';

export const BOOTSTRAP_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.bootstrap.status', title: 'Bootstrap: Status', category: 'PocketShell' },
			{ command: 'pocketshell.bootstrap.install', title: 'Bootstrap: Install', category: 'PocketShell' },
			{ command: 'pocketshell.bootstrap.upgrade', title: 'Bootstrap: Upgrade', category: 'PocketShell' },
		],
	},
	register: registerBootstrap,
};
