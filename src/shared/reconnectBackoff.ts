/**
 * Reconnect backoff timing, shared by main and renderer.
 *
 * This module previously lived in `main/portfwd/AutoForwarderSupervisor.ts`,
 * which itself previously held a supervisor that called `ssh.connect()` on a
 * second connection of its own. That contradicted the single-connection
 * decision this app is built on — one auth, one keepalive, one TOFU prompt,
 * one reconnect FSM per host — and it was never wired to anything, so the
 * supervisor was cut and the schedule survived. The schedule now lives here
 * because its real consumer is the RENDERER's connection store, whose
 * automatic reconnect loop (stores/connection.ts) ticks this curve after a
 * transport drop; main-process code importing a `shared/` module is free, and
 * the port panel's status row reads the same constants.
 *
 * The Python has two contradictory implementations of it — the CLI does
 * 5 -> 10 -> 20 -> 40 -> 60s exponential and retries forever
 * (`forwarder.py:1141`), while the TUI does a flat 5s countdown with no
 * backoff at all (`dashboard.py:1036-1038`), hammering a down host every 5
 * seconds. We keep the CLI's exponential curve and, unlike either, stop after
 * `maxAttempts` so a permanently dead host does not spin forever.
 *
 * This is a pure value object: no timers, no I/O, no SSH. The countdown
 * itself belongs in the renderer, which is handed `retryAtEpochMs` and ticks
 * the number down.
 */

export const INITIAL_DELAY_MS = 5_000;
export const MAX_DELAY_MS = 60_000;
export const MAX_ATTEMPTS = 10;

export interface ReconnectBackoffOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
}

/** One scheduled retry, or `null` when the budget is spent. */
export interface RetryPlan {
  /** 1-based attempt number this plan describes. */
  attempt: number;
  /** Milliseconds to wait before attempting. */
  delayMs: number;
  /** Absolute time to retry, for a renderer-side countdown. */
  retryAtEpochMs: number;
}

export class ReconnectBackoff {
  private attempt = 0;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxAttempts: number;

  constructor(options: ReconnectBackoffOptions = {}) {
    this.initialDelayMs = options.initialDelayMs ?? INITIAL_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? MAX_DELAY_MS;
    this.maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  }

  /** Attempts consumed so far. */
  get attempts(): number {
    return this.attempt;
  }

  /** True once the retry budget is spent — the caller should go to 'lost'. */
  get exhausted(): boolean {
    return this.attempt >= this.maxAttempts;
  }

  /**
   * Consume one attempt and describe when to retry, or null when the budget
   * is spent. Delays double from `initialDelayMs`, capped at `maxDelayMs`:
   * 5, 10, 20, 40, 60, 60, ... seconds.
   */
  next(now: number = Date.now()): RetryPlan | null {
    if (this.exhausted) return null;
    this.attempt += 1;
    const delayMs = Math.min(this.initialDelayMs * 2 ** (this.attempt - 1), this.maxDelayMs);
    return { attempt: this.attempt, delayMs, retryAtEpochMs: now + delayMs };
  }

  /** Call on a successful connect: the next failure starts at the bottom. */
  reset(): void {
    this.attempt = 0;
  }
}
