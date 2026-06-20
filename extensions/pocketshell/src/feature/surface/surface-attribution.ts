/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	ConversationAttributionService,
	enrichActivePaneConversationContext,
	enrichConversationSessions,
	type AgentType,
	type ConversationAttributionResult,
} from '../../backend/agents';
import { SessionReader } from '../../backend/agents/conversation';
import { TmuxSessionPseudoterminal } from '../tmux-ui/tmux-session-terminal';

/**
 * Shared conversation-attribution helper for the surface layer (#106).
 *
 * Mirrors the attribution pipeline of `pocketshell.tmux-ui.getActivePaneConversationHint`
 * but reads the active-pane metadata directly from a surface-registered
 * {@link TmuxSessionPseudoterminal} (surface sessions live in the surface
 * {@link SessionTerminalRegistry}, NOT the tmux-ui registry the hint command
 * consults). Used by both the per-session open-conversation/open-composer
 * commands (surface-commands.ts) and the conversation-default controller
 * (session-conversation-default-controller.ts) so the attribution algorithm
 * exists in exactly one place.
 *
 * @returns the uniquely-attributed `{id, agentType}` for a concrete match, or
 *          undefined for no-match / ambiguous / not-ready.
 */
export async function attributeSurfaceSession(
	pty: TmuxSessionPseudoterminal,
	connection: ReturnType<TmuxSessionPseudoterminal['getConnection']>,
	attributionService = new ConversationAttributionService(),
): Promise<{ id: string; agentType: AgentType } | undefined> {
	const rawMetadata = pty.getActivePaneMetadata();
	if (!rawMetadata) {
		return undefined;
	}
	const metadata = await enrichActivePaneConversationContext(connection, rawMetadata);
	const listedSessions = await new SessionReader(connection).listSessions();
	const enrichedSessions = await enrichConversationSessions(connection, listedSessions);
	const result: ConversationAttributionResult = attributionService.attribute(metadata, enrichedSessions);
	if (result.kind === 'match' && result.session) {
		return { id: result.session.id, agentType: result.session.agentType };
	}
	return undefined;
}
