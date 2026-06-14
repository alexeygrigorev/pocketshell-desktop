/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from '../manifest';
import { registerPalette } from './palette-commands';

export const PALETTE_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.palette.open', title: 'Open Slash Command Palette', category: 'PocketShell', icon: '$(symbol-text)' },
			{ command: 'pocketshell.palette.listCommands', title: 'List Registered Commands', category: 'PocketShell' },
			{ command: 'pocketshell.palette.registerCommand', title: 'Register Command', category: 'PocketShell', icon: '$(add)' },
		],
	},
	register: registerPalette,
};
