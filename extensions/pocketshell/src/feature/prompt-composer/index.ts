/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from '../manifest';
import { registerPromptComposer } from './prompt-composer-commands';

export const PROMPT_COMPOSER_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.promptComposer.open', title: 'Prompt Composer: Open', category: 'PocketShell', icon: '$(comment-add)' },
		],
		menus: {
			'view/item/context': [
				{
					command: 'pocketshell.promptComposer.open',
					when: 'view == pocketshell.tmuxSessions && (viewItem == tmuxUiWindow || viewItem == tmuxUiPane)',
					group: '1_pane',
				},
			],
			'terminal/context': [
				{ command: 'pocketshell.promptComposer.open', group: 'pocketshell_promptComposer' },
			],
		},
	},
	register: registerPromptComposer,
};
