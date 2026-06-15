/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from './manifest';
import { GIT_FEATURE } from './git';
import { JOBS_FEATURE } from './jobs';
import { BOOTSTRAP_FEATURE } from './bootstrap';
import { ENV_FEATURE } from './env';
import { LOGS_FEATURE } from './logs';
import { USAGE_FEATURE } from './usage';
import { AGENT_DETECT_FEATURE } from './agent-detect';
import { EDITOR_FEATURE } from './editor';
import { TERMINAL_FEATURE } from './terminal';
import { HOOKS_FEATURE } from './hooks';
import { REPLY_FEATURE } from './reply';
import { CONVERSATION_FEATURE } from './conversation';
import { PROMPT_COMPOSER_FEATURE } from './prompt-composer';
import { SNIPPETS_FEATURE } from './snippets';
import { FILES_FEATURE } from './files';
import { POCKETSHELL_DETECT_FEATURE } from './pocketshell-detect';
import { PALETTE_FEATURE } from './palette';
import { TMUX_FEATURE } from './tmux';
import { TMUX_UI_FEATURE } from './tmux-ui';
import { SESSIONS_FEATURE } from './sessions';
import { PORT_FORWARDING_FEATURE } from './port-forwarding';

// Each wired feature appends itself here (one import + one array element per batch).
export const FEATURES: FeatureRegistration[] = [
	GIT_FEATURE,
	JOBS_FEATURE,
	BOOTSTRAP_FEATURE,
	ENV_FEATURE,
	LOGS_FEATURE,
	USAGE_FEATURE,
	AGENT_DETECT_FEATURE,
	POCKETSHELL_DETECT_FEATURE,
	EDITOR_FEATURE,
	TERMINAL_FEATURE,
	SESSIONS_FEATURE,
	PORT_FORWARDING_FEATURE,
	TMUX_FEATURE,
	TMUX_UI_FEATURE,
	HOOKS_FEATURE,
	REPLY_FEATURE,
	PROMPT_COMPOSER_FEATURE,
	SNIPPETS_FEATURE,
	CONVERSATION_FEATURE,
	FILES_FEATURE,
	PALETTE_FEATURE,
];
