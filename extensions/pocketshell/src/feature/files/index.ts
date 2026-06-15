/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from '../manifest';
import { registerFiles } from './files-commands';

export const FILES_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.files.browse', title: 'Files: Browse', category: 'PocketShell', icon: '$(folder)' },
			{ command: 'pocketshell.files.openPreview', title: 'Files: Open Preview', category: 'PocketShell', icon: '$(preview)' },
			{ command: 'pocketshell.files.review', title: 'Files: Review with Agent', category: 'PocketShell', icon: '$(comment-add)' },
			{ command: 'pocketshell.files.watch', title: 'Files: Watch Directory', category: 'PocketShell', icon: '$(eye)' },
			{ command: 'pocketshell.files.stopWatch', title: 'Files: Stop Watching', category: 'PocketShell', icon: '$(eye-closed)' },
		],
	},
	register: registerFiles,
};
