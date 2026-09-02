import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
import { api } from '../ipc';
import type {
  BootstrapResult,
  ConnectionId,
  ConnectionState,
  HostEntry,
} from '../../shared/types';
import { MAX_ATTEMPTS, ReconnectBackoff } from '../../shared/reconnectBackoff';
import { useFilesStore } from './files';
import { useSessionsStore } from './sessions';
import { useProjectsStore } from './projects';

/**
 * Connection store: owns the active connection to a host and its bootstrap
 * result. View state only — no keys or ssh2 objects ever live here.
 *
 * ## The automatic reconnect FSM
 *
 * A transport drop used to dead-end in this store: `state` flipped to 'lost'
 * and the user was handed a button. The store now answers the drop itself,
 * with the schedule the port-forward work already chose (shared/
 * reconnectBackoff.ts — 5→10→20→40→60s, capped at MAX_ATTEMPTS so a host that
 * is actually gone is not hammered forever). The FSM lives HERE, not in main,
 * for the same reason the old supervisor was cut: this app keeps ONE dialler
 * per connection, and everything a reconnect has to revive — bootstrap,
 * session list, forwards — is already orchestrated from this file's
 * `connect()`. Main only reports the drop; it never redials.
 *
 * Countdown state (`autoRetry`, `retryIn`) is what the lost-link banner
 * renders; `retryNow()` lets the user skip the wait. A manual `reconnect()`
 * supersedes a pending schedule without discarding its attempt budget, and an
 * explicit `disconnect()` cancels the whole thing — nobody wants the app
 * re-dialling a host they just left.
 */
