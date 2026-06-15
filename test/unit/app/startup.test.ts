/**
 * Unit tests for app startup orchestration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../src/ssh/data/host-store', () => ({
  initStore: vi.fn(async () => ({
    list: vi.fn(() => []),
  })),
}));

vi.mock('../../../src/ssh/connection/connection-manager', () => ({
  ConnectionManager: vi.fn(function ConnectionManager() {
    return {
      connect: vi.fn(),
    };
  }),
}));

import { initializeApp } from '../../../src/app/startup';

describe('initializeApp', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-startup-test-'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns context before background auto-connect emits events', async () => {
    const context = await initializeApp({
      settingsPath: path.join(tmpDir, 'settings.json'),
    });
    const events: string[] = [];

    context.autoConnect.onEvent((event) => events.push(event.type));

    expect(events).toEqual([]);

    await vi.runAllTimersAsync();
    await context.autoConnect.waitForIdle();

    expect(events).toEqual(['no-hosts']);
  });
});
