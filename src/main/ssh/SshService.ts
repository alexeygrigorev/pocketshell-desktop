import { readFileSync } from 'node:fs';
import type { ClientChannel, PseudoTtyOptions } from 'ssh2';
import type { ConnectResult, ExecResult, ShellId } from '../../shared/types.js';
import { newClient, ConnectionRegistry, type ConnectionRecord } from './ConnectionRegistry.js';
import { ShellTracker } from './ShellTracker.js';
import type { KnownHosts } from '../ssh-config/KnownHosts.js';

/**
 * SSH connection service wrapping `ssh2`. Mirrors the contract of the
 * Android `RealSshSession`: connect with publickey auth + 15s keepalive +
 * 30s timeout; exec returns `{stdout, stderr, exitCode}` and **never
 * throws on non-zero exit** (exit codes are semantic, e.g. `command -v`);
 * tail spawns `tail -F`; shell opens a PTY (`xterm-256color`, 80×24).
 *
 * All methods return result objects rather than throwing for expected
 * failures (auth refused, host unreachable, transport drop). Hard
 * programming errors (bad arguments) still throw.
 */

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_KEEPALIVE_INTERVAL_SEC = 15;
export const PTY_TERM = 'xterm-256color';
export const PTY_DEFAULT_COLS = 80;
export const PTY_DEFAULT_ROWS = 24;

export interface ConnectOptions {
  host: string;
  port?: number;
  user: string;
  /** Absolute path to a private key file. */
  privateKeyPath?: string;
  /** Inline private key PEM/OpenSSH-v1 text (wins over privateKeyPath). */
  privateKey?: string;
  passphrase?: string;
  timeoutMs?: number;
  keepAliveIntervalSec?: number;
  /** When set, host keys are verified; unknown -> TOFU result. */
  knownHosts?: KnownHosts | null;
  /** TOFU decision: 'accept-always' appends to known_hosts; 'accept-once' proceeds without saving. */
  tofuDecision?: 'accept-always' | 'accept-once' | 'reject';
}

export interface ExecOptions {
  /** Optional PTY (forces merge of stderr into stdout). */
  pty?: boolean;
  /** Env to set on the channel. */
  env?: Record<string, string>;
}

export interface ShellHandle {
  /** Write bytes to the remote PTY stdin. */
  write(data: string | Buffer): void;
  /** Resize the remote PTY. */
  setWindow(cols: number, rows: number): void;
  /** Close the shell channel. */
  close(): void;
  /** Stream of stdout bytes (rendered by xterm.js). */
  stdout: NodeJS.ReadableStream;
}

export interface TailHandle {
  stop(): void;
}

export class SshService {
  private readonly shells: ShellTracker;
  constructor(
    private readonly registry: ConnectionRegistry = new ConnectionRegistry(),
    shells?: ShellTracker,
  ) {
    this.shells = shells ?? new ShellTracker();
  }

  /** Expose the shell tracker so the IPC layer can route input/resize/close. */
  get shellTracker(): ShellTracker {
    return this.shells;
  }

