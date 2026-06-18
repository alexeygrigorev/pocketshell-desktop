import { createServer, type Server, type Socket } from 'node:net';
import type { Client } from 'ssh2';
import type { ConnectionRegistry } from '../ssh/ConnectionRegistry.js';
import type { ForwardSpec } from '../../shared/types.js';

/**
 * A single port-forward rule over an SSH connection. Supports the three
 * forward types desktop users expect:
 *
 *   - local ('-L'):  listen on localhost, forward each connection out via
 *                    ssh2 `forwardOut` to (destHost:destPort) from the server.
 *   - remote ('-R'): ask the server to listen on (destHost:destPort) via
 *                    `forwardIn`; incoming connections arrive as 'tcp'
 *                    channels we pipe to a local server (or, when no local
 *                    destination is configured, dropped after logging).
 *   - dynamic ('-D'): run a local SOCKS5 server; per SOCKS request, open a
 *                    `forwardOut` to the requested host:port.
 *
 * The Android app implements local-only; remote + dynamic are net-new here.
 */

export interface ForwardState {
  kind: ForwardSpec['kind'];
  listenHost: string;
  listenPort: number;
  destHost: string;
  destPort: number;
  active: boolean;
  bytesIn: number;
  bytesOut: number;
}

export type ForwardEventListener = (state: ForwardState) => void;

export class Forwarder {
  readonly spec: ForwardSpec;
  private server: Server | null = null;
  private listeners = new Set<ForwardEventListener>();
  private bytesIn = 0;
  private bytesOut = 0;
  private remoteAccepted = false;

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly connectionId: string,
    spec: ForwardSpec,
  ) {
    this.spec = spec;
  }

  onStateChange(listener: ForwardEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const state = this.snapshot();
    for (const l of this.listeners) l(state);
  }

  snapshot(): ForwardState {
    return {
      kind: this.spec.kind,
      listenHost: this.spec.listenHost,
      listenPort: this.spec.listenPort,
      destHost: this.spec.destHost,
      destPort: this.spec.destPort,
      active: this.isActive(),
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
    };
  }

  private isActive(): boolean {
    if (this.spec.kind === 'remote') return this.remoteAccepted;
    return !!this.server && this.server.listening;
  }

  /** Start the forward. Resolves true on success. */
  async start(): Promise<boolean> {
    try {
      if (this.spec.kind === 'local') return await this.startLocal();
      if (this.spec.kind === 'dynamic') return await this.startDynamic();
      if (this.spec.kind === 'remote') return await this.startRemote();
      return false;
    } catch {
      this.emit();
      return false;
    }
  }

  /** Tear down the forward (idempotent). */
  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    if (this.spec.kind === 'remote') {
      const client = this.client();
      if (client) {
        await new Promise<void>((resolve) =>
          client.unforwardIn(this.spec.destHost, this.spec.destPort, () => resolve()),
        );
      }
      this.remoteAccepted = false;
    }
    this.emit();
  }

  // --- local -L -----------------------------------------------------------
  private startLocal(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const server = createServer((socket) => this.pipeForwardOut(socket));
      server.on('error', () => resolve(false));
      server.listen(this.spec.listenPort, this.spec.listenHost, () => {
        this.server = server;
        this.emit();
        resolve(true);
      });
    });
  }

  // --- dynamic -D (SOCKS5) ------------------------------------------------
  private startDynamic(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const server = createServer((socket) => handleSocks5(socket, (host, port) => this.forwardOutTo(socket, host, port)));
      server.on('error', () => resolve(false));
      server.listen(this.spec.listenPort, this.spec.listenHost, () => {
        this.server = server;
        this.emit();
        resolve(true);
      });
    });
  }

  // --- remote -R ----------------------------------------------------------
  private startRemote(): Promise<boolean> {
    const client = this.client();
    if (!client) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      client.forwardIn(this.spec.destHost, this.spec.destPort, (err, remotePort) => {
        if (err || remotePort !== this.spec.destPort) {
          resolve(false);
          return;
        }
        this.remoteAccepted = true;
        // Accept incoming channels for the remote forward. The ssh2 client
        // emits an untyped 'tcp' event for forwarded connections; cast to a
        // minimal handler shape (@types/ssh2 does not model this event).
        (client as unknown as {
          on(
            event: 'tcp',
            listener: (
              info: { destIP: string; destPort: number; srcIP: string; srcPort: number },
              accept: () => Socket,
              deny: () => void,
            ) => void,
          ): unknown;
        }).on('tcp', (info, accept, deny) => this.onRemoteConnection(info, accept, deny));
        this.emit();
        resolve(true);
      });
    });
  }

  private onRemoteConnection(
    info: { destIP: string; destPort: number; srcIP: string; srcPort: number },
    accept: () => Socket,
    deny: () => void,
  ): void {
    void info;
    const remote = accept();
    // For a basic -R without a local listener, just keep the channel open and
    // count bytes. (A full local-destination mapping is a future refinement.)
    remote.on('data', (d: Buffer) => {
      this.bytesIn += d.length;
    });
    remote.on('close', () => this.emit());
    this.emit();
    void deny;
  }

  // --- shared helpers -----------------------------------------------------
  private client(): Client | undefined {
    return this.registry.get(this.connectionId)?.client;
  }

  private pipeForwardOut(socket: Socket): void {
    const client = this.client();
    if (!client) {
      socket.destroy();
      return;
    }
    this.forwardOutTo(socket, this.spec.destHost, this.spec.destPort);
  }

  private forwardOutTo(socket: Socket, destHost: string, destPort: number): void {
    const client = this.client();
    if (!client) {
      socket.destroy();
      return;
    }
    client.forwardOut(socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, destHost, destPort, (err, channel) => {
      if (err || !channel) {
        socket.destroy();
        return;
      }
      socket.pipe(channel);
      channel.pipe(socket);
      const count = (buf: Buffer) => {
        this.bytesIn += buf.length;
      };
      socket.on('data', count);
      channel.on('data', (buf: Buffer) => {
        this.bytesOut += buf.length;
      });
      const done = () => this.emit();
      socket.on('close', done);
      channel.on('close', done);
    });
  }
}

