/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { TmuxSessionPseudoterminal } from './tmux-session-terminal';

/**
 * Minimal view of a pane-bearing tmux pseudoterminal + the host it belongs to.
 *
 * This is the common denominator that {@link detectAndForwardPorts} needs from
 * EITHER registry:
 *   - the tmux-ui {@link RegisteredTmuxSession} (standalone tmux-ui terminals), or
 *   - the surface {@link SessionTerminalRegistry} entry (canonical-tree sessions
 *     opened via `surface.connect` / `surface.openSession`).
 *
 * Both ultimately hold a {@link TmuxSessionPseudoterminal} and a numeric host id;
 * the detect-and-forward helper only needs those two to capture the active pane
 * and run the remote `ss`/`netstat` probe over the session's SSH connection.
 */
export interface DetectPortsPtySource {
	/** Stable SSH host id this pty's session belongs to (forwarding is per-host). */
	hostId: number;
	/** The tmux -CC pseudoterminal backing the session terminal. */
	pty: TmuxSessionPseudoterminal;
}

/**
 * Structural view of a surface-style registry: a list of `(hostId, sessionName,
 * terminal)` entries plus a `(hostId, sessionName)` → pty getter.
 *
 * Kept vscode-free (terminal is `unknown`) so the resolver can be unit-tested
 * without the VS Code API. The real {@link SessionTerminalRegistry} satisfies
 * this structurally (`list()` returns `SessionTerminalEntry<vscode.Terminal>[]`
 * and `getPty(hostId, sessionName?)` returns the pty).
 */
export interface SurfaceRegistryLookup {
	/** Snapshot of all registered session terminals. */
	list(): ReadonlyArray<{ hostId: number; sessionName: string; terminal: unknown }>;
	/** Get the pty for a (host, session), or the host's first pty if sessionName is omitted. */
	getPty(hostId: number, sessionName?: string): TmuxSessionPseudoterminal | undefined;
}

/**
 * Read `(hostId, sessionName)` from a canonical-tree session node OR a plain
 * `{hostId, sessionName?}` object (the shapes the right-click menu and command
 * palette pass as `element`). Returns undefined for shapes that carry neither.
 *
 * The canonical-tree session node (`CanonicalSessionNode` with `kind: 'session'`)
 * carries these both nested under `entry` AND as top-level passthrough fields.
 */
export function readSessionIdentity(element: unknown): { hostId: number; sessionName?: string } | undefined {
	if (!element || typeof element !== 'object') {
		return undefined;
	}
	const node = element as Record<string, unknown>;
	// Canonical-tree session node: top-level passthrough hostId/sessionName.
	if (typeof node.hostId === 'number') {
		return {
			hostId: node.hostId,
			sessionName: typeof node.sessionName === 'string' ? node.sessionName : undefined,
		};
	}
	// Canonical-tree session node nested under `entry` (SessionTerminalEntry shape).
	const entry = node.entry as Record<string, unknown> | undefined;
	if (entry && typeof entry.hostId === 'number') {
		return {
			hostId: entry.hostId,
			sessionName: typeof entry.sessionName === 'string' ? entry.sessionName : undefined,
		};
	}
	return undefined;
}

/**
 * Resolve a detect-ports target from the SURFACE registry (the canonical-tree
 * sessions), used as a FALLBACK when the tmux-ui registry's `resolveEntry`
 * returns undefined (#108: canonical-tree sessions are invisible to the tmux-ui
 * registry).
 *
 * Resolution order:
 *   1. If `element` carries a `(hostId, sessionName)` identity (canonical-tree
 *      node), look up that exact session's pty.
 *   2. Otherwise, match `activeTerminal` against a registered session's
 *      terminal and use that session's pty (the right-click-on-terminal path).
 *
 * Returns the `{hostId, pty}` source, or undefined if no surface session
 * matches. This function is PURE (no vscode import) so it can be unit-tested.
 */
export function resolveSurfacePty(
	registry: SurfaceRegistryLookup,
	element: unknown,
	activeTerminal: unknown,
): DetectPortsPtySource | undefined {
	// 1. Canonical-tree node (or {hostId, sessionName?}) passed as the element.
	const identity = readSessionIdentity(element);
	if (identity) {
		const pty = registry.getPty(identity.hostId, identity.sessionName);
		if (pty) {
			return { hostId: identity.hostId, pty };
		}
	}

	// 2. Active-terminal fallback (right-click in the terminal context menu, or
	//    no element at all): find the surface session whose terminal is active.
	if (activeTerminal !== undefined) {
		for (const entry of registry.list()) {
			if (entry.terminal === activeTerminal) {
				const pty = registry.getPty(entry.hostId, entry.sessionName);
				if (pty) {
					return { hostId: entry.hostId, pty };
				}
			}
		}
	}

	return undefined;
}
