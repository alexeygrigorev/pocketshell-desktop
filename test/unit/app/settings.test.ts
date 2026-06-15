/**
 * Unit tests for SettingsStore.
 *
 * Uses a temp directory to avoid touching the real ~/.pocketshell.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SettingsStore, AppSettings } from '../../../src/app/settings';

describe('SettingsStore', () => {
  let tmpDir: string;
  let filePath: string;
  let store: SettingsStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-settings-test-'));
    filePath = path.join(tmpDir, 'settings.json');
    store = new SettingsStore(filePath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('defaults', () => {
    it('returns default settings when no file exists', () => {
      const settings = store.load();

      expect(settings.autoConnect).toBe(true);
      expect(settings.lastHostId).toBeNull();
      expect(settings.restoreSessionOnStartup).toBe(true);
      expect(settings.sessionRestoreBehavior).toBe('ask');
      expect(settings.theme).toBe('dark');
      expect(settings.diagnosticsEnabled).toBe(true);
      expect(settings.diagnosticsMaxEvents).toBe(500);
      expect(settings.diagnosticsRedactionMode).toBe('balanced');
    });
  });

  describe('load/save cycle', () => {
    it('persists settings to disk and loads them back', () => {
      const custom: AppSettings = {
        autoConnect: false,
        lastHostId: 42,
        restoreSessionOnStartup: false,
        sessionRestoreBehavior: 'skip',
        theme: 'light',
        diagnosticsEnabled: true,
        diagnosticsMaxEvents: 500,
        diagnosticsRedactionMode: 'balanced',
      };

      store.save(custom);

      // Create a new store instance to verify persistence
      const store2 = new SettingsStore(filePath);
      const loaded = store2.load();

      expect(loaded.autoConnect).toBe(false);
      expect(loaded.lastHostId).toBe(42);
      expect(loaded.theme).toBe('light');
    });

    it('overwrites existing settings', () => {
      store.save({
        autoConnect: true,
        lastHostId: 1,
        restoreSessionOnStartup: true,
        sessionRestoreBehavior: 'ask',
        theme: 'dark',
        diagnosticsEnabled: true,
        diagnosticsMaxEvents: 500,
        diagnosticsRedactionMode: 'balanced',
      });
      store.save({
        autoConnect: false,
        lastHostId: 2,
        restoreSessionOnStartup: true,
        sessionRestoreBehavior: 'restore-ready',
        theme: 'system',
        diagnosticsEnabled: true,
        diagnosticsMaxEvents: 500,
        diagnosticsRedactionMode: 'balanced',
      });

      const loaded = store.load();
      expect(loaded.autoConnect).toBe(false);
      expect(loaded.lastHostId).toBe(2);
      expect(loaded.theme).toBe('system');
    });
  });

  describe('update (partial merge)', () => {
    it('merges partial update into current settings', () => {
      store.load(); // populate cache with defaults

      store.update({ autoConnect: false });

      const settings = store.get();
      expect(settings.autoConnect).toBe(false);
      // Other fields should keep their defaults
      expect(settings.lastHostId).toBeNull();
      expect(settings.restoreSessionOnStartup).toBe(true);
      expect(settings.sessionRestoreBehavior).toBe('ask');
      expect(settings.theme).toBe('dark');
    });

    it('merges multiple partial updates', () => {
      store.load();

      store.update({ lastHostId: 10 });
      store.update({ theme: 'light' });

      const settings = store.get();
      expect(settings.autoConnect).toBe(true); // still default
      expect(settings.lastHostId).toBe(10);
      expect(settings.theme).toBe('light');
    });

    it('persists partial updates to disk', () => {
      store.load();
      store.update({ autoConnect: false });

      // New instance reads from disk
      const store2 = new SettingsStore(filePath);
      expect(store2.load().autoConnect).toBe(false);
    });
  });

  describe('error handling', () => {
    it('returns defaults for malformed JSON', () => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, '{invalid json', 'utf-8');

      const settings = store.load();
      expect(settings).toEqual({
        autoConnect: true,
        lastHostId: null,
        restoreSessionOnStartup: true,
        sessionRestoreBehavior: 'ask',
        theme: 'dark',
        diagnosticsEnabled: true,
        diagnosticsMaxEvents: 500,
        diagnosticsRedactionMode: 'balanced',
      });
    });

    it('creates parent directory on save', () => {
      const deepPath = path.join(tmpDir, 'a', 'b', 'c', 'settings.json');
      const deepStore = new SettingsStore(deepPath);

      deepStore.save({
        autoConnect: true,
        lastHostId: null,
        restoreSessionOnStartup: true,
        sessionRestoreBehavior: 'ask',
        theme: 'dark',
        diagnosticsEnabled: true,
        diagnosticsMaxEvents: 500,
        diagnosticsRedactionMode: 'balanced',
      });

      expect(fs.existsSync(deepPath)).toBe(true);
    });
  });
});
