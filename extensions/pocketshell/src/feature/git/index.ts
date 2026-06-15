/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from '../manifest';
import { registerGit } from './git-commands';

export const GIT_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.git.browse', title: 'Git: Browse Repositories', category: 'PocketShell', icon: '$(repo)' },
			{ command: 'pocketshell.git.status', title: 'Git: Status', category: 'PocketShell', icon: '$(git-branch)' },
			{ command: 'pocketshell.git.branches', title: 'Git: Branches', category: 'PocketShell' },
			{ command: 'pocketshell.git.history', title: 'Git: History', category: 'PocketShell', icon: '$(history)' },
			{ command: 'pocketshell.git.pull', title: 'Git: Pull', category: 'PocketShell', icon: '$(repo-pull)' },
		],
	},
	register: registerGit,
};
