/**
 * Focused unit tests for {@link SshShellBridge}.
 *
 * Verifies the three {@link SshChannel} members against a fake `SshShell`
 * built from Node `stream.PassThrough`:
 *  - `write()` reaches the fake stdin;
 *  - `getStdoutReader()` yields bytes pushed to the fake stdout, then EOF;
 *  - `close()` invokes the fake shell's `close()`.
 *
 * Imports the adapter from the wired extension source (not the standalone
 * `src/tmux/` original, which has no SSH dependency).
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'stream';
import { SshShellBridge } from '../../../extensions/pocketshell/src/backend/tmux/ssh-shell-bridge';
import type { SshShell } from '../../../extensions/pocketshell/src/backend/ssh/connection/ssh-client';

/** Build a fake SshShell around PassThrough streams + spies. */
function makeFakeShell(): {
  shell: SshShell;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  resizePty: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const resizePty = vi.fn();
  const close = vi.fn();

  const shell: SshShell = {
    stdin,
    stdout,
    stderr,
    resizePty,
    close,
  };

  return { shell, stdin, stdout, stderr, resizePty, close };
}

describe('SshShellBridge', () => {
  it('write() forwards bytes to the shell stdin', async () => {
    const { shell, stdin } = makeFakeShell();
    const bridge = new SshShellBridge(shell);

    const received: Buffer[] = [];
    stdin.on('data', (chunk: Buffer) => received.push(chunk));

    await bridge.write(Buffer.from('tmux -CC\n', 'utf-8'));
    // Drain the PassThrough so the 'data' listener fires.
    stdin.read();

    expect(received.length).toBe(1);
    expect(received[0].toString('utf-8')).toBe('tmux -CC\n');
  });

  it('getStdoutReader() yields data pushed to stdout then EOF', async () => {
    const { shell, stdout } = makeFakeShell();
    const bridge = new SshShellBridge(shell);

    const reader = bridge.getStdoutReader();

    // Push a couple of chunks, then end the stream.
    stdout.write(Buffer.from('hello ', 'utf-8'));
    stdout.write(Buffer.from('world', 'utf-8'));
    stdout.end();

    const first = await reader.read();
    const second = await reader.read();
    const eof = await reader.read();

    expect(first?.toString('utf-8')).toBe('hello ');
    expect(second?.toString('utf-8')).toBe('world');
    expect(eof).toBeNull();
  });

  it('close() calls the underlying shell.close() and is idempotent', async () => {
    const { shell, close } = makeFakeShell();
    const bridge = new SshShellBridge(shell);

    await bridge.close();
    expect(close).toHaveBeenCalledTimes(1);

    // Idempotent — second close must not double-close the shell.
    await bridge.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
