/**
 * Unit tests for the #108 detect-ports surface-registry fallback resolver.
 *
 * Context: the right-click "Detect Ports" menu on a canonical-tree session
 * (pocketshellSession) used to be a silent no-op because the detect-ports
 * commands resolved the session via the tmux-ui TmuxSessionRegistry, while
 * canonical-tree sessions live in the SURFACE SessionTerminalRegistry. The fix
 * adds a surface-registry FALLBACK (purely additive — the tmux-ui path still
 * resolves first). These tests cover the fallback resolution helper itself,
 * which is pure (no VS Code API) so it can be unit-tested directly.
 *
 * Covers:
 *   - canonical-tree session node → exact (hostId, sessionName) pty lookup
 *   - nested `entry` shape (SessionTerminalEntry under a tree node)
 *   - plain {hostId, sessionName?} object
 *   - active-terminal fallback (right-click in terminal context menu)
 *   - sessionName omitted → host's first pty (single-session back-compat)
 *   - miss cases (no matching session, no surface registry, unknown element)
 */

import { describe, expect, it, vi } from 'vitest';
import {
	readSessionIdentity,
	resolveSurfacePty,
	type SurfaceRegistryLookup,
} from '../../../extensions/pocketshell/src/feature/tmux-ui/detect-ports-resolver';
import type { TmuxSessionPseudoterminal } from '../../../extensions/pocketshell/src/feature/tmux-ui/tmux-session-terminal';

/** Build a fake surface-registry lookup with controllable entries + ptys. */
function fakeRegistry(
	entries: Array<{ hostId: number; sessionName: string; terminal: unknown }>,
	ptys: Map<string, TmuxSessionPseudoterminal>,
): SurfaceRegistryLookup {
	return {
		list: () => entries,
		getPty: (hostId: number, sessionName?: string) => {
			if (sessionName !== undefined) {
				return ptys.get(`${hostId}:${sessionName}`);
			}
			// Mirror SessionTerminalRegistry: fall back to the host's first pty.
			const first = entries.find((entry) => entry.hostId === hostId);
			return first ? ptys.get(`${first.hostId}:${first.sessionName}`) : undefined;
		},
	};
}

/** A unique sentinel standing in for a vscode.Terminal / pty. */
const pty = (id: string) => ({ __ptyId: id }) as unknown as TmuxSessionPseudoterminal;
const terminal = (id: string) => ({ __terminalId: id });

describe('readSessionIdentity', () => {
	it('reads top-level hostId + sessionName from a canonical-tree session node', () => {
		const node = {
			kind: 'session',
			hostId: 7,
			sessionName: 'pocketshell-host',
			hostLabel: 'host',
			entry: { hostId: 7, sessionName: 'pocketshell-host', hostLabel: 'host' },
		};
		expect(readSessionIdentity(node)).toEqual({ hostId: 7, sessionName: 'pocketshell-host' });
	});

	it('reads nested entry.{hostId,sessionName} when top-level hostId is absent', () => {
		const node = { kind: 'session', entry: { hostId: 3, sessionName: 'shell', hostLabel: 'h' } };
		expect(readSessionIdentity(node)).toEqual({ hostId: 3, sessionName: 'shell' });
	});

	it('reads a plain {hostId, sessionName?} object', () => {
		expect(readSessionIdentity({ hostId: 11, sessionName: 'work' })).toEqual({ hostId: 11, sessionName: 'work' });
		expect(readSessionIdentity({ hostId: 11 })).toEqual({ hostId: 11, sessionName: undefined });
	});

	it('returns undefined for non-identity shapes', () => {
		expect(readSessionIdentity(undefined)).toBeUndefined();
		expect(readSessionIdentity(null)).toBeUndefined();
		expect(readSessionIdentity('not-an-object')).toBeUndefined();
		expect(readSessionIdentity({ foo: 'bar' })).toBeUndefined();
		expect(readSessionIdentity({ entry: { hostId: 'no', sessionName: 'x' } })).toBeUndefined();
	});
});

describe('resolveSurfacePty (canonical-tree node fallback)', () => {
	it('resolves the exact (hostId, sessionName) pty from a canonical-tree node', () => {
		const p = pty('p1');
		const registry = fakeRegistry(
			[{ hostId: 5, sessionName: 'pocketshell-host', terminal: terminal('t1') }],
			new Map([['5:pocketshell-host', p]]),
		);
		const node = { kind: 'session', hostId: 5, sessionName: 'pocketshell-host', hostLabel: 'host' };

		const result = resolveSurfacePty(registry, node, undefined);

		expect(result).toEqual({ hostId: 5, pty: p });
	});

	it('resolves via nested entry shape', () => {
		const p = pty('p2');
		const registry = fakeRegistry(
			[{ hostId: 9, sessionName: 'shell', terminal: terminal('t2') }],
			new Map([['9:shell', p]]),
		);
		const node = { kind: 'session', entry: { hostId: 9, sessionName: 'shell', hostLabel: 'h' } };

		expect(resolveSurfacePty(registry, node, undefined)).toEqual({ hostId: 9, pty: p });
	});

	it('falls back to the host first pty when sessionName is absent', () => {
		const p = pty('p3');
		const registry = fakeRegistry(
			[{ hostId: 2, sessionName: 'pocketshell-host', terminal: terminal('t3') }],
			new Map([['2:pocketshell-host', p]]),
		);
		const node = { kind: 'session', hostId: 2, hostLabel: 'h' };

		expect(resolveSurfacePty(registry, node, undefined)).toEqual({ hostId: 2, pty: p });
	});

	it('returns undefined when the (hostId, sessionName) is not registered', () => {
		const registry = fakeRegistry([], new Map());
		const node = { kind: 'session', hostId: 99, sessionName: 'ghost', hostLabel: 'h' };

		expect(resolveSurfacePty(registry, node, undefined)).toBeUndefined();
	});
});

