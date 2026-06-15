import type { FeatureRegistration } from '../manifest';
import { registerSessions } from './sessions-commands';

export const SESSIONS_FEATURE: FeatureRegistration = {
	manifest: {
		commands: [
			{ command: 'pocketshell.sessions.create', title: 'Sessions: Create Shell or Agent Session', category: 'PocketShell', icon: '$(terminal-tmux)' },
			{ command: 'pocketshell.session.create', title: 'Session: Create Shell or Agent Session', category: 'PocketShell', icon: '$(terminal-tmux)' },
		],
	},
	register: registerSessions,
};
