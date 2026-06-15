import * as net from 'net';
import type { Duplex } from 'stream';
import type { ForwardOutParams, SshConnection } from '../ssh/connection/ssh-client';

export type PortForwardState =
  | 'starting'
  | 'listening'
  | 'stopping'
  | 'stopped'
  | 'error';

export type PortForwardErrorCode =
  | 'CONNECTION_UNAVAILABLE'
  | 'FORWARD_UNSUPPORTED'
  | 'LOCAL_PORT_IN_USE'
  | 'NO_AVAILABLE_PORT'
  | 'START_FAILED'
  | 'CHANNEL_FAILED'
  | 'STOP_FAILED';

export class PortForwardError extends Error {
  readonly code: PortForwardErrorCode;
  readonly tunnelId?: string;
  override readonly cause?: unknown;

  constructor(
    code: PortForwardErrorCode,
    message: string,
    options?: { tunnelId?: string; cause?: unknown },
  ) {
    super(message);
    this.name = 'PortForwardError';
    this.code = code;
    this.tunnelId = options?.tunnelId;
    this.cause = options?.cause;
  }
}

export interface SavedPortForwardSpec {
  id?: string;
  hostId: number;
  name?: string;
  localHost?: string;
  localPort?: number;
  remoteHost: string;
  remotePort: number;
}

export interface ActivePortForward {
  id: string;
  hostId: number;
  name?: string;
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  state: PortForwardState;
  createdAt: number;
  startedAt?: number;
  stoppedAt?: number;
  error?: PortForwardError;
  activeChannels: number;
}

export interface PortForwardHandle {
  readonly id: string;
  readonly localHost: string;
  readonly localPort: number;
  readonly remoteHost: string;
  readonly remotePort: number;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export interface SshConnectionProvider {
  getConnection(hostId: number): SshConnection | null;
}

export type PortForwardChange = (forward: ActivePortForward) => void;

export interface PortForwardManagerOptions {
  connections?: SshConnectionProvider;
  defaultLocalHost?: string;
  skipPortsBelow?: number;
  maxAutoPort?: number;
}

interface TunnelRuntime {
  record: ActivePortForward;
  server: net.Server;
  sockets: Set<net.Socket>;
  streams: Set<Duplex>;
  stopPromise?: Promise<void>;
}

type ForwardingConnection = SshConnection & {
  forwardOut(params: ForwardOutParams): Promise<Duplex>;
};

const DEFAULT_LOCAL_HOST = '127.0.0.1';
const DEFAULT_SKIP_PORTS_BELOW = 1000;
const DEFAULT_MAX_AUTO_PORT = 10000;

export class PortForwardManager {
  private readonly connections?: SshConnectionProvider;
  private readonly defaultLocalHost: string;
  private readonly skipPortsBelow: number;
  private readonly maxAutoPort: number;
  private readonly tunnels = new Map<string, TunnelRuntime>();
  private readonly listeners = new Set<PortForwardChange>();
  private nextId = 1;

  constructor(options: PortForwardManagerOptions = {}) {
    this.connections = options.connections;
    this.defaultLocalHost = options.defaultLocalHost ?? DEFAULT_LOCAL_HOST;
    this.skipPortsBelow = options.skipPortsBelow ?? DEFAULT_SKIP_PORTS_BELOW;
    this.maxAutoPort = options.maxAutoPort ?? DEFAULT_MAX_AUTO_PORT;
  }

  onChange(listener: PortForwardChange): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  list(): ActivePortForward[] {
    return Array.from(this.tunnels.values(), (runtime) => this.snapshot(runtime));
  }

  get(id: string): ActivePortForward | undefined {
    const runtime = this.tunnels.get(id);
    return runtime ? this.snapshot(runtime) : undefined;
  }