export const useConnectionStore = defineStore('connection', () => {
  const hosts = ref<HostEntry[]>([]);
  const connectionId = ref<ConnectionId | null>(null);
  const state = ref<ConnectionState>('idle');
  const error = ref<string | null>(null);
  const bootstrap = ref<BootstrapResult | null>(null);
  /** The host we are currently connected to (for the workspace header). */
  const activeHost = shallowRef<HostEntry | null>(null);

  /**
   * The key last used to dial {@link activeHost}, kept so a dropped link can be
   * re-dialled without asking the user to re-pick it.
   */
  const lastKeyPath = ref<string | undefined>(undefined);

  /** The pending automatic retry, or null when no FSM is mid-recovery. */
  const autoRetry = ref<{ attempt: number; retryAt: number } | null>(null);
  /** Seconds until the pending retry fires — the banner's countdown. */
  const retryIn = ref(0);
  /**
   * True from the drop until recovery lands (or is cancelled). The banner
   * reads this so it does not blink off during each dial: state sits at
   * 'connecting' while a scheduled retry is on the wire, and a strip gated on
   * `state === 'lost'` alone would disappear exactly when it says
   * "Reconnecting…".
   */
  const recovering = ref(false);

  let backoff: ReconnectBackoff | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Bumped on every cancellation, so a dial that was already in flight when
   * the user disconnected (or hit Retry now) cannot finish into state that no
   * longer wants it — the same generation guard the auto-connect latch uses.
   */
  let generation = 0;

  /**
   * Learn when the transport drops.
   *
   * The main process has always emitted this (ipc.ts, `ssh:event:state`) and
   * the preload has always bridged it, but nothing in the renderer subscribed —
   * so a link that died left the store reporting `connected` with a
   * connectionId whose record main had already torn down. Every subsequent call
   * on it failed, and the two surfaces that matter both failed silently: the
   * terminal pane stayed blank and the Files tab rendered an empty directory.
   * The only cure was a manual disconnect/reconnect, which is exactly the
   * symptom that says the UI never learned.
   *
   * `connectionId` is deliberately NOT cleared here. It gates `v-if` on the
   * terminal and Files panes, so nulling it would unmount them and throw away
   * the user's scrollback at the precise moment they want to read it. The
   * state flag is enough for the UI to say the link is gone; calls made
   * against the dead id now report their own failure rather than vanishing.
   *
   * Since F12 the drop also STARTS something: the automatic reconnect below.
   *
   * Subscribed for the store's lifetime — a Pinia setup store is created once,
   * and this must outlive any individual view.
   */
  api.ssh.onState((payload) => {
    if (payload.connectionId !== connectionId.value) return;
    state.value = payload.state;
    if (payload.state === 'lost') {
      error.value = 'Connection lost';
      startAutoReconnect();
    }
  });

  // Sleep/wake (F12). A machine that slept is the classic SILENT drop: the
  // peer is gone (NAT entry expired, network changed) but the local TCP stack
  // will not say so until a write fails, and ssh2's keepalive can sit on that
  // for ~45s of silence. Main announces the resume — the SUBSCRIPTION lives
  // in renderer/main.ts, not here, so a component test that creates this
  // store under a partial ipc mock (they all do) is not required to provide
  // the channel. This action answers the announcement with a one-byte probe —
  // `true` is the cheapest thing a shell executes — and a probe that does not
  // exit 0 is treated as the drop it almost always is. Main's own keepalive
  // will confirm shortly after; `startAutoReconnect` is idempotent, so
  // whichever notice lands first wins.
  async function onOsResume(): Promise<void> {
    if (state.value !== 'connected' || !connectionId.value) return;
    const probe = await api.ssh.exec(connectionId.value, 'true').catch(() => null);
    if (probe && probe.exitCode === 0) return;
    if (state.value !== 'connected') return; // main's event beat us to it
    state.value = 'lost';
    error.value = 'Connection lost';
    startAutoReconnect();
    // No reason to make the user wait out the first 5s: the resume IS the
    // likely recovery moment (laptop opened, network back), so dial now.
    await retryNow();
  }

  /**
   * Begin the automatic recovery: fresh curve, first retry in 5s.
   *
   * Idempotent — main's keepalive and the wake probe can both report the same
   * dead link, and only one loop may own the schedule.
   */
  function startAutoReconnect(): void {
    if (backoff || !activeHost.value) return;
    backoff = new ReconnectBackoff();
    recovering.value = true;
    const gen = ++generation;
    scheduleRetry(gen);
  }

  /** Wait out the next step of the curve, then dial. */
  function scheduleRetry(gen: number): void {
    const plan = backoff?.next();
    if (!plan) {
      giveUp(gen);
      return;
    }
    autoRetry.value = { attempt: plan.attempt, retryAt: plan.retryAtEpochMs };
    startCountdown(plan.retryAtEpochMs);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      stopCountdown();
      autoRetry.value = null;
      void dialRecovered(gen);
    }, plan.delayMs);
  }

  /** One dial inside the recovery loop. */
  async function dialRecovered(gen: number): Promise<void> {
    if (gen !== generation || !activeHost.value) return;
    const ok = await reconnect();
    if (gen !== generation) return;
    if (!ok) {
      // connect() lands a failed dial on 'idle' — the same value a fresh app
      // has. The link is still gone, so put the state back where the banner
      // and the next curve step expect it, and wait again.
      state.value = 'lost';
      scheduleRetry(gen);
    }
  }

  /**
   * The budget is spent: stop dialling and say so. The state stays 'lost' so
   * the banner keeps standing — recovery is still available, but now it is the
   * user's button, not a timer.
   */
  function giveUp(gen: number): void {
    if (gen !== generation) return;
    backoff = null;
    autoRetry.value = null;
    recovering.value = false;
    stopCountdown();
    state.value = 'lost';
    error.value = `Could not reconnect after ${MAX_ATTEMPTS} attempts.`;
  }

  /** Stop the countdown ticker; safe to call when it is not running. */
  function stopCountdown(): void {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    retryIn.value = 0;
  }

  function startCountdown(retryAt: number): void {
    stopCountdown();
    const tick = (): void => {
      retryIn.value = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  /**
   * Tear down the automatic schedule — a user disconnect means it. The
   * generation bump also orphanes a dial already on the wire, whose success
   * would otherwise revive a connection the user just closed.
   */
  function cancelAutoReconnect(): void {
    generation += 1;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    stopCountdown();
    backoff = null;
    autoRetry.value = null;
    recovering.value = false;
  }

  /**
   * Skip the wait: dial now, under the running FSM's budget.
   *
   * With no FSM running this is a plain `reconnect()` — the button's old
   * behaviour, which is what the banner falls back to once the budget is
   * spent.
   */
  async function retryNow(): Promise<void> {
    if (!backoff) {
      await reconnect();
      return;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    stopCountdown();
    autoRetry.value = null;
    await dialRecovered(generation);
  }

  async function loadHosts(): Promise<void> {
    hosts.value = await api.ssh.listConfigHosts();
  }

  /**
   * Re-dial the host we were last connected to, after a drop — the one dial
   * both the banner button and the automatic loop go through.
   *
   * On success this also wakes the surfaces that went stale with the dead id
   * ({@link recoverSurfaces}); that recovery belongs HERE, because a reconnect
   * mints a NEW connectionId and everything keyed by the old one needs to
   * re-read against it, no matter which of the two entry points dialled.
   *
   * Returns false when there is nothing to re-dial — this is for recovering a
   * link that died, not for opening the first one.
   */
  async function reconnect(): Promise<boolean> {
    const host = activeHost.value;
    if (!host) return false;
    // A manual dial supersedes a pending automatic one. The backoff keeps its
    // attempt position: a user pressing the button 4s into a 5s wait is saying
    // "now", not "start the curve over" — the schedule only resets on success.
    cancelPendingRetryTimer();
    if (connectionId.value) {
      // Best-effort: main has usually torn the record down already, and a
      // close on an unknown id must not stop the re-dial.
      await api.ssh.close(connectionId.value).catch(() => undefined);
      connectionId.value = null;
    }
    const ok = await connect(host, lastKeyPath.value);
    if (ok && connectionId.value) {
      backoff?.reset();
      backoff = null;
      autoRetry.value = null;
      recovering.value = false;
      stopCountdown();
      await recoverSurfaces(connectionId.value);
    }
    return ok;
  }

  /** Clear a not-yet-fired schedule step. See {@link reconnect}. */
  function cancelPendingRetryTimer(): void {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    stopCountdown();
    autoRetry.value = null;
  }

  /**
   * Re-read everything that was keyed by the dead connection id.
   *
   * The sessions refresh is not a courtesy: the panel's last poll against the
   * old id is what left a raw "Unknown connection" rejection on screen, and
   * refreshing against the new id replaces both the stale list and that
   * message in one move. Forwarding is restored by `connect()` before it
   * exposes the new connection id, so a drop does not silently turn off
   * forwarding for everyone who had it on.
   *
   * Bootstrap needs no line here: `connect()` already fires it in the
   * background, and the UI surfaces the result when it lands.
   */
  async function recoverSurfaces(id: ConnectionId): Promise<void> {
    await useSessionsStore()
      .refresh(id, { quiet: true })
      .catch(() => undefined);
  }

  /**
   * Restore the host's remembered auto-forward setting before a new
   * connection becomes visible to the workspace.
   *
   * The ports overlay used to be the only caller of `forwards.init`, so the
   * header could truthfully read the persisted ON flag while no local tunnel
   * existed. Keep the check here, at the connection boundary: it covers both
   * the first connection after an app restart and a reconnect, without making
   * opening an otherwise unrelated overlay a side effect.
   *
   * Forward specs are copied field by field because a host selected from the
   * Pinia `hosts` ref may be a reactive proxy, which Electron's structured
   * clone cannot carry through `ipcRenderer.invoke`.
   */
  async function restoreAutoForward(id: ConnectionId, host: HostEntry): Promise<void> {
    try {
      if (!(await api.forwards.isAutoEnabled(id))) return;
      const configForwards = host.localForwards.map((forward) => ({
        kind: forward.kind,
        listenHost: forward.listenHost,
        listenPort: forward.listenPort,
        destHost: forward.destHost,
        destPort: forward.destPort,
      }));
      await api.forwards.startAuto(id, configForwards);
    } catch {
      // A successful SSH connection must not be reported as failed because a
      // best-effort forwarding restore could not be queried or started.
    }
  }

  async function connect(host: HostEntry, privateKeyPath?: string): Promise<boolean> {
    // Remote homes and SFTP browser paths belong to the connection, not to the
    // host-picker singleton. Clear them before a new dial so a workspace or
    // dialog cannot briefly render the previous host while this one connects.
    useProjectsStore().clear();
    state.value = 'connecting';
    error.value = null;
    activeHost.value = host;
    lastKeyPath.value = privateKeyPath;
    const result = await api.ssh.connect({
      host: host.hostname,
      port: host.port,
      user: host.user || '',
      privateKeyPath: privateKeyPath ?? host.identityFile ?? undefined,
      tofuDecision: 'accept-always',
    });
    if (result.ok && result.connectionId) {
      // Do this while the picker still owns the connection attempt. Once the
      // new id is exposed, HostWorkspaceView can render the persisted ON
      // indicator knowing the engine has already been asked to resume.
      await restoreAutoForward(result.connectionId, host);
      connectionId.value = result.connectionId;
      state.value = 'connected';
      // Fire bootstrap in the background; the UI surfaces it when it lands.
      void api.helper.bootstrap(result.connectionId).then((b) => {
        bootstrap.value = b;
      });
      return true;
    }
    state.value = 'idle';
    error.value = result.error ?? 'Connection failed';
    return false;
  }

  async function disconnect(): Promise<void> {
    // First, not last: it must also orphan a recovery dial already on the
    // wire, whose success would otherwise undo the disconnect.
    cancelAutoReconnect();
    if (connectionId.value) {
      // Drop this host's browsing state BEFORE the id is forgotten. The files
      // store is a singleton keyed by connection, and this is the guarantee
      // that one host's listing can never be shown for another — the reason
      // `clear()` exists. It used to be triggered by the Files tab
      // unmounting, which fired on every tab switch and cost the user their
      // place; disconnect is the event that actually invalidates the state.
      useFilesStore().clear(connectionId.value);
      useProjectsStore().clear();
      await api.ssh.close(connectionId.value);
    }
    connectionId.value = null;
    state.value = 'idle';
    bootstrap.value = null;
    activeHost.value = null;
    lastKeyPath.value = undefined;
  }

  return {
    hosts,
    connectionId,
    state,
    error,
    bootstrap,
    activeHost,
    autoRetry,
    retryIn,
    recovering,
    loadHosts,
    connect,
    reconnect,
    retryNow,
    onOsResume,
    disconnect,
  };
});
