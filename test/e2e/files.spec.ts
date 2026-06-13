import { test, expect } from '@playwright/test';
import {
  startFixture,
  stopFixture,
  isFixtureRunning,
  DEFAULT_FIXTURE,
} from './helpers/docker-fixture';
import { sshExec, waitForSSH } from './helpers/ssh-helpers';

const { host, port, user, keyPath } = DEFAULT_FIXTURE;

test.describe('File browser E2E tests', () => {
  let weStartedFixture = false;

  test.beforeAll(async () => {
    const running = await isFixtureRunning();
    if (!running) {
      await startFixture();
      weStartedFixture = true;
    }
    await waitForSSH(host, port, user, keyPath, 60_000);
  });

  test.afterAll(async () => {
    if (weStartedFixture) {
      await stopFixture();
    }
  });

  test('List home directory via SSH exec', async () => {
    const result = await sshExec(host, port, user, keyPath, 'ls -la ~');
    expect(result.exitCode).toBe(0);
    // Home directory should at least contain . and .. entries and common dotfiles
    expect(result.stdout).toContain('total ');
    // Current dir (.) and parent dir (..) entries — match a line whose final
    // filename column is exactly "." or ".." (avoids matching ".claude", etc.)
    expect(result.stdout).toMatch(/\s\.\s*$/m);   // current dir entry
    expect(result.stdout).toMatch(/\s\.\.\s*$/m); // parent dir entry
    // The entrypoint seeds git/ and .claude/ dirs
    expect(result.stdout).toContain('git');
    expect(result.stdout).toContain('.claude');
  });

  test('Read file content via SSH exec', async () => {
    // The entrypoint seeds a log file with known content
    const result = await sshExec(
      host, port, user, keyPath,
      'cat ~/.local/state/pocketshell/logs/agent-20260101.jsonl',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"kind":"agent"');
    expect(result.stdout).toContain('fixture log entry');
  });

  test('Write file via SSH exec', async () => {
    const filePath = '/tmp/e2e-write-test.txt';
    const content = 'hello from e2e';

    // Write
    const writeResult = await sshExec(
      host, port, user, keyPath,
      `echo '${content}' > ${filePath}`,
    );
    expect(writeResult.exitCode).toBe(0);

    // Verify
    const readResult = await sshExec(
      host, port, user, keyPath,
      `cat ${filePath}`,
    );
    expect(readResult.exitCode).toBe(0);
    expect(readResult.stdout.trim()).toBe(content);

    // Clean up
    await sshExec(host, port, user, keyPath, `rm -f ${filePath}`);
  });

  test('Create and delete files', async () => {
    const filePath = '/tmp/e2e-create-delete.txt';

    // Create
    const createResult = await sshExec(
      host, port, user, keyPath,
      `touch ${filePath}`,
    );
    expect(createResult.exitCode).toBe(0);

    // Verify it exists
    const existsResult = await sshExec(
      host, port, user, keyPath,
      `test -f ${filePath} && echo EXISTS || echo MISSING`,
    );
    expect(existsResult.stdout.trim()).toBe('EXISTS');

    // Delete
    const deleteResult = await sshExec(
      host, port, user, keyPath,
      `rm ${filePath}`,
    );
    expect(deleteResult.exitCode).toBe(0);

    // Verify it is gone
    const goneResult = await sshExec(
      host, port, user, keyPath,
      `test -f ${filePath} && echo EXISTS || echo MISSING`,
    );
    expect(goneResult.stdout.trim()).toBe('MISSING');
  });

  test('Create and delete directories', async () => {
    const dirPath = '/tmp/e2e-dir-test';

    // Create directory
    const mkdirResult = await sshExec(
      host, port, user, keyPath,
      `mkdir -p ${dirPath}/subdir`,
    );
    expect(mkdirResult.exitCode).toBe(0);

    // Verify it exists
    const existsResult = await sshExec(
      host, port, user, keyPath,
      `test -d ${dirPath} && echo EXISTS || echo MISSING`,
    );
    expect(existsResult.stdout.trim()).toBe('EXISTS');

    // Verify subdirectory exists
    const subdirResult = await sshExec(
      host, port, user, keyPath,
      `test -d ${dirPath}/subdir && echo EXISTS || echo MISSING`,
    );
    expect(subdirResult.stdout.trim()).toBe('EXISTS');

    // Delete recursively
    const deleteResult = await sshExec(
      host, port, user, keyPath,
      `rm -rf ${dirPath}`,
    );
    expect(deleteResult.exitCode).toBe(0);

    // Verify it is gone
    const goneResult = await sshExec(
      host, port, user, keyPath,
      `test -d ${dirPath} && echo EXISTS || echo MISSING`,
    );
    expect(goneResult.stdout.trim()).toBe('MISSING');
  });

  test('Check file permissions', async () => {
    const filePath = '/tmp/e2e-perm-test.sh';

    // Create and set permissions
    await sshExec(host, port, user, keyPath, `echo '#!/bin/sh' > ${filePath}`);
    await sshExec(host, port, user, keyPath, `chmod 755 ${filePath}`);

    // Check permissions
    const permResult = await sshExec(
      host, port, user, keyPath,
      `stat -c '%a' ${filePath}`,
    );
    expect(permResult.exitCode).toBe(0);
    expect(permResult.stdout.trim()).toBe('755');

    // Change to read-only
    await sshExec(host, port, user, keyPath, `chmod 444 ${filePath}`);
    const readOnlyResult = await sshExec(
      host, port, user, keyPath,
      `stat -c '%a' ${filePath}`,
    );
    expect(readOnlyResult.stdout.trim()).toBe('444');

    // Clean up
    await sshExec(host, port, user, keyPath, `rm -f ${filePath}`);
  });

  test('Navigate directory tree', async () => {
    // Create a nested structure
    const baseDir = '/tmp/e2e-tree';
    await sshExec(
      host, port, user, keyPath,
      `mkdir -p ${baseDir}/a/b/c`,
    );
    await sshExec(
      host, port, user, keyPath,
      `echo leaf > ${baseDir}/a/b/c/file.txt`,
    );

    // Walk the tree using find
    const findResult = await sshExec(
      host, port, user, keyPath,
      `find ${baseDir} -type f`,
    );
    expect(findResult.exitCode).toBe(0);
    expect(findResult.stdout.trim()).toBe(`${baseDir}/a/b/c/file.txt`);

    // Read the nested file
    const catResult = await sshExec(
      host, port, user, keyPath,
      `cat ${baseDir}/a/b/c/file.txt`,
    );
    expect(catResult.stdout.trim()).toBe('leaf');

    // Clean up
    await sshExec(host, port, user, keyPath, `rm -rf ${baseDir}`);
  });

  test('List seeded fixture directories', async () => {
    // Verify the entrypoint-seeded project directories exist
    const gitDirResult = await sshExec(
      host, port, user, keyPath,
      'ls ~/git/',
    );
    expect(gitDirResult.exitCode).toBe(0);
    expect(gitDirResult.stdout).toContain('pocketshell');
    expect(gitDirResult.stdout).toContain('test-project');
  });

  test('Read Claude session log file', async () => {
    const result = await sshExec(
      host, port, user, keyPath,
      'cat ~/.claude/projects/-workspace-pocketshell/pocketshell-claude.jsonl',
    );
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    // Each line should be valid JSON. Claude CLI session logs use Format A
    // (see src/agents/conversation/parsers/claude-parser.ts): each entry is
    //   { "type": "...", "message": { "role": "user"|"assistant", ... }, "ts": "..." }
    // so the role lives under message.role.
    for (const line of lines) {
      const parsed = JSON.parse(line);
      const role = parsed.message?.role ?? parsed.role;
      expect(role).toBeDefined();
    }
  });
});
