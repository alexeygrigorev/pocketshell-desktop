/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from '../manifest';
import { registerAssistant } from './assistant-commands';

/**
 * The action-assistant feature (app §5): a provider-agnostic LLM agent loop
 * that takes a typed request and drives the app via a 17-tool catalog, with a
 * confirm gate on mutating actions + a CommandSafety blocklist.
 *
 * Dispatch 1 ships FOUNDATION: the loop + OpenAI client + 11 read-only/nav
 * tools (implemented) + 6 mutating tools (declared but stubbed) + the confirm
 * gate UX (built but inactive) + SecretStorage-backed config + the
 * `pocketshell.assistant.ask` / `.configure` commands. Dispatch 2 fills in the
 * 6 mutating tool implementations behind the gate.
 *
 * The pure, vscode-free core (`loop + tools + LLM client + CommandSafety +
 * FolderResolver`) lives in canonical `src/assistant/` mirrored byte-identical
 * to `extensions/pocketshell/src/backend/assistant/` (lesson #19). The
 * vscode-dependent glue (this directory: desktop actions, config store,
 * commands) is feature-layer and NOT mirrored.
 */
export const ASSISTANT_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.assistant.ask', title: 'Ask the assistant', category: 'PocketShell', icon: '$(sparkle)' },
			{ command: 'pocketshell.assistant.configure', title: 'Configure the assistant', category: 'PocketShell', icon: '$(gear)' },
		],
		menus: {
			commandPalette: [
				{ command: 'pocketshell.assistant.ask' },
				{ command: 'pocketshell.assistant.configure' },
			],
		},
	},
	register: registerAssistant,
};
