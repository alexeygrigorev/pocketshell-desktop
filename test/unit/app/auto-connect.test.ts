/**
 * Unit tests for AutoConnectService.
 *
 * Uses mocks for ConnectionManager, HostStore, and SettingsStore
 * so no real SSH or disk I/O occurs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutoConnectService, AutoConnectEvent } from '../../../src/app/auto-connect';
import { Host } from '../../../src/ssh/data/host-store';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeHost(overrides: Partial<Host> = {}): Host {
  return {
    id: 1,
    name: 'Test Host',
    hostname: 'test.example.com',
    port: 22,
    username: 'testuser',
    keyPath: '~/.ssh/id_rsa',
    maxAutoPort: 10000,
    skipPortsBelow: 1000,
    scanIntervalSec: 5,
    enabled: true,
    createdAt: Date.now() - 60_000,
    lastConnectedAt: null,
    tmuxInstalled: null,
    lastBootstrapAt: null,
    pocketshellInstalled: null,
    pocketshellLastDetectedAt: null,
    pocketshellCliVersion: null,
    pocketshellExpectedCliVersion: null,
    pocketshellVersionCompatible: null,
    pocketshellDaemonRunning: null,
    pocketshellDaemonEnabled: null,
    usageCommandOverride: null,
    claudeProfilesJson: null,
    codexProfilesJson: null,
    ...overrides,
  };
}

interface MockSettingsStore {
  get: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}

function createMockSettingsStore(
  settings: { autoConnect: boolean; lastHostId: number | null; theme: 'dark' | 'light' | 'system' },
): MockSettingsStore {
  return {
    get: vi.fn(() => settings),
    load: vi.fn(() => settings),
    save: vi.fn(),
    update: vi.fn(),
  };
}

interface MockHostStore {
  list: ReturnType<typeof vi.fn>;
}

function createMockHostStore(hosts: Host[]): MockHostStore {
  return {
    list: vi.fn(() => hosts),
  };
}

interface MockConnectionManager {
  connect: ReturnType<typeof vi.fn>;
}

function createMockConnectionManager(): MockConnectionManager {
  return {
    connect: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AutoConnectService', () => {
  let mockSettings: MockSettingsStore;
  let mockHostStore: MockHostStore;
  let mockConnMgr: MockConnectionManager;
  let service: AutoConnectService;

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('no hosts', () => {
    it('emits "no-hosts" when host list is empty', async () => {
      mockSettings = createMockSettingsStore({
        autoConnect: true,
        lastHostId: null,
        theme: 'dark',
      });
      mockHostStore = createMockHostStore([]);
      mockConnMgr = createMockConnectionManager();

      service = new AutoConnectService(
        mockHostStore as any,
        mockConnMgr as any,
        mockSettings as any,
      );

      const events: AutoConnectEvent[] = [];
      service.onEvent((e) => events.push(e));

      await service.init();

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('no-hosts');
      expect(mockConnMgr.connect).not.toHaveBeenCalled();
    });

    it('emits "no-hosts" when hosts exist but none have lastConnectedAt', async () => {
      const hosts = [
        makeHost({ id: 1, lastConnectedAt: null }),
        makeHost({ id: 2, lastConnectedAt: null }),
      ];

      mockSettings = createMockSettingsStore({
        autoConnect: true,
        lastHostId: null,
        theme: 'dark',
      });
      mockHostStore = createMockHostStore(hosts);
      mockConnMgr = createMockConnectionManager();

      service = new AutoConnectService(
        mockHostStore as any,
        mockConnMgr as any,
        mockSettings as any,
      );

      const events: AutoConnectEvent[] = [];
      service.onEvent((e) => events.push(e));

      await service.init();

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('no-hosts');
    });
  });

  describe('auto-connect disabled', () => {
    it('emits "skipped" when autoConnect is false', async () => {
      mockSettings = createMockSettingsStore({
        autoConnect: false,
        lastHostId: 1,
        theme: 'dark',
      });
      mockHostStore = createMockHostStore([makeHost({ id: 1, lastConnectedAt: Date.now() })]);
      mockConnMgr = createMockConnectionManager();

      service = new AutoConnectService(
        mockHostStore as any,
        mockConnMgr as any,
        mockSettings as any,
      );

      const events: AutoConnectEvent[] = [];
      service.onEvent((e) => events.push(e));

      await service.init();

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('skipped');
      expect(mockConnMgr.connect).not.toHaveBeenCalled();
    });
  });

  describe('background startup', () => {
    it('defers events so callers can subscribe after scheduling', async () => {
      vi.useFakeTimers();
      mockSettings = createMockSettingsStore({
        autoConnect: false,
        lastHostId: null,
        theme: 'dark',
      });
      mockHostStore = createMockHostStore([]);
      mockConnMgr = createMockConnectionManager();

      service = new AutoConnectService(
        mockHostStore as any,
        mockConnMgr as any,
        mockSettings as any,
      );

      service.startInBackground();

      const events: AutoConnectEvent[] = [];
      service.onEvent((e) => events.push(e));
      expect(events).toHaveLength(0);

      await vi.runAllTimersAsync();
      await service.waitForIdle();

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('skipped');
      vi.useRealTimers();
    });
  });

  describe('auto-connect enabled with last host', () => {
    it('attempts connection to the most recently connected host', async () => {
      const mostRecent = makeHost({
        id: 2,
        name: 'Recent Host',
        lastConnectedAt: Date.now() - 1000,
      });
      const older = makeHost({
        id: 1,
        name: 'Older Host',
        lastConnectedAt: Date.now() - 60000,
      });

      mockSettings = createMockSettingsStore({
        autoConnect: true,
        lastHostId: null,
        theme: 'dark',
      });
      mockHostStore = createMockHostStore([older, mostRecent]);
      mockConnMgr = createMockConnectionManager();
      mockConnMgr.connect.mockResolvedValue({});

      service = new AutoConnectService(
        mockHostStore as any,
        mockConnMgr as any,
        mockSettings as any,
      );

      const events: AutoConnectEvent[] = [];
      service.onEvent((e) => events.push(e));

      await service.init();

      // Should have attempted to connect to the most recent host
      expect(mockConnMgr.connect).toHaveBeenCalledTimes(1);
      expect(mockConnMgr.connect).toHaveBeenCalledWith(2, expect.anything());
    });

    it('emits "connected" on successful connection', async () => {
      const host = makeHost({ id: 1, lastConnectedAt: Date.now() });

      mockSettings = createMockSettingsStore({
        autoConnect: true,
        lastHostId: null,
        theme: 'dark',
      });
      mockHostStore = createMockHostStore([host]);
      mockConnMgr = createMockConnectionManager();
      mockConnMgr.connect.mockResolvedValue({ connected: true });

      service = new AutoConnectService(
        mockHostStore as any,
        mockConnMgr as any,
        mockSettings as any,
      );

      const events: AutoConnectEvent[] = [];
      service.onEvent((e) => events.push(e));

      await service.init();

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('connected');
      if (events[0].type === 'connected') {
        expect(events[0].host.id).toBe(1);
      }
    });
  });

  describe('connection failure', () => {
    it('emits "connect-failed" with host and error when connection fails', async () => {
      const host = makeHost({ id: 1, lastConnectedAt: Date.now() });
      const error = new Error('Connection refused');

      mockSettings = createMockSettingsStore({
        autoConnect: true,
        lastHostId: null,
        theme: 'dark',
      });
      mockHostStore = createMockHostStore([host]);
      mockConnMgr = createMockConnectionManager();
      mockConnMgr.connect.mockRejectedValue(error);

      service = new AutoConnectService(
        mockHostStore as any,
        mockConnMgr as any,
        mockSettings as any,
      );

      const events: AutoConnectEvent[] = [];
      service.onEvent((e) => events.push(e));

      await service.init();

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('connect-failed');
      if (events[0].type === 'connect-failed') {
        expect(events[0].host.id).toBe(1);
        expect(events[0].error.message).toBe('Connection refused');
      }
    });
  });

  describe('onConnected / onConnectFailed convenience methods', () => {
    it('onConnected fires only for successful connections', async () => {
      const host = makeHost({ id: 1, lastConnectedAt: Date.now() });

      mockSettings = createMockSettingsStore({
        autoConnect: true,
        lastHostId: null,
        theme: 'dark',
      });
      mockHostStore = createMockHostStore([host]);
      mockConnMgr = createMockConnectionManager();
      mockConnMgr.connect.mockResolvedValue({ connected: true });

      service = new AutoConnectService(
        mockHostStore as any,
        mockConnMgr as any,
        mockSettings as any,
      );

      const connectedHosts: Host[] = [];
      service.onConnected((h) => connectedHosts.push(h));

      await service.init();

      expect(connectedHosts).toHaveLength(1);
      expect(connectedHosts[0].id).toBe(1);
    });

    it('onConnectFailed fires only for failures', async () => {
      const host = makeHost({ id: 1, lastConnectedAt: Date.now() });

      mockSettings = createMockSettingsStore({
        autoConnect: true,
        lastHostId: null,
        theme: 'dark',
      });
      mockHostStore = createMockHostStore([host]);
      mockConnMgr = createMockConnectionManager();
      mockConnMgr.connect.mockRejectedValue(new Error('timeout'));

      service = new AutoConnectService(
        mockHostStore as any,
        mockConnMgr as any,
        mockSettings as any,
      );

      const failures: Array<{ host: Host; error: Error }> = [];
      service.onConnectFailed((host, error) => failures.push({ host, error }));

      await service.init();

      expect(failures).toHaveLength(1);
      expect(failures[0].host.id).toBe(1);
      expect(failures[0].error.message).toBe('timeout');
    });

    it('unsubscribe stops callbacks', async () => {
      const host = makeHost({ id: 1, lastConnectedAt: Date.now() });

      mockSettings = createMockSettingsStore({
        autoConnect: true,
        lastHostId: null,
        theme: 'dark',
      });
      mockHostStore = createMockHostStore([host]);
      mockConnMgr = createMockConnectionManager();
      mockConnMgr.connect.mockResolvedValue({ connected: true });

      service = new AutoConnectService(
        mockHostStore as any,
        mockConnMgr as any,
        mockSettings as any,
      );

      const events: AutoConnectEvent[] = [];
      const unsub = service.onEvent((e) => events.push(e));
      unsub();

      await service.init();

      expect(events).toHaveLength(0);
    });
  });

  describe('enable / disable / isEnabled', () => {
    it('enable persists autoConnect=true', () => {
      const settings = { autoConnect: false, lastHostId: null, theme: 'dark' as const };
      mockSettings = createMockSettingsStore(settings);
      mockHostStore = createMockHostStore([]);
      mockConnMgr = createMockConnectionManager();

      service = new AutoConnectService(
        mockHostStore as any,
        mockConnMgr as any,
        mockSettings as any,
      );

      service.enable();
      expect(mockSettings.update).toHaveBeenCalledWith({ autoConnect: true });
    });

    it('disable persists autoConnect=false', () => {
      const settings = { autoConnect: true, lastHostId: null, theme: 'dark' as const };
      mockSettings = createMockSettingsStore(settings);
      mockHostStore = createMockHostStore([]);
      mockConnMgr = createMockConnectionManager();

      service = new AutoConnectService(
        mockHostStore as any,
        mockConnMgr as any,
        mockSettings as any,
      );

      service.disable();
      expect(mockSettings.update).toHaveBeenCalledWith({ autoConnect: false });
    });

    it('isEnabled reads from settings', () => {
      const settings = { autoConnect: true, lastHostId: null, theme: 'dark' as const };
      mockSettings = createMockSettingsStore(settings);
      mockHostStore = createMockHostStore([]);
      mockConnMgr = createMockConnectionManager();

      service = new AutoConnectService(
        mockHostStore as any,
        mockConnMgr as any,
        mockSettings as any,
      );

      expect(service.isEnabled()).toBe(true);
    });
  });

  describe('host selection', () => {
    it('uses lastHostId before falling back to most recent lastConnectedAt', async () => {
      const hosts = [
        makeHost({ id: 1, lastConnectedAt: 5000 }),
        makeHost({ id: 2, lastConnectedAt: 1000 }),
      ];

      mockSettings = createMockSettingsStore({
        autoConnect: true,
        lastHostId: 2,
        theme: 'dark',
      });
      mockHostStore = createMockHostStore(hosts);
      mockConnMgr = createMockConnectionManager();
      mockConnMgr.connect.mockResolvedValue({});

      service = new AutoConnectService(
        mockHostStore as any,
        mockConnMgr as any,
        mockSettings as any,
      );

      await service.init();

      expect(mockConnMgr.connect).toHaveBeenCalledWith(2, expect.anything());
    });

    it('picks the host with the highest lastConnectedAt', async () => {
      const hosts = [
        makeHost({ id: 1, lastConnectedAt: 1000 }),
        makeHost({ id: 2, lastConnectedAt: 5000 }),
        makeHost({ id: 3, lastConnectedAt: 3000 }),
      ];

      mockSettings = createMockSettingsStore({
        autoConnect: true,
        lastHostId: null,
        theme: 'dark',
      });
      mockHostStore = createMockHostStore(hosts);
      mockConnMgr = createMockConnectionManager();
      mockConnMgr.connect.mockResolvedValue({});

      service = new AutoConnectService(
        mockHostStore as any,
        mockConnMgr as any,
        mockSettings as any,
      );

      await service.init();

      expect(mockConnMgr.connect).toHaveBeenCalledWith(2, expect.anything());
    });
  });
});