  async start(
    spec: SavedPortForwardSpec,
    connection?: SshConnection,
  ): Promise<PortForwardHandle> {
    const id = spec.id ?? this.allocateId();
    if (this.tunnels.has(id)) {
      throw new PortForwardError(
        'LOCAL_PORT_IN_USE',
        `Port forward ${id} is already active`,
        { tunnelId: id },
      );
    }

    this.getForwardingConnection(id, spec.hostId, connection);

    const localHost = spec.localHost ?? this.defaultLocalHost;
    const requestedPort = spec.localPort ?? 0;
    const record: ActivePortForward = {
      id,
      hostId: spec.hostId,
      name: spec.name,
      localHost,
      localPort: requestedPort,
      remoteHost: spec.remoteHost,
      remotePort: spec.remotePort,
      state: 'starting',
      createdAt: Date.now(),
      activeChannels: 0,
    };

    const runtime: TunnelRuntime = {
      record,
      server: net.createServer((socket) => {
        this.handleLocalConnection(runtime, connection, socket);
      }),
      sockets: new Set(),
      streams: new Set(),
    };

    this.tunnels.set(id, runtime);
    this.emit(runtime);

    try {
      const localPort = await this.listen(runtime, requestedPort);
      runtime.record.localPort = localPort;
      runtime.record.state = 'listening';
      runtime.record.startedAt = Date.now();
      runtime.server.on('error', (err) => {
        this.setError(runtime, 'START_FAILED', err.message, err);
      });
      this.emit(runtime);
    } catch (err) {
      const error = this.toPortForwardError(id, err);
      runtime.record.localPort = requestedPort;
      runtime.record.state = 'error';
      runtime.record.error = error;
      this.emit(runtime);
      this.tunnels.delete(id);
      throw error;
    }

    return this.createHandle(runtime);
  }

  async stop(id: string): Promise<void> {
    const runtime = this.tunnels.get(id);
    if (!runtime) {
      return;
    }
    await this.stopRuntime(runtime);
  }

  async dispose(): Promise<void> {
    await Promise.all(Array.from(this.tunnels.keys(), (id) => this.stop(id)));
    this.listeners.clear();
  }

  private createHandle(runtime: TunnelRuntime): PortForwardHandle {
    const { id, localHost, localPort, remoteHost, remotePort } = runtime.record;
    return {
      id,
      localHost,
      localPort,
      remoteHost,
      remotePort,
      stop: () => this.stop(id),
      dispose: () => this.stop(id),
    };
  }

  private getForwardingConnection(
    tunnelId: string,
    hostId: number,
    pinnedConnection?: SshConnection,
  ): ForwardingConnection {
    const connection =
      pinnedConnection ?? this.connections?.getConnection(hostId) ?? null;

    if (!connection || !connection.connected) {
      throw new PortForwardError(
        'CONNECTION_UNAVAILABLE',
        `Host ${hostId} does not have an active SSH connection`,
        { tunnelId },
      );
    }
    if (!connection.forwardOut) {
      throw new PortForwardError(
        'FORWARD_UNSUPPORTED',
        `Host ${hostId} connection does not support port forwarding`,
        { tunnelId },
      );
    }
    return connection as ForwardingConnection;
  }

  private async listen(runtime: TunnelRuntime, requestedPort: number): Promise<number> {
    if (requestedPort > 0) {
      if (this.hasActiveLocalPort(runtime.record.localHost, requestedPort, runtime.record.id)) {
        throw new PortForwardError(
          'LOCAL_PORT_IN_USE',
          `Local port ${requestedPort} is already used by another tunnel`,
          { tunnelId: runtime.record.id },
        );
      }
      await this.listenOnPort(runtime.server, runtime.record.localHost, requestedPort);
      return requestedPort;
    }

    for (let port = this.skipPortsBelow; port <= this.maxAutoPort; port++) {
      if (this.hasActiveLocalPort(runtime.record.localHost, port, runtime.record.id)) {
        continue;
      }
      try {
        await this.listenOnPort(runtime.server, runtime.record.localHost, port);
        return port;
      } catch (err) {
        if (isAddressInUse(err)) {
          continue;
        }
        throw new PortForwardError(
          'START_FAILED',
          `Failed to listen on ${runtime.record.localHost}:${port}`,
          { tunnelId: runtime.record.id, cause: err },
        );
      }
    }

    throw new PortForwardError(
      'NO_AVAILABLE_PORT',
      `No local ports available between ${this.skipPortsBelow} and ${this.maxAutoPort}`,
      { tunnelId: runtime.record.id },
    );
  }

