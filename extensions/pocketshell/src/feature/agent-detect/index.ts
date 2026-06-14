/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from '../manifest';
import { registerAgentDetect } from './agent-detect-commands';

export const AGENT_DETECT_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.agent.detect', title: 'Agent: Detect on Host', category: 'PocketShell', icon: '$(robot)' },
			{ command: 'pocketshell.agent.showDetected', title: 'Agent: Show Detected', category: 'PocketShell' },
		],
	},
	register: registerAgentDetect,
};
