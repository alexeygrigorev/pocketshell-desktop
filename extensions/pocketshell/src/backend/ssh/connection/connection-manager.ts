/**
 * Connection state machine for PocketShell Desktop.
 *
 * Manages the lifecycle of SSH connections with states, events,
 * auto-reconnect with exponential backoff, and state-change callbacks.
 *
 * Adapted from the Android ConnectionController (section 7 of the reference doc)
 * but simplified for the desktop context (no foreground/background model;
 * instead, the app is either running or not).
 */

import { SshConnection, SshConnectParams, SshClient } from './ssh-client';

// ---------------------------------------------------------------------------
// State machine types
// ---------------------------------------------------------------------------

export enum ConnectionState {
  Idle = 'Idle',
  Connecting = 'Connecting',
  Connected = 'Connected',
  Disconnecting = 'Disconnecting',
  Disconnected = 'Disconnected',
  Error = 'Error',
}

export enum ConnectionEvent {
  Connect = 'connect',
  Disconnect = 'disconnect',
  ConnectionLost = 'connectionLost',
  Reconnect = 'reconnect',
}

export interface StateChange {
  hostId: number;
  oldState: ConnectionState;
  newState: ConnectionState;
  event: ConnectionEvent;
  error?: Error;
  attempt?: number;
}

export type StateChangeCallback = (change: StateChange) => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 4;
const BASE_RECONNECT_DELAY_MS = 1000; // 1s, doubles each attempt

// ---------------------------------------------------------------------------
// Connection Manager
// ---------------------------------------------------------------------------

export class ConnectionManager {
  private states = new Map<number, ConnectionState>();
  private connections = new Map<number, SshClient>();
  private reconnectAttempts = new Map<number, number>();
  private reconnectTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private callbacks: StateChangeCallback[] = [];
  private maxReconnectAttempts: number;

  constructor(options?: { maxReconnectAttempts?: number }) {
    this.maxReconnectAttempts =
      options?.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
  }

  /**
   * Register a callback for state changes.
   * Returns an unsubscribe function.
   */
  onStateChange(callback: StateChangeCallback): () => void {
    this.callbacks.push(callback);
    return () => {
      const idx = this.callbacks.indexOf(callback);
      if (idx >= 0) this.callbacks.splice(idx, 1);
    };
  }

  /** Get the current state for a host. */
  getState(hostId: number): ConnectionState {
    return this.states.get(hostId) ?? ConnectionState.Idle;
  }

  /** Get the active connection for a host, or null. */
  getConnection(hostId: number): SshConnection | null {
    const client = this.connections.get(hostId);
    if (client && client.connected) return client;
    return null;
  }

  /**
   * Connect to a host.
   *
   * Transitions: Idle/Disconnected/Error -> Connecting -> Connected (or Error)
   */
  async connect(hostId: number, params: SshConnectParams): Promise<SshConnection> {
    const current = this.getState(hostId);
    if (current === ConnectionState.Connecting || current === ConnectionState.Connected) {
      throw new Error(`Host ${hostId} is already ${current}`);
    }

    // Clear any pending reconnect timer
    this.clearReconnectTimer(hostId);

    this.transition(hostId, ConnectionState.Connecting, ConnectionEvent.Connect);

    const client = new SshClient();

    try {
      const conn = await client.connect(params);
      this.connections.set(hostId, client);
      this.reconnectAttempts.delete(hostId);
      this.transition(hostId, ConnectionState.Connected, ConnectionEvent.Connect);

      // Monitor for connection loss
      this.monitorConnection(hostId, client);

      return conn;
    } catch (err: any) {
      this.connections.delete(hostId);
      this.transition(hostId, ConnectionState.Error, ConnectionEvent.Connect, err);
      throw err;
    }
  }

  /**
   * Disconnect from a host.
   *
   * Transitions: Connected -> Disconnecting -> Disconnected
   * Also works from Connecting (cancels the connection).
   */
  disconnect(hostId: number): void {
    this.clearReconnectTimer(hostId);
    this.reconnectAttempts.delete(hostId);

    const current = this.getState(hostId);
    if (
      current === ConnectionState.Idle ||
      current === ConnectionState.Disconnected
    ) {
      return; // Nothing to do
    }

    this.transition(hostId, ConnectionState.Disconnecting, ConnectionEvent.Disconnect);

    const client = this.connections.get(hostId);
    if (client) {
      client.disconnect();
      this.connections.delete(hostId);
    }

    this.transition(hostId, ConnectionState.Disconnected, ConnectionEvent.Disconnect);
  }

  /**
   * Initiate a reconnect attempt.
   *
   * Uses exponential backoff. After max attempts, transitions to Error.
   */
  reconnect(hostId: number, params: SshConnectParams): void {
    const attempt = (this.reconnectAttempts.get(hostId) ?? 0) + 1;

    if (attempt > this.maxReconnectAttempts) {
      this.reconnectAttempts.delete(hostId);
      this.transition(
        hostId,
        ConnectionState.Error,
        ConnectionEvent.Reconnect,
        new Error(`Max reconnect attempts (${this.maxReconnectAttempts}) exceeded`),
        attempt,
      );
      return;
    }

    this.reconnectAttempts.set(hostId, attempt);

    const delay = BASE_RECONNECT_DELAY_MS * Math.pow(2, attempt - 1);

    this.transition(
      hostId,
      this.getState(hostId), // Keep current state during backoff wait
      ConnectionEvent.Reconnect,
      undefined,
      attempt,
    );

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(hostId);
      try {
        await this.connect(hostId, params);
      } catch {
        // connect() already transitions to Error; the next reconnect will be
        // triggered by the connectionLost monitor or caller.
      }
    }, delay);

    this.reconnectTimers.set(hostId, timer);
  }

  /** Disconnect all hosts. */
  disconnectAll(): void {
    for (const hostId of this.connections.keys()) {
      this.disconnect(hostId);
    }
  }

  /** Clean up all resources. */
  destroy(): void {
    this.disconnectAll();
    this.callbacks.length = 0;
  }

  // -- Private helpers -----------------------------------------------------

  private transition(
    hostId: number,
    newState: ConnectionState,
    event: ConnectionEvent,
    error?: Error,
    attempt?: number,
  ): void {
    const oldState = this.getState(hostId);
    this.states.set(hostId, newState);

    const change: StateChange = {
      hostId,
      oldState,
      newState,
      event,
      error,
      attempt,
    };

    for (const cb of this.callbacks) {
      try {
        cb(change);
      } catch {
        // Swallow callback errors
      }
    }
  }

  private monitorConnection(hostId: number, client: SshClient): void {
    // Poll-based detection: when the client reports disconnected,
    // fire connectionLost.
    // ssh2 fires 'end' and 'close' events, but we already set
    // client._connected = false in those handlers.
    // We use a lightweight interval to detect the state change.
    const checkInterval = setInterval(() => {
      if (!client.connected) {
        clearInterval(checkInterval);

        const current = this.getState(hostId);
        if (current === ConnectionState.Connected) {
          this.transition(
            hostId,
            ConnectionState.Disconnected,
            ConnectionEvent.ConnectionLost,
          );
        }
      }
    }, 1000);
  }

  private clearReconnectTimer(hostId: number): void {
    const timer = this.reconnectTimers.get(hostId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(hostId);
    }
  }
}