  private listenOnPort(
    server: net.Server,
    localHost: string,
    localPort: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onListening = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        server.off('error', onError);
        server.off('listening', onListening);
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(localPort, localHost);
    });
  }

  private hasActiveLocalPort(
    localHost: string,
    localPort: number,
    exceptId?: string,
  ): boolean {
    for (const runtime of this.tunnels.values()) {
      const record = runtime.record;
      if (
        record.id !== exceptId &&
        record.state !== 'stopped' &&
        record.state !== 'error' &&
        record.localHost === localHost &&
        record.localPort === localPort
      ) {
        return true;
      }
    }
    return false;
  }

  private handleLocalConnection(
    runtime: TunnelRuntime,
    pinnedConnection: SshConnection | undefined,
    socket: net.Socket,
  ): void {
    let connection: ForwardingConnection;
    try {
      connection = this.getForwardingConnection(
        runtime.record.id,
        runtime.record.hostId,
        pinnedConnection,
      );
    } catch (err) {
      this.recordSocketError(runtime, err);
      socket.destroy();
      return;
    }

    runtime.sockets.add(socket);
    this.updateChannelCount(runtime);

    socket.once('close', () => {
      runtime.sockets.delete(socket);
      this.updateChannelCount(runtime);
    });
    socket.once('error', () => {
      socket.destroy();
    });

    const srcHost = socket.remoteAddress ?? DEFAULT_LOCAL_HOST;
    const srcPort = socket.remotePort ?? 0;

    connection
      .forwardOut({
        srcHost,
        srcPort,
        dstHost: runtime.record.remoteHost,
        dstPort: runtime.record.remotePort,
      })
      .then((remoteStream) => {
        if (runtime.record.state !== 'listening' || socket.destroyed) {
          remoteStream.destroy();
          return;
        }

        runtime.streams.add(remoteStream);
        this.updateChannelCount(runtime);

        const closeBoth = () => {
          socket.destroy();
          remoteStream.destroy();
        };
        remoteStream.once('close', () => {
          runtime.streams.delete(remoteStream);
          this.updateChannelCount(runtime);
        });
        remoteStream.once('error', closeBoth);
        socket.once('error', closeBoth);

        socket.pipe(remoteStream);
        remoteStream.pipe(socket);
      })
      .catch((err) => {
        this.recordSocketError(runtime, new PortForwardError(
          'CHANNEL_FAILED',
          err.message,
          { tunnelId: runtime.record.id, cause: err },
        ));
        socket.destroy();
      });
  }

  private recordSocketError(runtime: TunnelRuntime, err: unknown): void {
    runtime.record.error =
      err instanceof PortForwardError
        ? err
        : new PortForwardError(
            'CHANNEL_FAILED',
            getErrorMessage(err),
            { tunnelId: runtime.record.id, cause: err },
          );
    this.emit(runtime);
  }

  private async stopRuntime(runtime: TunnelRuntime): Promise<void> {
    if (runtime.stopPromise) {
      return runtime.stopPromise;
    }

    runtime.record.state = 'stopping';
    this.emit(runtime);

    runtime.stopPromise = new Promise<void>((resolve, reject) => {
      for (const socket of runtime.sockets) {
        socket.destroy();
      }
      for (const remoteStream of runtime.streams) {
        remoteStream.destroy();
      }

      const finish = (err?: Error) => {
        if (err) {
          const error = new PortForwardError(
            'STOP_FAILED',
            err.message,
            { tunnelId: runtime.record.id, cause: err },
          );
          runtime.record.state = 'error';
          runtime.record.error = error;
          this.emit(runtime);
          reject(error);
          return;
        }

        runtime.record.state = 'stopped';
        runtime.record.stoppedAt = Date.now();
        runtime.record.activeChannels = 0;
        this.emit(runtime);
        this.tunnels.delete(runtime.record.id);
        resolve();
      };

      if (!runtime.server.listening) {
        finish();
        return;
      }

      runtime.server.close(finish);
    });

    return runtime.stopPromise;
  }

  private setError(
    runtime: TunnelRuntime,
    code: PortForwardErrorCode,
    message: string,
    cause?: unknown,
  ): void {
    runtime.record.state = 'error';
    runtime.record.error = new PortForwardError(code, message, {
      tunnelId: runtime.record.id,
      cause,
    });
    this.emit(runtime);
  }

  private updateChannelCount(runtime: TunnelRuntime): void {
    runtime.record.activeChannels = runtime.sockets.size + runtime.streams.size;
    this.emit(runtime);
  }

  private toPortForwardError(tunnelId: string, err: unknown): PortForwardError {
    if (err instanceof PortForwardError) {
      return err;
    }
    if (isAddressInUse(err)) {
      return new PortForwardError(
        'LOCAL_PORT_IN_USE',
        getErrorMessage(err),
        { tunnelId, cause: err },
      );
    }
    return new PortForwardError(
      'START_FAILED',
      getErrorMessage(err),
      { tunnelId, cause: err },
    );
  }

  private emit(runtime: TunnelRuntime): void {
    const snapshot = this.snapshot(runtime);
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private snapshot(runtime: TunnelRuntime): ActivePortForward {
    return { ...runtime.record };
  }

  private allocateId(): string {
    return `pf-${this.nextId++}`;
  }
}

function isAddressInUse(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'EADDRINUSE';
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
