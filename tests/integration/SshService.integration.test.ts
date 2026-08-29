import { beforeAll, afterAll, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { SshService } from '@main/ssh/SshService';
import { DOCKER_DIR, TEST_KEY_PATH, describeDocker } from './helpers';

/**
 * Integration tests for SshService against the real `pocketshell-test:ssh`
 * Docker image on an ephemeral host port. Mirrors the Android project's
 * sshj Testcontainers suite.
 *
 * Auto-skips entirely when Docker is not available (see describeDocker).
 */
describeDocker('SshService integration', () => {
  let container: StartedTestContainer | undefined;
  let host: string;
  let port: number;
  let ssh: SshService;
  let connectionId: string | undefined;

  beforeAll(async () => {
    container = await new GenericContainer('pocketshell-test:ssh')
      .withExposedPorts(22)
      .start();
    host = container.getHost();
    port = container.getMappedPort(22);
    ssh = new SshService();
  }, 120_000);

  afterAll(async () => {
    if (connectionId) ssh.close(connectionId);
    if (container) await container.stop();
  });

  it('connects with the ed25519 test key', async () => {
    const result = await ssh.connect({
      host,
      port,
      user: 'testuser',
      privateKeyPath: TEST_KEY_PATH,
      // Tests intentionally skip known_hosts verification (TOFU accept-once).
      knownHosts: null,
      tofuDecision: 'accept-once',
      timeoutMs: 15_000,
    });
    expect(result.ok).toBe(true);
    expect(result.connectionId).toBeDefined();
    connectionId = result.connectionId;
  });

  it('runs whoami and returns testuser, exit 0', async () => {
    const res = await ssh.exec(connectionId!, 'whoami');
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('testuser');
  });

  it('does NOT throw on non-zero exit — returns exitCode 1', async () => {
    const res = await ssh.exec(connectionId!, 'false');
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toBe('');
  });

  it('captures stdout and stderr separately', async () => {
    const res = await ssh.exec(connectionId!, 'echo out; echo err 1>&2');
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('out');
    expect(res.stderr.trim()).toBe('err');
  });

  it('opens a shell PTY and round-trips bytes', async () => {
    const shell = await ssh.shell(connectionId!, { cols: 80, rows: 24 });
    const output = new Promise<string>((resolveP) => {
      let acc = '';
      const timer = setTimeout(() => resolveP(acc), 1_500);
      shell.stdout.on('data', (chunk: Buffer) => {
        acc += chunk.toString('utf8');
      });
      shell.stdout.on('close', () => {
        clearTimeout(timer);
        resolveP(acc);
      });
    });
    shell.write('echo hello_from_shell\n');
    const text = await output;
    shell.close();
    expect(text).toContain('hello_from_shell');
  });

  it('pipes ExecOptions.stdin to the command and closes the pipe', async () => {
    // `cat` echoes whatever reaches stdin and exits on EOF — the exact
    // contract `pocketshell env set` relies on for secret values (F16).
    const res = await ssh.exec(connectionId!, 'cat', { stdin: 'through the pipe' });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('through the pipe');
  });

  it('reports connect failure with a clear error for a closed port', async () => {
    const bad = new SshService();
    const result = await bad.connect({
      host: '127.0.0.1',
      port: 1, // nothing listening
      user: 'nobody',
      privateKeyPath: TEST_KEY_PATH,
      knownHosts: null,
      timeoutMs: 3_000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// Silence unused import warning for DOCKER_DIR (kept for future suites).
void DOCKER_DIR;
