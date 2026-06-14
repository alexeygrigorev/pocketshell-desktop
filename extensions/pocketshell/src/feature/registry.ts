/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FeatureRegistration } from './manifest';
import { GIT_FEATURE } from './git';

// Each wired feature appends itself here (one import + one array element per batch).
export const FEATURES: FeatureRegistration[] = [
	GIT_FEATURE,
];
