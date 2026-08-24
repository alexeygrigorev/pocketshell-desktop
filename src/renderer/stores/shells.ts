import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { ShellId } from '../../shared/types';

/**
 * Shell registry: which live PTY belongs to which session.
 *
 * WHY THIS EXISTS
 * ---------------
 * `shellId` used to be a module-local `let` inside TerminalView.vue — never
 * returned, never exposed — so nothing outside that component could write to
 * the pane. The prompt composer has to (docs/COMPOSER.md §25.2), and so will
 * any future surface that pushes text at a session.
 *
 * WHY A REGISTRY AND NOT FULL SHELL OWNERSHIP
 * -------------------------------------------
 * The spec offers two fixes: `defineExpose({ shellId })`, or moving shell
 * ownership into a store. This takes the store, because the composer, the
 * terminal and the workspace all need to address the same shell and a template
 * ref only solves it for whoever holds the ref. But it deliberately stops at a
 * REGISTRY: TerminalView still opens, re-opens and closes its own PTY.
 *
 * Moving `open`/`close` out of the component would mean re-sequencing the code
 * that binds xterm's `onData`/`onResize` — and that sequencing is exactly what
 * the just-landed listener-leak fix pins (handlers bound once per terminal
 * lifetime, reading `shellId` from the closure; the e2e regression test in
 * tests/e2e/session-nav.spec.ts asserts no duplicated `0;276;0c` device-attribute
 * replies after repeated session switches). A registry gets the composer what
 * it needs while leaving that code path untouched.
 *
 * The map is keyed by the same session key TerminalView takes as a prop, and is
 * reactive, because TerminalView re-opens its shell whenever that key changes
 * (§25.2) — a consumer that captured the id once would end up writing to a
 * closed channel.
 */
export const useShellsStore = defineStore('shells', () => {
  /** sessionKey -> the ShellId currently attached to it. */
  const byKey = ref<Record<string, ShellId>>({});

  function register(key: string, shellId: ShellId): void {
    if (!key) return;
    byKey.value = { ...byKey.value, [key]: shellId };
  }

  /** Drop a key's shell. A no-op when `shellId` is no longer the current one. */
  function unregister(key: string, shellId?: ShellId): void {
    if (!key) return;
    const current = byKey.value[key];
    if (current === undefined) return;
    if (shellId !== undefined && current !== shellId) return;
    const next = { ...byKey.value };
    delete next[key];
    byKey.value = next;
  }

  function shellIdFor(key: string): ShellId | null {
    return byKey.value[key] ?? null;
  }

  function clear(): void {
    byKey.value = {};
  }

  return { byKey, register, unregister, shellIdFor, clear };
});
