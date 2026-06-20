/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from '../manifest';
import { registerConversation } from './conversation-commands';

export const CONVERSATION_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.conversation.openActivePane', title: 'Conversation: Open Active Pane', category: 'PocketShell', icon: '$(comment-discussion)' },
			{ command: 'pocketshell.conversation.quoteReply', title: 'Conversation: Quote Reply', category: 'PocketShell', icon: '$(quote)' },
		],
		menus: {
			'view/item/context': [
				{ command: 'pocketshell.conversation.openActivePane', when: 'view == pocketshell.sessions && viewItem == pocketshellSession', group: '0_conversation@1' },
			],
			'terminal/context': [
				{ command: 'pocketshell.conversation.openActivePane', group: 'pocketshell_conversation' },
			],
		},
	},
	register: registerConversation,
};
