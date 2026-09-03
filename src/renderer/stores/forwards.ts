import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../ipc';
import type { ConnectionId, ForwardSpec } from '../../shared/types';
import type { AutoForwarderStatus, DiscoveredPort } from '../../main/portfwd/AutoForwarder';
import type { ForwardState } from '../../main/portfwd/Forwarder';
import type { PortIntent } from '../../main/portfwd/PortfwdStore';
import type { ServedFolder } from '../../main/portfwd/ServeService';

/**
 * Forwards store: everything the port panel renders for the active connection.
 *
 * Three sources, deliberately kept apart rather than pre-merged here (the
 * panel does the merge, because how a row is composed is a presentation
 * question):
 *
 *  - `states`     — live forwards, auto + manual + ssh-config. Pushed by the
 *                   engine on every scan, so this is the one thing that
 *                   updates without the panel asking.
 *  - `discovered` — every remote port the last scan saw, ANNOTATED: whether we
 *                   forward it, its local port, intent, name, auto-eligibility
 *                   and last error. This is the only way ports above
 *                   `maxAutoPort` reach the UI at all.
 *  - `status`     — scan health, so a failing scan is a visible banner rather
 *                   than a table that silently stops changing.
 *
 * `discovered` is empty whenever no auto-forwarder is running for the
 * connection, which is the normal state before the user turns auto on. Rather
 * than showing nothing, {@link sync} falls back to the one-shot `scan` and
 * marks the result {@link annotated}`= false`, so the panel can still list
 * what is listening and be honest that it does not know the policy verdict.
 *
 * A fourth source rides along: `served` — folders the Files tab is serving
 * over HTTP on this host. Those are ORDINARY forwarded ports (the server binds
 * the host's loopback, the scan sees it, the tunnel is a normal `-L`), so they
 * merge into the same rows; what `served` adds is the URL, the folder, and the
 * ability to stop the server rather than merely the tunnel. Without that last
 * part the panel could close a tunnel and leave a python process serving a
 * directory on a live box, which is the exact orphan this feature must not
 * create.
 */
