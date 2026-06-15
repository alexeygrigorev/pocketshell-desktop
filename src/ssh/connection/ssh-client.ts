/**
 * SSH client wrapper for PocketShell Desktop.
 *
 * Wraps the `ssh2` Client to provide a clean async API for:
 * - Connecting and disconnecting
 * - Executing remote commands
 * - Opening interactive shell streams (for terminal)
 * - Opening SFTP sessions (for file browser)
 *
 * Includes connection pooling with coalescing and idle TTL.
 */

import { Client, SFTPWrapper } from 'ssh2';
import type { ConnectConfig } from 'ssh2';
import * as fs from 'fs';
import * as stream from 'stream';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Key material for SSH authentication. */
export type SshKeyMaterial =
  | { type: 'path'; file: string }
  | { type: 'pem'; content: string | Buffer };

/** Known-hosts verification policy. */
export type KnownHostsPolicy =
  | { type: 'acceptAll' }
  | { type: 'knownHostsFile'; file: string };

/** Parameters for establishing an SSH connection. */
export interface SshConnectParams {
  host: string;
  port: number;
  user: string;
  key: SshKeyMaterial;
  passphrase?: string;
  knownHosts?: KnownHostsPolicy;
  timeoutMs?: number; // default 30000
  keepAliveSeconds?: number; // default 15
}

/** Result of executing a remote command. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Parameters for opening an SSH direct-tcpip channel. */
export interface ForwardOutParams {
  srcHost: string;
  srcPort: number;
  dstHost: string;
  dstPort: number;
}

/** An active SSH connection. */
export interface SshConnection {
  readonly connected: boolean;

  /** Execute a command and return the result. */
  exec(command: string, timeout?: number): Promise<ExecResult>;

  /** Open an interactive shell with a PTY. */
  shell(options?: ShellOptions): Promise<SshShell>;

  /** Get an SFTP session. */
  sftp(): Promise<SFTPWrapper>;

  /** Open a direct-tcpip stream through the SSH connection. */
  forwardOut?(params: ForwardOutParams): Promise<stream.Duplex>;

  /** Gracefully disconnect. Idempotent. */
  disconnect(): void;
}

/** Options for opening a shell. */
export interface ShellOptions {
  term?: string; // default 'xterm-256color'
  cols?: number; // default 80
  rows?: number; // default 24
}