describe('resolveSurfacePty (active-terminal fallback)', () => {
	it('resolves the session whose terminal matches activeTerminal when element has no identity', () => {
		const activeT = terminal('active');
		const p = pty('p4');
		const registry = fakeRegistry(
			[
				{ hostId: 1, sessionName: 'other', terminal: terminal('t-other') },
				{ hostId: 8, sessionName: 'pocketshell-host', terminal: activeT },
			],
			new Map([
				['1:other', pty('p-other')],
				['8:pocketshell-host', p],
			]),
		);

		// element is a non-identity object (e.g. a terminal/context-menu payload).
		const result = resolveSurfacePty(registry, { foo: 'bar' }, activeT);

		expect(result).toEqual({ hostId: 8, pty: p });
	});

	it('resolves via active terminal when element is undefined (command palette)', () => {
		const activeT = terminal('active2');
		const p = pty('p5');
		const registry = fakeRegistry(
			[{ hostId: 4, sessionName: 'shell', terminal: activeT }],
			new Map([['4:shell', p]]),
		);

		expect(resolveSurfacePty(registry, undefined, activeT)).toEqual({ hostId: 4, pty: p });
	});

	it('prefers the explicit node identity over the active terminal', () => {
		const activeT = terminal('active3');
		const nodeP = pty('node-p');
		const activeP = pty('active-p');
		const registry = fakeRegistry(
			[
				{ hostId: 6, sessionName: 'node-session', terminal: terminal('t-node') },
				{ hostId: 7, sessionName: 'active-session', terminal: activeT },
			],
			new Map([
				['6:node-session', nodeP],
				['7:active-session', activeP],
			]),
		);
		const node = { kind: 'session', hostId: 6, sessionName: 'node-session', hostLabel: 'h' };

		// The node wins even though activeTerminal points at a different session.
		expect(resolveSurfacePty(registry, node, activeT)).toEqual({ hostId: 6, pty: nodeP });
	});

	it('returns undefined when activeTerminal matches no registered session', () => {
		const registry = fakeRegistry(
			[{ hostId: 1, sessionName: 'shell', terminal: terminal('t-x') }],
			new Map([['1:shell', pty('p-x')]]),
		);

		expect(resolveSurfacePty(registry, undefined, terminal('not-registered'))).toBeUndefined();
	});

	it('returns undefined when activeTerminal is undefined and element has no identity', () => {
		const registry = fakeRegistry(
			[{ hostId: 1, sessionName: 'shell', terminal: terminal('t-y') }],
			new Map([['1:shell', pty('p-y')]]),
		);

		expect(resolveSurfacePty(registry, { foo: 'bar' }, undefined)).toBeUndefined();
	});
});

describe('resolveSurfacePty (miss cases)', () => {
	it('returns undefined when the registry has no entries at all', () => {
		const registry = fakeRegistry([], new Map());
		const node = { kind: 'session', hostId: 1, sessionName: 'shell', hostLabel: 'h' };

		expect(resolveSurfacePty(registry, node, terminal('whatever'))).toBeUndefined();
	});

	it('never throws on an unfamiliar element shape', () => {
		const registry = fakeRegistry([], new Map());
		const lookup = () => resolveSurfacePty(registry, 42 as unknown, 'x' as unknown);
		expect(lookup).not.toThrow();
		expect(lookup()).toBeUndefined();
	});

	it('does not consult the active terminal when the element identity resolves successfully', () => {
		// Guards the "node wins over active terminal" ordering even with a spy.
		const nodeP = pty('node-p2');
		const registry = fakeRegistry(
			[{ hostId: 10, sessionName: 's', terminal: terminal('t10') }],
			new Map([['10:s', nodeP]]),
		);
		const spy = vi.fn();
		const wrapped: SurfaceRegistryLookup = {
			list: () => registry.list(),
			getPty: (hostId, sessionName) => {
				spy(hostId, sessionName);
				return registry.getPty(hostId, sessionName);
			},
		};
		const node = { kind: 'session', hostId: 10, sessionName: 's', hostLabel: 'h' };

		const result = resolveSurfacePty(wrapped, node, terminal('ignored'));

		expect(result).toEqual({ hostId: 10, pty: nodeP });
		// The active-terminal path iterates list(); since the identity path hit,
		// list() should never be called (only getPty for the identity).
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith(10, 's');
	});
});