export const useForwardsStore = defineStore('forwards', () => {
  const states = ref<ForwardState[]>([]);
  const discovered = ref<DiscoveredPort[]>([]);
  const status = ref<AutoForwarderStatus | null>(null);
  /** Folders served over HTTP on this host, keyed in the panel by remotePort. */
  const served = ref<ServedFolder[]>([]);
  /** False when `discovered` came from the raw scan fallback (see above). */
  const annotated = ref(false);
  const autoOn = ref(false);
  const loading = ref(false);
  const error = ref<string | null>(null);
  /** Remote port with an action in flight, so its row can disable itself. */
  const pending = ref<number | null>(null);

  let unsub: (() => void) | null = null;
  let unsubServed: (() => void) | null = null;

  function subscribe(connectionId: ConnectionId): void {
    if (unsub) unsub();
    unsub = api.forwards.onStates(({ connectionId: id, states: s }) => {
      if (id !== connectionId) return;
      states.value = s;
      // The engine pushes states on every scan pass; the annotations and the
      // scan health change on exactly the same beat, so pull them here rather
      // than making the panel poll on a second, unrelated timer.
      void sync(connectionId, { quiet: true });
    });
    if (unsubServed) unsubServed();
    // Pushed, not polled, for one reason that matters: this is how the panel
    // learns a served folder's server DIED. A row that goes on claiming a URL
    // after the process behind it is gone is the failure this app keeps
    // hitting, and a poll would leave it on screen until the next tick.
    unsubServed = api.serve.onChanged(({ connectionId: id, served: s }) => {
      if (id !== connectionId) return;
      served.value = s;
    });
  }

  /**
   * Re-read everything the panel shows. `quiet` skips the spinner — the
   * push-driven refresh must not make the Scan button flicker every 5s.
   */
  async function sync(connectionId: ConnectionId, options: { quiet?: boolean } = {}): Promise<void> {
    if (!options.quiet) loading.value = true;
    try {
      const [live, ports, health, auto, serving] = await Promise.all([
        api.forwards.list(connectionId),
        api.forwards.discovered(connectionId),
        api.forwards.status(connectionId),
        // Re-read rather than trusting the local flag: forcing a single port
        // on lazily starts the whole engine (`ForwardService.ensure`), so the
        // header would otherwise keep saying OFF while the scan loop ran.
        api.forwards.isAutoEnabled(connectionId),
        // Cheap: a main-process map read, no host round trip. Pulled on the
        // same beat so a served row and its forward can never disagree about
        // whether they exist.
        api.serve.list(connectionId),
      ]);
      states.value = live;
      status.value = health;
      autoOn.value = auto;
      served.value = serving;
      if (ports.length > 0 || health !== null) {
        discovered.value = ports;
        annotated.value = true;
      } else {
        // No forwarder running: no annotations exist. Fall back to the one-shot
        // scan so the panel still lists what is listening on the host.
        discovered.value = (await api.forwards.scan(connectionId)).map((p) => ({
          ...p,
          forwarded: false,
          localPort: null,
          intent: null,
          name: null,
          eligible: false,
          lastError: null,
        }));
        annotated.value = false;
      }
      error.value = null;
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      if (!options.quiet) loading.value = false;
    }
  }

  /**
   * Bring the panel up for a connection: restore the host's remembered
   * auto-forward setting (starting the engine again when it was left on) and
   * take a first reading.
   *
   * `configForwards` is `HostEntry.localForwards` — the host's `~/.ssh/config`
   * `LocalForward` lines. PocketShell IS the SSH client here, so nothing else
   * opens them; the engine does, tagged `origin: 'ssh-config'`.
   */
  async function init(
    connectionId: ConnectionId,
    configForwards: ForwardSpec[] = [],
  ): Promise<void> {
    try {
      autoOn.value = await api.forwards.isAutoEnabled(connectionId);
      if (autoOn.value) await api.forwards.startAuto(connectionId, configForwards);
      await sync(connectionId);
    } catch (e) {
      // The panel calls this from `onMounted`; a rejection here used to be an
      // unhandled rejection paging the diag banner while the panel rendered as
      // if nothing had been asked of it. Route it into the panel's error slot.
      error.value = (e as Error).message;
    }
  }

  /**
   * The Scan button. `refresh` runs one policy-APPLYING pass (it opens and
   * closes forwards), which is what a user pressing Scan means; the plain
   * `scan` verb only lists and is the fallback inside {@link sync}.
   */
  async function scan(connectionId: ConnectionId): Promise<void> {
    loading.value = true;
    try {
      await api.forwards.refresh(connectionId);
      await sync(connectionId, { quiet: true });
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function toggleAuto(
    connectionId: ConnectionId,
    configForwards: ForwardSpec[] = [],
  ): Promise<void> {
    try {
      if (autoOn.value) {
        await api.forwards.stopAuto(connectionId);
        autoOn.value = false;
      } else {
        await api.forwards.startAuto(connectionId, configForwards);
        autoOn.value = true;
      }
      await sync(connectionId);
    } catch (e) {
      // `autoOn` is only flipped after the engine agreed, so a rejection
      // leaves it truthfully on the old side — the toggle reads as a no-op
      // unless the failure is shown. This is the template's click handler; an
      // escape here would otherwise be a silent one.
      error.value = (e as Error).message;
    }
  }

  async function addManual(connectionId: ConnectionId, spec: ForwardSpec): Promise<boolean> {
    try {
      const ok = await api.forwards.addManual(connectionId, spec);
      await sync(connectionId);
      return ok;
    } catch (e) {
      // The add form folds on `true`, so a rejection reports as `false`: the
      // form stays up over the error instead of the rejection vanishing into
      // an unhandled promise.
      error.value = (e as Error).message;
      return false;
    }
  }

  /**
   * Remove by `ForwardState.key`. Always the key the engine issued — the panel
   * used to rebuild the string itself in a format the auto path did not use,
   * which is precisely why auto-created forwards could not be removed.
   */
  async function remove(connectionId: ConnectionId, key: string): Promise<void> {
    try {
      await api.forwards.remove(connectionId, key);
      await sync(connectionId);
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  /** Set or clear a remote port's friendly name. Blank deletes it. */
  async function rename(
    connectionId: ConnectionId,
    remotePort: number,
    name: string | null,
  ): Promise<void> {
    await run(connectionId, remotePort, () =>
      api.forwards.setName(connectionId, remotePort, name && name.trim() ? name.trim() : null),
    );
  }

  /** Pin a remote port to a local port. */
  async function remap(
    connectionId: ConnectionId,
    remotePort: number,
    localPort: number,
  ): Promise<void> {
    await run(connectionId, remotePort, () =>
      api.forwards.setRemap(connectionId, remotePort, localPort),
    );
  }

  /** Drop the pin, returning the port to mirror-then-allocate resolution. */
  async function clearRemap(connectionId: ConnectionId, remotePort: number): Promise<void> {
    await run(connectionId, remotePort, () => api.forwards.clearRemap(connectionId, remotePort));
  }

  /** Force a port on, off, or (null) back to the automatic policy. */
  async function setIntent(
    connectionId: ConnectionId,
    remotePort: number,
    intent: PortIntent | null,
  ): Promise<void> {
    await run(connectionId, remotePort, () =>
      api.forwards.setIntent(connectionId, remotePort, intent),
    );
  }

  /** Flip a remote port between forwarded and silenced. */
  async function togglePort(connectionId: ConnectionId, remotePort: number): Promise<void> {
    await run(connectionId, remotePort, () => api.forwards.togglePort(connectionId, remotePort));
  }

  /**
   * Stop a served folder.
   *
   * Deliberately NOT `remove(key)`. Removing the row would close the tunnel
   * and leave the `http.server` process running on the host, still serving the
   * directory, with nothing in the app that knows about it — an orphan on
   * someone's production box. `serve.stop` kills the server first and takes
   * the tunnel down after, in that order.
   */
  async function stopServe(connectionId: ConnectionId, remotePort: number): Promise<void> {
    await run(connectionId, remotePort, () => api.serve.stop(connectionId, remotePort));
  }

  /** The served folder occupying a remote port, if any. */
  function servedOn(remotePort: number): ServedFolder | null {
    return served.value.find((s) => s.remotePort === remotePort) ?? null;
  }

  /** Mark a row busy, run its mutation, then re-read. */
  async function run(
    connectionId: ConnectionId,
    remotePort: number,
    action: () => Promise<unknown>,
  ): Promise<void> {
    pending.value = remotePort;
    try {
      await action();
      await sync(connectionId, { quiet: true });
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      pending.value = null;
    }
  }

  function clear(): void {
    if (unsub) {
      unsub();
      unsub = null;
    }
    if (unsubServed) {
      unsubServed();
      unsubServed = null;
    }
    states.value = [];
    discovered.value = [];
    // Only the panel's VIEW of the served folders is dropped. The servers
    // themselves keep running (they belong to the connection, not to this
    // panel being mounted) and reappear on the next `sync`.
    served.value = [];
    status.value = null;
    annotated.value = false;
    autoOn.value = false;
    pending.value = null;
    error.value = null;
  }

  return {
    states,
    discovered,
    served,
    servedOn,
    stopServe,
    status,
    annotated,
    autoOn,
    loading,
    error,
    pending,
    subscribe,
    init,
    sync,
    scan,
    toggleAuto,
    addManual,
    remove,
    rename,
    remap,
    clearRemap,
    setIntent,
    togglePort,
    clear,
  };
});
