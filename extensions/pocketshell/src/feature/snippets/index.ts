/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from '../manifest';
import { registerSnippets } from './snippets-commands';

export const SNIPPETS_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.snippets.create', title: 'Snippets: Create Snippet or Template', category: 'PocketShell', icon: '$(add)' },
			{ command: 'pocketshell.snippets.edit', title: 'Snippets: Edit', category: 'PocketShell', icon: '$(edit)' },
			{ command: 'pocketshell.snippets.delete', title: 'Snippets: Delete', category: 'PocketShell', icon: '$(trash)' },
			{ command: 'pocketshell.snippets.list', title: 'Snippets: List', category: 'PocketShell', icon: '$(list-unordered)' },
			{ command: 'pocketshell.snippets.manage', title: 'Snippets: Manage Library', category: 'PocketShell', icon: '$(symbol-snippet)' },
			{ command: 'pocketshell.snippets.insertTerminal', title: 'Snippets: Insert into Terminal', category: 'PocketShell', icon: '$(terminal)' },
			{ command: 'pocketshell.snippets.openComposer', title: 'Snippets: Open in Composer', category: 'PocketShell', icon: '$(comment-add)' },
			{ command: 'pocketshell.snippets.run', title: 'Snippets: Run Snippet or Template', category: 'PocketShell', icon: '$(play)' },
		],
		menus: {
			'terminal/context': [
				{ command: 'pocketshell.snippets.insertTerminal', group: 'pocketshell_snippets' },
				{ command: 'pocketshell.snippets.openComposer', group: 'pocketshell_snippets' },
			],
			'view/item/context': [
				{
					command: 'pocketshell.snippets.insertTerminal',
					when: 'view == pocketshell.sessions && viewItem == pocketshellSession',
					group: '1_pane@1',
				},
				{
					command: 'pocketshell.snippets.openComposer',
					when: 'view == pocketshell.sessions && viewItem == pocketshellSession',
					group: '1_pane@2',
				},
			],
		},
	},
	register: registerSnippets,
};
