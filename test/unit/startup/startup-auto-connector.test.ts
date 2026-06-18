/**
 * Unit-integration test for `StartupAutoConnector.run` (#94).
 *
 * The pure decider (`decideStartupAction`) is covered by `decision.test.ts`.
 * This file targets the THIN DISPATCH in `StartupAutoConnector.run` — does it
 * actually fire `pocketshell.surface.connect` on the `connect` branch, show a
 * quick-pick on `pick`, and do nothing on `noop`?
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

	it('pick → connect: shows quick-pick and connects to the chosen host', async () => {
		const service = makeService([
			host({ id: 7, name: 'seven' }),
			host({ id: 8, name: 'eight', hostname: 'eight.example' }),
		]);
		const connector = new StartupAutoConnector(service);

		// Resolve the quick-pick to the item whose hostId === 8.
		showQuickPick.mockImplementation((items: Array<{ hostId: number }>) => {
			return Promise.resolve(items.find((i) => i.hostId === 8));
		});

		const action = await connector.run({ autoConnect: false, lastHostId: null });

		expect(showQuickPick).toHaveBeenCalledTimes(1);
		expect(executeCommand).toHaveBeenCalledTimes(1);
		expect(executeCommand).toHaveBeenCalledWith('pocketshell.surface.connect', 8);
		expect(action.kind).toBe('pick');
	});

	it('pick → dismiss: dismiss (undefined) issues no connect command', async () => {
		const service = makeService([
			host({ id: 7, name: 'seven' }),
			host({ id: 8, name: 'eight', hostname: 'eight.example' }),
		]);
		const connector = new StartupAutoConnector(service);

		// User dismissed the quick-pick.
		showQuickPick.mockResolvedValue(undefined);

		const action = await connector.run({ autoConnect: false, lastHostId: null });

		expect(showQuickPick).toHaveBeenCalledTimes(1);
		expect(executeCommand).not.toHaveBeenCalled();
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
