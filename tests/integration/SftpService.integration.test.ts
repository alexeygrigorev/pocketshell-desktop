import { beforeAll, afterAll, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { writeFileSync, unlinkSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionRegistry } from '@main/ssh/ConnectionRegistry';
import { SshService } from '@main/ssh/SshService';
import { SftpService } from '@main/sftp/SftpService';
import { TEST_KEY_PATH, describeDocker } from './helpers';

/**
 * Integration tests for SftpService against the real `pocketshell-test:ssh`
 * image (which ships the sftp subsystem). Covers list/read/write round-trip,
 * mkdir/rename/delete, and a 10MB upload with progress.
 *
 * Auto-skips when Docker is unavailable.
 */
describeDocker('SftpService integration', () => {
  let container: StartedTestContainer | undefined;
  let registry: ConnectionRegistry;
  let ssh: SshService;
  let sftp: SftpService;
  let connectionId: string | undefined;
  let tmpDir: string;

  beforeAll(async () => {
    container = await new GenericContainer('pocketshell-test:ssh')
      .withExposedPorts(22)
      .start();
    registry = new ConnectionRegistry();
    ssh = new SshService(registry);
    sftp = new SftpService(registry);
    const result = await ssh.connect({
      host: container.getHost(),
      port: container.getMappedPort(22),
      user: 'testuser',
      privateKeyPath: TEST_KEY_PATH,
      knownHosts: null,
      tofuDecision: 'accept-once',
      timeoutMs: 15_000,
    });
    if (!result.ok || !result.connectionId) throw new Error('connect failed');
    connectionId = result.connectionId;
    tmpDir = mkdtempSync(join(tmpdir(), 'psh-sftp-'));
  }, 120_000);

  afterAll(async () => {
    if (connectionId) ssh.close(connectionId);
    if (container) await container.stop();
    try {
      if (tmpDir && existsSync(tmpDir)) {
        // best-effort cleanup of the local temp dir
      }
    } catch {
      // ignore
    }
  });

  it('realPath resolves the home directory', async () => {
    const home = await sftp.realPath(connectionId!, '.');
    expect(home).toContain('testuser');
  });

  it('list returns directory entries', async () => {
    const home = await sftp.realPath(connectionId!, '.');
    const entries = await sftp.list(connectionId!, home);
    // .ssh is created by the image; at least one entry exists.
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.name === '.ssh')).toBe(true);
  });

  it('writeFile + readFile round-trips UTF-8 content', async () => {
    const home = await sftp.realPath(connectionId!, '.');
    const path = `${home}/roundtrip.txt`;
    const content = 'hello sftp\nline two\nemoji: ✓ café';
    await sftp.writeFile(connectionId!, path, content);
    const back = await sftp.readFile(connectionId!, path);
    expect(back).toBe(content);
    await sftp.deleteFile(connectionId!, path);
  });

  it('mkdir creates a directory; rmdir removes it', async () => {
    const home = await sftp.realPath(connectionId!, '.');
    const dir = `${home}/sftp-test-dir`;
    await sftp.mkdir(connectionId!, dir);
    expect(await sftp.exists(connectionId!, dir)).toBe(true);
    await sftp.rmdir(connectionId!, dir);
    expect(await sftp.exists(connectionId!, dir)).toBe(false);
  });

  it('rename moves a file', async () => {
    const home = await sftp.realPath(connectionId!, '.');
    const from = `${home}/rename-from.txt`;
    const to = `${home}/rename-to.txt`;
    await sftp.writeFile(connectionId!, from, 'payload');
    await sftp.rename(connectionId!, from, to);
    expect(await sftp.exists(connectionId!, from)).toBe(false);
    expect(await sftp.exists(connectionId!, to)).toBe(true);
    await sftp.deleteFile(connectionId!, to);
  });

  it('uploads a 10MB file with progress callbacks', async () => {
    const home = await sftp.realPath(connectionId!, '.');
    const localPath = join(tmpDir!, 'big.bin');
    const remotePath = `${home}/big-upload.bin`;
    // Write 10MB of pseudo-random-ish bytes locally.
    const buf = Buffer.alloc(10 * 1024 * 1024);
    for (let i = 0; i < buf.length; i++) buf[i] = i & 0xff;
    writeFileSync(localPath, buf);

    const progress: { bytes: number; total?: number }[] = [];
    await sftp.upload(connectionId!, localPath, remotePath, (p) => progress.push(p));

    expect(await sftp.exists(connectionId!, remotePath)).toBe(true);
    const stat = await sftp.stat(connectionId!, remotePath);
    expect(stat.size).toBe(10 * 1024 * 1024);
    // fastPut reports progress steps; the last should match the total.
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]!.bytes).toBeGreaterThanOrEqual(10 * 1024 * 1024 - 1);

    await sftp.deleteFile(connectionId!, remotePath);
    unlinkSync(localPath);
  }, 30_000);

  it('download mirrors an uploaded file', async () => {
    const home = await sftp.realPath(connectionId!, '.');
    const remotePath = `${home}/dl-source.txt`;
    const localPath = join(tmpDir!, 'dl-dest.txt');
    await sftp.writeFile(connectionId!, remotePath, 'download me');
    await sftp.download(connectionId!, remotePath, localPath);
    expect(existsSync(localPath)).toBe(true);
    await sftp.deleteFile(connectionId!, remotePath);
    unlinkSync(localPath);
  });
});
