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
import { FILES_FEATURE } from './files';

// Each wired feature appends itself here (one import + one array element per batch).
export const FEATURES: FeatureRegistration[] = [
	GIT_FEATURE,
	JOBS_FEATURE,
	BOOTSTRAP_FEATURE,
	ENV_FEATURE,
	LOGS_FEATURE,
	USAGE_FEATURE,
	AGENT_DETECT_FEATURE,
	EDITOR_FEATURE,
	TERMINAL_FEATURE,
	HOOKS_FEATURE,
	REPLY_FEATURE,
	FILES_FEATURE,
];
