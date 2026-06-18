import type { SshService } from '../ssh/SshService.js';
import type { ConnectionRegistry } from '../ssh/ConnectionRegistry.js';
import type { ConnectOptions } from '../ssh/SshService.js';
import { AutoForwarder, type AutoForwardConfig, type ForwardState } from './AutoForwarder.js';

/**
 * Owns an AutoForwarder across transport drops. When the underlying SSH
 * connection is lost, the supervisor reconnects (exponential backoff
 * 5s->60s, capped) and lets the new forwarder's scan loop rediscover and
 * re-open forwards based on still-listening remote ports — matching the
 * Android AutoForwarderSupervisor contract.
 *
 * Manual toggles persist within a session via the supervisor's remap config.
 */
export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'lost';

export interface SupervisorEvents {
  state: (s: ConnectionState) => void;
  forwards: (states: ForwardState[]) => void;
  error: (message: string) => void;
}

const INITIAL_DELAY_MS = 5_000;
const MAX_DELAY_MS = 60_000;
const MAX_ATTEMPTS = 10;

export class AutoForwarderSupervisor {
  private state: ConnectionState = 'idle';
  private attempt = 0;
  private forwarder: AutoForwarder | null = null;
  private connectionId: string | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ssh: SshService,
    private readonly registry: ConnectionRegistry,
    private readonly connectOpts: ConnectOptions,
    private readonly config: AutoForwardConfig,
    private readonly remappings: Record<number, number>,
    private readonly handlers: {
      onState?: (s: ConnectionState) => void;
      onForwards?: (states: ForwardState[]) => void;
      onError?: (message: string) => void;
    } = {},
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connectAndRun();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.forwarder) {
      this.forwarder.stop();
      this.forwarder = null;
    }
    if (this.connectionId) {
      this.ssh.close(this.connectionId);
      this.connectionId = null;
    }
    this.setState('idle');
  }

  /** Force an immediate reconnect (wakes the backoff sleep). */
  async reconnectNow(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connectionId) {
      this.ssh.close(this.connectionId);
      this.connectionId = null;
    }
    if (this.forwarder) {
      this.forwarder.stop();
      this.forwarder = null;
    }
    await this.connectAndRun();
  }

  getForwarder(): AutoForwarder | null {
    return this.forwarder;
  }

  private async connectAndRun(): Promise<void> {
    if (this.stopped) return;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const result = await this.ssh.connect(this.connectOpts);
    if (!result.ok || !result.connectionId) {
      this.attempt++;
      if (this.attempt > MAX_ATTEMPTS) {
        this.setState('lost');
        this.handlers.onError?.(result.error ?? 'connection lost');
        return;
      }
      const delay = Math.min(INITIAL_DELAY_MS * 2 ** (this.attempt - 1), MAX_DELAY_MS);
      this.reconnectTimer = setTimeout(() => void this.connectAndRun(), delay);
      return;
    }
    this.connectionId = result.connectionId;
    this.attempt = 0;
    this.setState('connected');
    this.forwarder = new AutoForwarder(this.ssh, this.connectionId, this.registry, this.config, this.remappings);
    this.forwarder.onStates((states) => this.handlers.onForwards?.(states));
    this.forwarder.start();
  }

  private setState(s: ConnectionState): void {
    this.state = s;
    this.handlers.onState?.(s);
  }
}
