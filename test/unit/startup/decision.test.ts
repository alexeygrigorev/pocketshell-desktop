/**
 * Unit tests for the pure startup-connection decider.
 *
 * Covers the connect / pick / noop branches and every documented edge case.
 * The decider is pure (no vscode, no disk), so tests are plain assertions.
 */

import { describe, it, expect } from 'vitest';
import { decideStartupAction, type StartupHost } from '../../../src/startup';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function host(over: Partial<StartupHost> = {}): StartupHost {
	return {
		id: 1,
		name: 'alpha',
		hostname: 'alpha.example',
		username: 'ubuntu',
		port: 22,
		...over,
	};
}

const HOST_A = host({ id: 10, name: 'a' });
const HOST_B = host({ id: 20, name: 'b' });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('decideStartupAction', () => {
	describe('noop', () => {
		it('returns noop when there are zero hosts, regardless of autoConnect/lastHostId', () => {
			expect(decideStartupAction({ autoConnect: true, lastHostId: 5, hosts: [] })).toEqual({ kind: 'noop' });
			expect(decideStartupAction({ autoConnect: false, lastHostId: null, hosts: [] })).toEqual({ kind: 'noop' });
			expect(decideStartupAction({ autoConnect: true, lastHostId: null, hosts: [] })).toEqual({ kind: 'noop' });
		});
	});

	describe('connect (happy path)', () => {
		it('connects when autoConnect is on and lastHostId points at an existing host', () => {
			const action = decideStartupAction({
				autoConnect: true,
				lastHostId: 20,
				hosts: [HOST_A, HOST_B],
			});
			expect(action).toEqual({ kind: 'connect', hostId: 20 });
		});

		it('connects to the exact lastHostId even when other hosts exist', () => {
			const action = decideStartupAction({
				autoConnect: true,
				lastHostId: 10,
				hosts: [HOST_A, HOST_B],
			});
			expect(action).toEqual({ kind: 'connect', hostId: 10 });
		});
	});

	describe('pick', () => {
		it('picks when autoConnect is false but hosts exist', () => {
			const action = decideStartupAction({
				autoConnect: false,
				lastHostId: 10,
				hosts: [HOST_A, HOST_B],
			});
			expect(action.kind).toBe('pick');
			if (action.kind === 'pick') {
				// non-vacuous: the returned hosts are the input hosts
				expect(action.hosts).toEqual([HOST_A, HOST_B]);
				expect(action.hosts.length).toBe(2);
			}
		});

		it('picks when autoConnect is true but lastHostId is null', () => {
			const action = decideStartupAction({
				autoConnect: true,
				lastHostId: null,
				hosts: [HOST_A],
			});
			expect(action.kind).toBe('pick');
			if (action.kind === 'pick') {
				expect(action.hosts).toEqual([HOST_A]);
			}
		});

		it('picks when lastHostId points at a host no longer in the list (stale hint)', () => {
			const action = decideStartupAction({
				autoConnect: true,
				lastHostId: 999, // gone
				hosts: [HOST_A, HOST_B],
			});
			expect(action.kind).toBe('pick');
			if (action.kind === 'pick') {
				// stale id (999) is NOT carried into the pick list
				expect(action.hosts.map((h) => h.id)).toEqual([10, 20]);
				expect(action.hosts.some((h) => h.id === 999)).toBe(false);
			}
		});

		it('picks (not connect) when autoConnect is off even with a valid lastHostId', () => {
			const action = decideStartupAction({
				autoConnect: false,
				lastHostId: 10,
				hosts: [HOST_A],
			});
			// explicit: autoConnect false must NOT connect, despite a present host
			expect(action.kind).not.toBe('connect');
			expect(action.kind).toBe('pick');
		});
	});

	describe('boundary: lastHostId 0', () => {
		it('treats lastHostId 0 as a real id (not nullish) when present', () => {
			const hostZero = host({ id: 0, name: 'zero' });
			const action = decideStartupAction({
				autoConnect: true,
				lastHostId: 0,
				hosts: [hostZero],
			});
			expect(action).toEqual({ kind: 'connect', hostId: 0 });
		});
	});
});
