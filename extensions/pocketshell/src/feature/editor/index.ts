/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from '../manifest';
import { registerEditor } from './editor-commands';

export const EDITOR_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.editor.open', title: 'Editor: Open Remote Document', category: 'PocketShell', icon: '$(go-to-file)' },
			{ command: 'pocketshell.editor.save', title: 'Editor: Save', category: 'PocketShell', icon: '$(save)' },
			{ command: 'pocketshell.editor.revert', title: 'Editor: Revert', category: 'PocketShell', icon: '$(discard)' },
		],
	},
	register: registerEditor,
};
