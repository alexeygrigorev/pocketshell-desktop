/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from '../manifest';
import { registerPocketshellDetect } from './pocketshell-detect-commands';

export const POCKETSHELL_DETECT_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.pocketshell.detect', title: 'PocketShell: Detect on Host', category: 'PocketShell', icon: '$(search)' },
			{ command: 'pocketshell.pocketshell.status', title: 'PocketShell: Show Status', category: 'PocketShell', icon: '$(info)' },
			{ command: 'pocketshell.pocketshell.install', title: 'PocketShell: Install/Upgrade', category: 'PocketShell', icon: '$(cloud-download)' },
		],
	},
	register: registerPocketshellDetect,
};
