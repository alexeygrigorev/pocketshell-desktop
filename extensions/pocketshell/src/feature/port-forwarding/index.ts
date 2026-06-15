/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from '../manifest';
import { registerPortForwarding } from './port-forwarding-commands';

export const PORT_FORWARDING_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.portForwarding.open', title: 'Port Forwarding: Open Panel', category: 'PocketShell', icon: '$(plug)' },
		],
		menus: {
			'view/item/context': [
				{ command: 'pocketshell.portForwarding.open', when: 'view == pocketshell.hosts', group: '0_terminal' },
			],
		},
	},
	register: registerPortForwarding,
};