/** Shell stream handle. */
export interface SshShell {
  stdin: stream.Writable;
  stdout: stream.Readable;
  stderr: stream.Readable;
  resizePty(cols: number, rows: number): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class SshClient implements SshConnection {
  private client: Client;
  private _connected = false;

  constructor() {
    this.client = new Client();
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Establish an SSH connection.
   *
   * @throws Error on connection failure, auth failure, or timeout.
   */
  connect(params: SshConnectParams): Promise<SshConnection> {
    return new Promise((resolve, reject) => {
      if (this._connected) {
        reject(new Error('Already connected'));
        return;
      }

      const client = this.client;

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const onReady = () => {
        cleanup();
        this._connected = true;

        // Detect unexpected disconnect
        client.on('end', () => {
          this._connected = false;
        });
        client.on('close', () => {
          this._connected = false;
        });
        client.on('error', () => {
          this._connected = false;
        });

        resolve(this);
      };

      const cleanup = () => {
        client.removeListener('error', onError);
        client.removeListener('ready', onReady);
      };

      client.on('error', onError);
      client.on('ready', onReady);

      // Build connect config
      const connectConfig: ConnectConfig = {
        host: params.host,
        port: params.port,
        username: params.user,
        readyTimeout: params.timeoutMs ?? 30_000,
        keepaliveInterval: (params.keepAliveSeconds ?? 15) * 1000,
        keepaliveCountMax: 4,
      };

      // Set key material
      if (params.key.type === 'path') {
        connectConfig.privateKey = fs.readFileSync(params.key.file);
      } else {
        connectConfig.privateKey = params.key.content;
      }

      if (params.passphrase) {
        connectConfig.passphrase = params.passphrase;
      }

      // Known hosts policy
      if (params.knownHosts?.type === 'acceptAll' || !params.knownHosts) {
        // Accept any host key — OK for testing; production should use known_hosts
        (connectConfig as any).hostVerifier = () => true;
      }

      client.connect(connectConfig);
    });
  }

  /** Execute a remote command and return the result. */
  exec(command: string, timeout: number = 30_000): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      if (!this._connected) {
        reject(new Error('Not connected'));
        return;
      }

      const timer = setTimeout(() => {
        reject(new Error(`Command timed out after ${timeout}ms: ${command}`));
      }, timeout);

      this.client.exec(command, (err, channel) => {
        if (err) {
          clearTimeout(timer);
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';

        channel.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        channel.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
        channel.on('close', (exitCode: number | null) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, exitCode });
        });
      });
    });
  }

  /** Open an interactive shell with a PTY. */
  shell(options: ShellOptions = {}): Promise<SshShell> {
    return new Promise((resolve, reject) => {
      if (!this._connected) {
        reject(new Error('Not connected'));
        return;
      }

      const term = options.term ?? 'xterm-256color';
      const cols = options.cols ?? 80;
      const rows = options.rows ?? 24;

      this.client.shell(
        { term, cols, rows },
        (err, channel) => {
          if (err) {
            reject(err);
            return;
          }

          const shell: SshShell = {
            stdin: channel as unknown as stream.Writable,
            stdout: channel as unknown as stream.Readable,
            stderr: channel.stderr as unknown as stream.Readable,
            resizePty(cols: number, rows: number) {
              channel.setWindow(rows, cols, 0, 0);
            },
            close() {
              channel.close();
            },
          };

          resolve(shell);
        },
      );
    });
  }

  /** Get an SFTP session. */
  sftp(): Promise<SFTPWrapper> {
    return new Promise((resolve, reject) => {
      if (!this._connected) {
        reject(new Error('Not connected'));
        return;
      }

      this.client.sftp((err, sftp) => {
        if (err) {
          reject(err);
        } else {
          resolve(sftp);
        }
      });
    });
  }

  /** Open a direct-tcpip stream through the SSH connection. */
  forwardOut(params: ForwardOutParams): Promise<stream.Duplex> {
    return new Promise((resolve, reject) => {
      if (!this._connected) {
        reject(new Error('Not connected'));
        return;
      }

      this.client.forwardOut(
        params.srcHost,
        params.srcPort,
        params.dstHost,
        params.dstPort,
        (err, channel) => {
          if (err) {
            reject(err);
          } else {
            resolve(channel as unknown as stream.Duplex);
          }
        },
      );
    });
  }

  /** Gracefully disconnect. Idempotent. */
  disconnect(): void {
    if (this._connected) {
      this._connected = false;
      try {
        this.client.end();
      } catch {
        // Swallow teardown errors — disconnect is idempotent.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Connection pooling
// ---------------------------------------------------------------------------

/**
 * Connection pool key — uniquely identifies a connection target.
 */
export interface PoolKey {
  host: string;
  port: number;
  user: string;
  credentialId: string; // unique ID for the key material used
}

interface PoolEntry {
  connection: SshClient;
  refCount: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  createdAt: number;
}

const DEFAULT_IDLE_TTL_MS = 60_000;
const DEFAULT_MAX_IDLE = 2;

/**
 * Simple connection pool that coalesces concurrent connection attempts
 * and manages idle TTL.
 */
export class ConnectionPool {
  private entries = new Map<string, PoolEntry>();
  private pendingConnects = new Map<string, Promise<SshConnection>>();
  private idleTtlMs: number;
  private maxIdle: number;

  constructor(options?: { idleTtlMs?: number; maxIdle?: number }) {
    this.idleTtlMs = options?.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.maxIdle = options?.maxIdle ?? DEFAULT_MAX_IDLE;
  }

  private static keyToString(key: PoolKey): string {
    return `${key.user}@${key.host}:${key.port}[${key.credentialId}]`;
  }

  /**
   * Acquire a connection. If a live connection exists, reuses it.
   * If a connection attempt is in flight, awaits it (coalescing).
   * Otherwise, creates a new connection.
   */
  async acquire(
    key: PoolKey,
    params: SshConnectParams,
  ): Promise<SshConnection> {
    const keyStr = ConnectionPool.keyToString(key);

    // Check for an existing live connection
    const entry = this.entries.get(keyStr);
    if (entry && entry.connection.connected) {
      this.clearIdleTimer(entry);
      entry.refCount++;
      return entry.connection;
    }

    // Remove stale entry
    if (entry) {
      this.clearIdleTimer(entry);
      entry.connection.disconnect();
      this.entries.delete(keyStr);
    }

    // Coalesce: if a connect is already in flight, await it
    const pending = this.pendingConnects.get(keyStr);
    if (pending) {
      return pending;
    }

    // Start a new connection
    const connectPromise = this.doConnect(keyStr, params);
    this.pendingConnects.set(keyStr, connectPromise);

    try {
      const conn = await connectPromise;
      return conn;
    } finally {
      this.pendingConnects.delete(keyStr);
    }
  }

  private async doConnect(keyStr: string, params: SshConnectParams): Promise<SshConnection> {
    const client = new SshClient();
    const conn = await client.connect(params);

    const entry: PoolEntry = {
      connection: client,
      refCount: 1,
      idleTimer: null,
      createdAt: Date.now(),
    };

    this.entries.set(keyStr, entry);
    return conn;
  }

  /**
   * Release a connection back to the pool.
   * If no other holders are using it, starts the idle TTL timer.
   */
  release(key: PoolKey): void {
    const keyStr = ConnectionPool.keyToString(key);
    const entry = this.entries.get(keyStr);
    if (!entry) return;

    entry.refCount = Math.max(0, entry.refCount - 1);

    if (entry.refCount === 0) {
      // Start idle timer
      entry.idleTimer = setTimeout(() => {
        entry.connection.disconnect();
        this.entries.delete(keyStr);
      }, this.idleTtlMs);

      // Trim excess idle connections
      this.trimIdle();
    }
  }

  /** Force-disconnect a specific connection. */
  disconnect(key: PoolKey): void {
    const keyStr = ConnectionPool.keyToString(key);
    const entry = this.entries.get(keyStr);
    if (!entry) return;

    this.clearIdleTimer(entry);
    entry.connection.disconnect();
    this.entries.delete(keyStr);
  }

  /** Check whether a live connection exists for a key. */
  hasLive(key: PoolKey): boolean {
    const keyStr = ConnectionPool.keyToString(key);
    const entry = this.entries.get(keyStr);
    return !!entry && entry.connection.connected;
  }

  /** Close all connections. */
  closeAll(): void {
    for (const entry of this.entries.values()) {
      this.clearIdleTimer(entry);
      entry.connection.disconnect();
    }
    this.entries.clear();
  }

  private clearIdleTimer(entry: PoolEntry): void {
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  private trimIdle(): void {
    const idleEntries: [string, PoolEntry][] = [];

    for (const [keyStr, entry] of this.entries) {
      if (entry.refCount === 0 && entry.idleTimer !== null) {
        idleEntries.push([keyStr, entry]);
      }
    }

    // Sort by creation time ascending (oldest first)
    idleEntries.sort((a, b) => a[1].createdAt - b[1].createdAt);

    while (idleEntries.length > this.maxIdle) {
      const [keyStr, entry] = idleEntries.shift()!;
      this.clearIdleTimer(entry);
      entry.connection.disconnect();
      this.entries.delete(keyStr);
    }
  }
}