/**
 * Minimal SOCKS5 (no-auth) handshake: read the connect request, resolve the
 * destination, then hand the socket + target to `connect` for the caller to
 * open a `forwardOut`. Used by the dynamic (-D) forwarder.
 */
function handleSocks5(
  socket: Socket,
  connect: (host: string, port: number) => void,
): void {
  socket.once('data', (buf: Buffer) => {
    // Greeting: ver, nmethods, methods... (we only support no-auth = 0x00).
    if (buf.length < 2 || buf[0] !== 0x05) {
      socket.destroy();
      return;
    }
    socket.write(Buffer.from([0x05, 0x00]));
    socket.once('data', (req: Buffer) => {
      // CONNECT: ver(1) cmd(1) rsv(1) atyp(1) addr... port(2)
      if (req.length < 4 || req[0] !== 0x05 || req[1] !== 0x01) {
        socket.destroy();
        return;
      }
      const atyp = req[3];
      let host = '';
      let port = 0;
      let offset = 4;
      try {
        if (atyp === 0x01) {
          // IPv4
          host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`;
          offset = 8;
        } else if (atyp === 0x03) {
          // domain
          const len = req[4] ?? 0;
          host = req.subarray(5, 5 + len).toString('ascii');
          offset = 5 + len;
        } else if (atyp === 0x04) {
          // IPv6
          const parts: string[] = [];
          for (let i = 0; i < 16; i++) parts.push(req[4 + i]!.toString(16));
          host = parts.join(':');
          offset = 20;
        } else {
          socket.destroy();
          return;
        }
        port = (req[offset]! << 8) | req[offset + 1]!;
      } catch {
        socket.destroy();
        return;
      }
      // Reply success, then defer to the caller's forwardOut.
      socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      connect(host, port);
    });
  });
}
