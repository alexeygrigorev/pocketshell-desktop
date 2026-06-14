/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Bridge between the wired `SshShell` (an interactive SSH PTY stream from
 * {@link SshConnection.shell}) and the `SshChannel` interface expected by
 * {@link TmuxClient.connect}.
 *
 * `SshShell` exposes Node `stream.Writable`/`stream.Readable` ends; the tmux
 * client wants an async `StreamReader.read(): Promise<Buffer | null>` plus
 * a `write`/`close` pair. This adapter wraps them without buffering.
 */

import type { SshChannel } from './client';
import type { StreamReader } from './stream';
import type { SshShell } from '../ssh/connection/ssh-client';

/**
 * Adapts a Node-style `Readable` to the tmux client's `StreamReader`
 * interface. Data emitted by `'data'` is queued (preserving order) and
 * served to `read()`; once the stream ends, `read()` resolves `null` (EOF).
 */
class ShellStreamReader implements StreamReader {
  private chunks: Buffer[] = [];
  private ended = false;
  private waiters: ((chunk: Buffer | null) => void)[] = [];

  constructor(stdout: SshShell['stdout']) {
    stdout.on('data', (chunk: Buffer) => {
      if (this.waiters.length > 0) {
        // Hand directly to the oldest waiter — no copy, no queue.
        this.waiters.shift()!(chunk);
      } else {
        this.chunks.push(chunk);
      }
    });

    stdout.on('end', () => {
      this.ended = true;
      // Resolve every pending reader with EOF.
      for (const resolve of this.waiters) {
        resolve(null);
      }
      this.waiters = [];
    });

    stdout.on('error', () => {
      // Treat errors as EOF so the tmux event stream drains pending commands
      // instead of hanging forever.
      if (!this.ended) {
        this.ended = true;
        for (const resolve of this.waiters) {
          resolve(null);
        }
        this.waiters = [];
      }
    });
  }

  async read(): Promise<Buffer | null> {
    if (this.chunks.length > 0) {
      return this.chunks.shift()!;
    }
    if (this.ended) {
      return null;
    }
    return new Promise<Buffer | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

/**
 * Adapts an {@link SshShell} into the {@link SshChannel} contract consumed by
 * {@link TmuxClient.connect}. Each method maps 1:1 onto the shell.
 *
 * Lifecycle note: closing the bridge closes the underlying shell. The tmux
 * client calls `close()` from its own `close()`/`detach()` paths.
 */
export class SshShellBridge implements SshChannel {
  private readonly shell: SshShell;
  private readonly reader: ShellStreamReader;
  private closed = false;

  constructor(shell: SshShell) {
    this.shell = shell;
    this.reader = new ShellStreamReader(shell.stdout);
  }

  /** {@inheritDoc SshChannel.write} */
  async write(data: Buffer): Promise<void> {
    if (this.closed) {
      return;
    }
    // `stream.Writable.write` returns true if internal buffering is flushed,
    // false if the caller should wait. Both are fine here — we resolve once
    // the write is accepted by the underlying stream.
    this.shell.stdin.write(data);
  }

  /** {@inheritDoc SshChannel.getStdoutReader} */
  getStdoutReader(): StreamReader {
    return this.reader;
  }

  /** {@inheritDoc SshChannel.close} */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.shell.close();
  }
}
