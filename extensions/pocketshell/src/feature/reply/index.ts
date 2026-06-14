/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from '../manifest';
import { registerReply } from './reply-commands';

export const REPLY_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.reply.send', title: 'Reply: Send', category: 'PocketShell', icon: '$(send)' },
			{ command: 'pocketshell.reply.queue', title: 'Reply: Queue', category: 'PocketShell', icon: '$(checklist)' },
			{ command: 'pocketshell.reply.status', title: 'Reply: Queue Status', category: 'PocketShell', icon: '$(info)' },
		],
	},
	register: registerReply,
};