  /** Attempt a connection. Resolves a {@link ConnectResult}; never rejects. */
  connect(opts: ConnectOptions): Promise<ConnectResult> {
    return new Promise((resolve) => {
      const client = newClient();
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      const fail = (error: string, unknownHostKey?: ConnectResult['unknownHostKey']) => {
        try {
          client.end();
        } catch {
          // ignore
        }
        resolve({ ok: false, error, unknownHostKey });
      };

      const timer = setTimeout(() => {
        fail(`SSH connect timed out after ${timeoutMs}ms`);
      }, timeoutMs);

      client.once('ready', () => {
        clearTimeout(timer);
        const id = this.registry.register({
          client,
          label: `${opts.user}@${opts.host}:${opts.port ?? 22}`,
          host: opts.host,
          port: opts.port ?? 22,
          user: opts.user,
          knownHosts: opts.knownHosts ?? null,
          connectedAt: Date.now(),
        });
        resolve({ ok: true, connectionId: id });
      });

      client.once('error', (err: NodeJS.ErrnoException & { code?: string }) => {
        clearTimeout(timer);
        fail(translateError(err));
      });

      try {
        const privateKey = loadKey(opts);
        client.connect({
          host: opts.host,
          port: opts.port ?? 22,
          username: opts.user,
          privateKey,
          passphrase: opts.passphrase,
          readyTimeout: timeoutMs,
          keepaliveInterval: (opts.keepAliveIntervalSec ?? DEFAULT_KEEPALIVE_INTERVAL_SEC) * 1000,
          // Host-key verification via the callback ssh2 invokes during the
          // handshake. Returning true accepts the key (and proceeds to auth);
          // returning false aborts. We consult ~/.ssh/known_hosts here and
          // honour the caller's TOFU decision for unknown hosts.
          hostVerifier: (key: Buffer) => {
            if (!opts.knownHosts) return true; // caller opted out of verification
            const { type, b64 } = decodePublicKeyBlob(key);
            const verdict = opts.knownHosts.verify(opts.host, type, b64);
            if (verdict.trusted) return true;
            if (verdict.mismatch) {
              fail('Host key mismatch — connection refused (known_hosts).');
              return false;
            }
            // unknown
            if (opts.tofuDecision === 'reject') {
              fail('Host key rejected by user.');
              return false;
            }
            if (opts.tofuDecision === 'accept-always') {
              opts.knownHosts.add(opts.host, type, b64);
            }
            return true; // accept-once proceeds without saving
          },
        });
      } catch (e) {
        clearTimeout(timer);
        fail(`Failed to load key: ${(e as Error).message}`);
      }
    });
  }

  /** Execute a command; resolve on completion. No throw on non-zero exit. */
  async exec(connectionId: string, command: string, _opts: ExecOptions = {}): Promise<ExecResult> {
    const rec = this.registry.require(connectionId);
    return execOnClient(rec, command);
  }

  /** Spawn a shell with a PTY. Used by the terminal view (Phase 1). */
  async shell(
    connectionId: string,
    opts: { cols?: number; rows?: number; term?: string } = {},
  ): Promise<ShellHandle> {
    const rec = this.registry.require(connectionId);
    const channel = await openShell(rec, {
      term: opts.term ?? PTY_TERM,
      cols: opts.cols ?? PTY_DEFAULT_COLS,
      rows: opts.rows ?? PTY_DEFAULT_ROWS,
    });
    return {
      stdout: channel,
      write: (data) => channel.write(data),
      setWindow: (cols, rows) => channel.setWindow(rows, cols, rows, cols),
      close: () => {
        try {
          channel.end();
          channel.close();
        } catch {
          // ignore
        }
      },
    };
  }

  /**
   * Open a tracked PTY shell and return its id. Output bytes are delivered via
   * `onData`; exit via `onExit`. This is the form the IPC layer uses so the
   * renderer can address the shell across separate calls (input/resize/close)
   * by id alone.
   *
   * @param command Optional command to run inside the PTY (e.g. `tmux attach -t main`).
   *                When omitted, an interactive shell is opened.
   */
  async openTrackedShell(
    connectionId: string,
    opts: {
      cols?: number;
      rows?: number;
      term?: string;
      command?: string;
      onData: (data: Buffer) => void;
      onExit?: (exitCode: number) => void;
    },
  ): Promise<ShellId> {
    const rec = this.registry.require(connectionId);
    const channel = await openShell(rec, {
      term: opts.term ?? PTY_TERM,
      cols: opts.cols ?? PTY_DEFAULT_COLS,
      rows: opts.rows ?? PTY_DEFAULT_ROWS,
    });
    const id = this.shells.register({ channel, connectionId });
    channel.on('data', (chunk: Buffer) => opts.onData(chunk));
    channel.on('close', () => {
      opts.onExit?.(0);
      this.shells.remove(id);
    });
    // If a command was requested, write it to the shell's stdin (the PTY runs
    // an interactive login shell; we send the command as if the user typed it).
    if (opts.command) {
      channel.write(opts.command + '\n');
    }
    return id;
  }

  /** Write input bytes to a tracked shell's stdin (xterm.js -> remote). */
  shellInput(shellId: ShellId, data: string | Buffer): void {
    const rec = this.shells.get(shellId);
    if (rec) rec.channel.write(data);
  }

  /** Resize a tracked shell's PTY. */
  shellResize(shellId: ShellId, cols: number, rows: number): void {
    const rec = this.shells.get(shellId);
    if (rec) rec.channel.setWindow(rows, cols, rows, cols);
  }

