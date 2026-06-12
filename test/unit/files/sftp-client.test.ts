/**
 * Unit tests for SftpClient.
 *
 * Uses a mocked SshConnection that provides a fake SFTP channel
 * with stubbed implementations of the ssh2 SFTPWrapper methods.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SftpClient } from '../../../src/files/sftp-client';
import type { SshConnection } from '../../../src/ssh/connection/ssh-client';
import type { SFTPWrapper, FileEntryWithStats, Stats } from 'ssh2';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function createMockStats(overrides: Partial<Attributes & { isDir?: boolean; isFile?: boolean; isSym?: boolean }> = {}): Stats {
  const {
    mode = 0o100644,
    uid = 1000,
    gid = 1000,
    size = 0,
    atime = 1700000000,
    mtime = 1700000000,
    isDir = false,
    isFile = true,
    isSym = false,
  } = overrides;

  return {
    mode,
    uid,
    gid,
    size,
    atime,
    mtime,
    isDirectory: () => isDir,
    isFile: () => isFile,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => isSym,
    isFIFO: () => false,
    isSocket: () => false,
  } as Stats;
}

interface Attributes {
  mode: number;
  uid: number;
  gid: number;
  size: number;
  atime: number;
  mtime: number;
}

function createMockSftp(): {
  sftp: SFTPWrapper;
  readdirMock: ReturnType<typeof vi.fn>;
  statMock: ReturnType<typeof vi.fn>;
  lstatMock: ReturnType<typeof vi.fn>;
  readFileMock: ReturnType<typeof vi.fn>;
  writeFileMock: ReturnType<typeof vi.fn>;
  mkdirMock: ReturnType<typeof vi.fn>;
  unlinkMock: ReturnType<typeof vi.fn>;
  rmdirMock: ReturnType<typeof vi.fn>;
  renameMock: ReturnType<typeof vi.fn>;
  existsMock: ReturnType<typeof vi.fn>;
  realpathMock: ReturnType<typeof vi.fn>;
  createReadStreamMock: ReturnType<typeof vi.fn>;
  createWriteStreamMock: ReturnType<typeof vi.fn>;
  endMock: ReturnType<typeof vi.fn>;
} {
  const readdirMock = vi.fn();
  const statMock = vi.fn();
  const lstatMock = vi.fn();
  const readFileMock = vi.fn();
  const writeFileMock = vi.fn();
  const mkdirMock = vi.fn();
  const unlinkMock = vi.fn();
  const rmdirMock = vi.fn();
  const renameMock = vi.fn();
  const existsMock = vi.fn();
  const realpathMock = vi.fn();
  const createReadStreamMock = vi.fn();
  const createWriteStreamMock = vi.fn();
  const endMock = vi.fn();

  const sftp = {
    readdir: readdirMock,
    stat: statMock,
    lstat: lstatMock,
    readFile: readFileMock,
    writeFile: writeFileMock,
    mkdir: mkdirMock,
    unlink: unlinkMock,
    rmdir: rmdirMock,
    rename: renameMock,
    exists: existsMock,
    realpath: realpathMock,
    createReadStream: createReadStreamMock,
    createWriteStream: createWriteStreamMock,
    end: endMock,
  } as unknown as SFTPWrapper;

  return {
    sftp,
    readdirMock,
    statMock,
    lstatMock,
    readFileMock,
    writeFileMock,
    mkdirMock,
    unlinkMock,
    rmdirMock,
    renameMock,
    existsMock,
    realpathMock,
    createReadStreamMock,
    createWriteStreamMock,
    endMock,
  };
}

function createMockConnection(sftp: SFTPWrapper): SshConnection {
  return {
    connected: true,
    exec: vi.fn(),
    shell: vi.fn(),
    sftp: vi.fn().mockResolvedValue(sftp),
    disconnect: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SftpClient', () => {
  let mockSftpBundle: ReturnType<typeof createMockSftp>;
  let mockConnection: SshConnection;
  let client: SftpClient;

  beforeEach(() => {
    mockSftpBundle = createMockSftp();
    mockConnection = createMockConnection(mockSftpBundle.sftp);
    client = new SftpClient(mockConnection);
  });

  describe('connect / disconnect', () => {
    it('connect opens SFTP subsystem', async () => {
      await client.connect();
      expect(client.connected).toBe(true);
      expect(mockConnection.sftp).toHaveBeenCalledOnce();
    });

    it('disconnect closes SFTP channel', async () => {
      await client.connect();
      client.disconnect();
      expect(client.connected).toBe(false);
      expect(mockSftpBundle.endMock).toHaveBeenCalled();
    });

    it('disconnect is idempotent', async () => {
      await client.connect();
      client.disconnect();
      client.disconnect();
      client.disconnect();
      expect(mockSftpBundle.endMock).toHaveBeenCalledOnce();
    });

    it('throws if connect called when already connected', async () => {
      await client.connect();
      await expect(client.connect()).rejects.toThrow('SFTP session already open');
    });

    it('throws if operations called before connect', async () => {
      await expect(client.readdir('/home')).rejects.toThrow('SFTP session not open');
    });
  });

  describe('readdir', () => {
    it('returns entries', async () => {
      const fileStats = createMockStats({ isFile: true, size: 100, mtime: 1700000000 });
      const dirStats = createMockStats({ mode: 0o040755, isDir: true, isFile: false, size: 4096, mtime: 1700001000 });

      const entries: FileEntryWithStats[] = [
        { filename: 'file.txt', longname: '', attrs: fileStats },
        { filename: 'docs', longname: '', attrs: dirStats },
      ];

      mockSftpBundle.readdirMock.mockImplementation((_path: string, cb: Function) => {
        cb(undefined, entries);
      });

      await client.connect();
      const result = await client.readdir('/home/test');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        name: 'file.txt',
        path: '/home/test/file.txt',
        isDirectory: false,
        isFile: true,
        isSymbolicLink: false,
        size: 100,
        modifiedAt: 1700000000 * 1000,
        permissions: 'rw-r--r--',
      });
      expect(result[1]).toEqual({
        name: 'docs',
        path: '/home/test/docs',
        isDirectory: true,
        isFile: false,
        isSymbolicLink: false,
        size: 4096,
        modifiedAt: 1700001000 * 1000,
        permissions: 'rwxr-xr-x',
      });
    });
  });

  describe('readFile', () => {
    it('returns content as Buffer', async () => {
      const content = Buffer.from('hello world');
      mockSftpBundle.readFileMock.mockImplementation((_path: string, cb: Function) => {
        cb(undefined, content);
      });

      await client.connect();
      const result = await client.readFile('/home/test/file.txt');

      expect(result).toBeInstanceOf(Buffer);
      expect(result.toString()).toBe('hello world');
    });
  });

  describe('readFileText', () => {
    it('returns content as UTF-8 string', async () => {
      mockSftpBundle.readFileMock.mockImplementation((_path: string, cb: Function) => {
        cb(undefined, Buffer.from('hello text'));
      });

      await client.connect();
      const result = await client.readFileText('/home/test/file.txt');

      expect(result).toBe('hello text');
    });
  });

  describe('writeFile', () => {
    it('writes content', async () => {
      mockSftpBundle.writeFileMock.mockImplementation((_path: string, _data: any, cb: Function) => {
        cb(undefined);
      });

      await client.connect();
      await client.writeFile('/home/test/file.txt', 'content');

      expect(mockSftpBundle.writeFileMock).toHaveBeenCalledWith(
        '/home/test/file.txt',
        'content',
        expect.any(Function),
      );
    });
  });

  describe('stat', () => {
    it('returns metadata', async () => {
      const stats = createMockStats({ size: 2048, mode: 0o100644, mtime: 1700005000 });
      mockSftpBundle.statMock.mockImplementation((_path: string, cb: Function) => {
        cb(undefined, stats);
      });

      await client.connect();
      const result = await client.stat('/home/test/file.txt');

      expect(result.size).toBe(2048);
      expect(result.mode).toBe(0o100644);
      expect(result.modifiedAt).toBe(1700005000 * 1000);
      expect(result.isFile()).toBe(true);
      expect(result.isDirectory()).toBe(false);
    });
  });

  describe('lstat', () => {
    it('returns metadata without following symlinks', async () => {
      const stats = createMockStats({ isSym: true, isFile: false });
      mockSftpBundle.lstatMock.mockImplementation((_path: string, cb: Function) => {
        cb(undefined, stats);
      });

      await client.connect();
      const result = await client.lstat('/home/test/link');

      expect(result.isSymbolicLink()).toBe(true);
    });
  });

  describe('mkdir', () => {
    it('creates directory', async () => {
      mockSftpBundle.mkdirMock.mockImplementation((_path: string, cb: Function) => {
        cb(undefined);
      });

      await client.connect();
      await client.mkdir('/home/test/newdir');

      expect(mockSftpBundle.mkdirMock).toHaveBeenCalledWith('/home/test/newdir', expect.any(Function));
    });
  });

  describe('rename', () => {
    it('moves file', async () => {
      mockSftpBundle.renameMock.mockImplementation((_src: string, _dst: string, cb: Function) => {
        cb(undefined);
      });

      await client.connect();
      await client.rename('/home/test/old.txt', '/home/test/new.txt');

      expect(mockSftpBundle.renameMock).toHaveBeenCalledWith(
        '/home/test/old.txt',
        '/home/test/new.txt',
        expect.any(Function),
      );
    });
  });

  describe('exists', () => {
    it('returns true when path exists', async () => {
      mockSftpBundle.existsMock.mockImplementation((_path: string, cb: Function) => {
        cb(true);
      });

      await client.connect();
      const result = await client.exists('/home/test/file.txt');

      expect(result).toBe(true);
    });

    it('returns false when path does not exist', async () => {
      mockSftpBundle.existsMock.mockImplementation((_path: string, cb: Function) => {
        cb(false);
      });

      await client.connect();
      const result = await client.exists('/home/test/nonexistent');

      expect(result).toBe(false);
    });
  });

  describe('unlink', () => {
    it('deletes file', async () => {
      mockSftpBundle.unlinkMock.mockImplementation((_path: string, cb: Function) => {
        cb(undefined);
      });

      await client.connect();
      await client.unlink('/home/test/file.txt');

      expect(mockSftpBundle.unlinkMock).toHaveBeenCalledWith('/home/test/file.txt', expect.any(Function));
    });
  });

  describe('rmdir', () => {
    it('removes empty directory', async () => {
      mockSftpBundle.rmdirMock.mockImplementation((_path: string, cb: Function) => {
        cb(undefined);
      });

      await client.connect();
      await client.rmdir('/home/test/emptydir');

      expect(mockSftpBundle.rmdirMock).toHaveBeenCalledWith('/home/test/emptydir', expect.any(Function));
    });
  });

  describe('realpath', () => {
    it('resolves path', async () => {
      mockSftpBundle.realpathMock.mockImplementation((_path: string, cb: Function) => {
        cb(undefined, '/home/test');
      });

      await client.connect();
      const result = await client.realpath('~');

      expect(result).toBe('/home/test');
    });
  });

  describe('createReadStream', () => {
    it('returns a readable stream', async () => {
      const mockStream = { on: vi.fn(), pipe: vi.fn() };
      mockSftpBundle.createReadStreamMock.mockReturnValue(mockStream);

      await client.connect();
      const stream = await client.createReadStream('/home/test/large.bin');

      expect(mockSftpBundle.createReadStreamMock).toHaveBeenCalledWith('/home/test/large.bin', {});
      expect(stream).toBe(mockStream);
    });

    it('passes start/end options', async () => {
      const mockStream = { on: vi.fn(), pipe: vi.fn() };
      mockSftpBundle.createReadStreamMock.mockReturnValue(mockStream);

      await client.connect();
      await client.createReadStream('/home/test/large.bin', { start: 100, end: 200 });

      expect(mockSftpBundle.createReadStreamMock).toHaveBeenCalledWith(
        '/home/test/large.bin',
        { start: 100, end: 200 },
      );
    });
  });

  describe('createWriteStream', () => {
    it('returns a writable stream', async () => {
      const mockStream = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
      mockSftpBundle.createWriteStreamMock.mockReturnValue(mockStream);

      await client.connect();
      const stream = await client.createWriteStream('/home/test/output.bin');

      expect(mockSftpBundle.createWriteStreamMock).toHaveBeenCalledWith('/home/test/output.bin');
      expect(stream).toBe(mockStream);
    });
  });

  describe('error handling', () => {
    it('propagates SFTP errors', async () => {
      mockSftpBundle.readdirMock.mockImplementation((_path: string, cb: Function) => {
        cb(new Error('Permission denied'), undefined as any);
      });

      await client.connect();
      await expect(client.readdir('/root')).rejects.toThrow('Permission denied');
    });
  });
});
