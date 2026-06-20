/**
 * Unit-integration test for `StartupAutoConnector.run` (#94 + #98 landing).
 *
 * The pure decider (`decideStartupAction`) is covered by `decision.test.ts`.
 * This file targets the THIN DISPATCH in `StartupAutoConnector.run`:
 *
 *   - `connect` → fires `pocketshell.surface.connect` with the last host id.
 *   - `pick`    → focuses the `pocketshell.hosts` landing view (#98: the
 *                 server list IS the picker — no transient quick-pick).
 *   - `noop`    → does nothing.
 *
 * The SUT does `import * as vscode from 'vscode'`. vitest.config.ts has NO
 * vscode alias/stub, so we mock the bare specifier at the top of the file with
 * a factory. This test validates that the factory mock actually intercepts the
 * non-installed `vscode` module.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Must be hoisted above the SUT import. vitest hoists vi.mock calls
// automatically, but keep the literal shape the task specified.
vi.mock('vscode', () => ({
	commands: { executeCommand: vi.fn() },
	window: { showQuickPick: vi.fn() },
	l10n: { t: (s: string) => s },
}));

import * as vscode from 'vscode';
import { StartupAutoConnector } from '../../../extensions/pocketshell/src/feature/startup';
import type { ConnectionService } from '../../../extensions/pocketshell/src/connection-service';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal host shape the connector narrows via `toStartupHosts`. */
function host(over: Partial<{ id: number; name: string; hostname: string; username: string; port: number }> = {}) {
	return {
		id: 1,
		name: 'alpha',
		hostname: 'alpha.example',
		username: 'ubuntu',
		port: 22,
		...over,
	};
}

/**
 * Fake the service minimally — the SUT only calls `service.getHosts()`.
 * A plain object cast as `ConnectionService` is sufficient.
 */
function makeService(hosts: ReturnType<typeof host>[]): ConnectionService {
	return { getHosts: () => Promise.resolve(hosts) } as unknown as ConnectionService;
}

const executeCommand = vscode.commands.executeCommand as unknown as ReturnType<typeof vi.fn>;
const showQuickPick = vscode.window.showQuickPick as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StartupAutoConnector.run', () => {
	beforeEach(() => {
		executeCommand.mockReset();
		showQuickPick.mockReset();
	});

	it('connect: fires pocketshell.surface.connect with the last host id', async () => {
		const service = makeService([host({ id: 7, name: 'seven' })]);
		const connector = new StartupAutoConnector(service);

		const action = await connector.run({ autoConnect: true, lastHostId: 7 });

		expect(executeCommand).toHaveBeenCalledTimes(1);
		expect(executeCommand).toHaveBeenCalledWith('pocketshell.surface.connect', 7);
		expect(showQuickPick).not.toHaveBeenCalled();
		expect(action.kind).toBe('connect');
	});

	it('pick: focuses the pocketshell.hosts landing view (#98) and does NOT auto-connect or show a quick-pick', async () => {
		const service = makeService([
			host({ id: 7, name: 'seven' }),
			host({ id: 8, name: 'eight', hostname: 'eight.example' }),
		]);
		const connector = new StartupAutoConnector(service);

		const action = await connector.run({ autoConnect: false, lastHostId: null });

		// The landing view is surfaced; the user picks from the persistent list.
		expect(executeCommand).toHaveBeenCalledTimes(1);
		expect(executeCommand).toHaveBeenCalledWith('pocketshell.hosts.focus');
		// No transient quick-pick anymore (#98 landing integration).
		expect(showQuickPick).not.toHaveBeenCalled();
		// Crucially, pick does NOT auto-connect — the user selects a server.
		const connectCalls = (executeCommand.mock.calls as unknown[][]).filter(
			([cmd]) => cmd === 'pocketshell.surface.connect',
		);
		expect(connectCalls).toHaveLength(0);
		expect(action.kind).toBe('pick');
	});

	it('pick: focus failure is swallowed (landing view not yet registered during early activation)', async () => {
		const service = makeService([host({ id: 7, name: 'seven' })]);
		const connector = new StartupAutoConnector(service);

		// Simulate the view focus command throwing (view not registered yet).
		executeCommand.mockRejectedValueOnce(new Error('view not found'));

		// Must not throw — focus is best-effort.
		const action = await connector.run({ autoConnect: false, lastHostId: null });

		expect(executeCommand).toHaveBeenCalledWith('pocketshell.hosts.focus');
		expect(action.kind).toBe('pick');
	});

	it('noop: no hosts → neither executeCommand nor showQuickPick is called', async () => {
		const service = makeService([]);
		const connector = new StartupAutoConnector(service);

		const action = await connector.run({ autoConnect: true, lastHostId: 7 });

		expect(executeCommand).not.toHaveBeenCalled();
		expect(showQuickPick).not.toHaveBeenCalled();
		expect(action.kind).toBe('noop');
	});
});