  /** Close a tracked shell. */
  shellClose(shellId: ShellId): void {
    const rec = this.shells.remove(shellId);
    if (rec) {
      try {
        rec.channel.end();
        rec.channel.close();
      } catch {
        // ignore
      }
    }
  }

  /** Tail a file via `tail -F`; caller re-launches after a transport drop. */
  tail(
    connectionId: string,
    path: string,
    fromLineExclusive: number,
    onLine: (line: string) => void,
  ): TailHandle {
    const rec = this.registry.require(connectionId);
    const start = fromLineExclusive >= 0 ? fromLineExclusive + 1 : 0;
    const cmd = `tail -F -n +${start} '${path.replace(/'/g, "'\\''")}'`;
    let stopped = false;
    rec.client.exec(cmd, (err, stream) => {
      if (err || !stream) {
        // Swallow transport drops — the reconnect FSM re-launches the tail.
        return;
      }
      let buf = '';
      stream.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let nl: number;
        while (!stopped && (nl = buf.indexOf('\n')) >= 0) {
          onLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      });
      stream.on('close', () => {
        if (buf && !stopped) onLine(buf);
      });
    });
    return {
      stop: () => {
        stopped = true;
      },
    };
  }

  /** Close a connection idempotently (also tears down its shells). */
  close(connectionId: string): void {
    this.shells.closeAllForConnection(connectionId);
    const rec = this.registry.remove(connectionId);
    if (rec) {
      try {
        rec.client.end();
      } catch {
        // ignore
      }
    }
  }

  get registry_(): ConnectionRegistry {
    return this.registry;
  }
}

function loadKey(opts: ConnectOptions): Buffer {
  if (opts.privateKey) return Buffer.from(opts.privateKey, 'utf8');
  if (opts.privateKeyPath) return readFileSync(opts.privateKeyPath);
  throw new Error('No private key provided (pass privateKey or privateKeyPath).');
}

function execOnClient(rec: ConnectionRecord, command: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    rec.client.exec(command, (err, stream) => {
      if (err || !stream) {
        // Translate transport errors into an ExecResult; never reject.
        resolve({ stdout: '', stderr: err?.message ?? 'exec failed', exitCode: -1 });
        return;
      }
      let stdout = '';
      let stderr = '';
      stream.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      stream.on('close', (code: number | null) => {
        resolve({ stdout, stderr, exitCode: code ?? -1 });
      });
    });
  });
}

function openShell(
  rec: ConnectionRecord,
  pty: { term: string; cols: number; rows: number },
): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    // ssh2 `shell(window, callback)`: the first arg is the PTY options
    // (term/cols/rows). We request a real PTY so tmux/agent CLIs render.
    const window: PseudoTtyOptions = {
      term: pty.term,
      cols: pty.cols,
      rows: pty.rows,
    };
    rec.client.shell(window, (err, stream) => {
      if (err || !stream) {
        reject(err ?? new Error('shell failed'));
        return;
      }
      resolve(stream as unknown as ClientChannel);
    });
  });
}

function translateError(err: NodeJS.ErrnoException & { code?: string }): string {
  switch (err.code) {
    case 'ENOTFOUND':
      return `Host not found: ${err.message}`;
    case 'ECONNREFUSED':
      return `Connection refused: ${err.message}`;
    case 'ECONNRESET':
      return `Connection reset: ${err.message}`;
    case 'ETIMEDOUT':
      return `Connection timed out`;
    default:
      return err.message;
  }
}

/**
 * Decode an SSH public key blob (the raw bytes ssh2 hands to hostVerifier)
 * into the key-type label + the base64 that known_hosts stores.
 *
 * The blob format is RFC 4251 string-list: `<uint32 len><type><key-data...>`.
 * The base64 known_hosts line is the base64 of exactly this blob, so the b64
 * here is directly comparable to a known_hosts entry.
 */
function decodePublicKeyBlob(blob: Buffer): { type: string; b64: string } {
  // First 4 bytes = big-endian uint32 length of the key-type string.
  if (blob.length < 4) return { type: 'unknown', b64: blob.toString('base64') };
  const len = blob.readUInt32BE(0);
  const type =
    len > 0 && blob.length >= 4 + len
      ? blob.subarray(4, 4 + len).toString('utf8')
      : 'unknown';
  return { type, b64: blob.toString('base64') };
}
