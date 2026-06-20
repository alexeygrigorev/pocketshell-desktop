/**
 * Unit tests for `buildHostStatusBadge` (#98 landing — host status badges).
 *
 * The badge builder is pure modulo `vscode.l10n.t` (a passthrough in tests).
 * It maps the desktop connection layer's `ConnectionState` to the app-parity
 * host-card badge (Unknown / Connected / Connecting / Disconnecting / Error /
 * Disconnected). Each state must yield a non-empty label + a theme icon.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
	l10n: { t: (s: string) => s },
}));

import { buildHostStatusBadge } from '../../../extensions/pocketshell/src/host-tree-provider';
import { ConnectionState } from '../../../extensions/pocketshell/src/backend/ssh/connection/connection-manager';

describe('buildHostStatusBadge', () => {
	it('Idle → Unknown badge (app-parity default; never connected this session)', () => {
		const badge = buildHostStatusBadge(ConnectionState.Idle);
		expect(badge.label).toBe('Unknown');
		expect(badge.icon).toBe('server');
		expect(badge.color).toBeUndefined();
	});

	it('Connected → Connected badge with success color + plug icon', () => {
		const badge = buildHostStatusBadge(ConnectionState.Connected);
		expect(badge.label).toBe('Connected');
		expect(badge.icon).toBe('plug');
		expect(badge.color).toBe('testing.iconPassed');
	});

	it('Connecting → Connecting badge with a spinner icon and no color', () => {
		const badge = buildHostStatusBadge(ConnectionState.Connecting);
		expect(badge.label).toBe('Connecting…');
		expect(badge.icon).toBe('loading~spin');
		expect(badge.color).toBeUndefined();
	});

	it('Disconnecting → Disconnecting badge with a spinner icon', () => {
		const badge = buildHostStatusBadge(ConnectionState.Disconnecting);
		expect(badge.label).toBe('Disconnecting…');
		expect(badge.icon).toBe('loading~spin');
	});

	it('Error → Error badge with failure color + error icon', () => {
		const badge = buildHostStatusBadge(ConnectionState.Error);
		expect(badge.label).toBe('Error');
		expect(badge.icon).toBe('error');
		expect(badge.color).toBe('testing.iconFailed');
	});

	it('Disconnected → Disconnected badge (circle-slash)', () => {
		const badge = buildHostStatusBadge(ConnectionState.Disconnected);
		expect(badge.label).toBe('Disconnected');
		expect(badge.icon).toBe('circle-slash');
	});

	it('every state yields a non-empty label and icon', () => {
		const states: ConnectionState[] = [
			ConnectionState.Idle,
			ConnectionState.Connecting,
			ConnectionState.Connected,
			ConnectionState.Disconnecting,
			ConnectionState.Disconnected,
			ConnectionState.Error,
		];
		for (const state of states) {
			const badge = buildHostStatusBadge(state);
			expect(badge.label.length).toBeGreaterThan(0);
			expect(badge.icon.length).toBeGreaterThan(0);
		}
	});
});
