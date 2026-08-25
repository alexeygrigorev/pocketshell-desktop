import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../ipc';
import type { ConnectionId } from '../../shared/types';
import type { UsageRow } from '../../main/helper/parsers';
import { parseProfileRows, type AgentProfile } from '../../shared/agentLaunch';

/**
 * Agents store: the provider-usage dashboard rows, and nothing else.
 *
 * It used to also hold the CONVERSATION of the selected session — messages,
 * the transcript the messages came from, and a stale-reply guard keyed on the
 * session name. That whole half is gone, with the feature (docs/WORKSPACE.md
 * §9): the user asked for conversations to be dropped completely, so the tab,
 * the transcript resolver, the `agent-log` client and the IPC behind them were
 * removed rather than left as an unused path (docs/ANALYSIS.md D22).
 *
 * `loading` survived that cut and is worth a note, because it is the one thing
 * the removal could have broken silently. It was written ONLY by the
 * conversation loader, but it is READ by the usage refresh button in
 * UsageView.vue and HostWorkspaceView.vue — so deleting the writer would have
 * left a spinner that never spins and a button that is never disabled, with
 * nothing to say why. `loadUsage` owns it now.
 */
export const useAgentsStore = defineStore('agents', () => {
  const usage = ref<UsageRow[]>([]);
  /** True while `loadUsage` is in flight — drives the refresh spinner. */
  const loading = ref(false);

  async function loadUsage(connectionId: ConnectionId): Promise<void> {
    loading.value = true;
    try {
      usage.value = await api.helper.usage(connectionId);
    } finally {
      loading.value = false;
    }
  }

  /**
   * The host's agent profiles, for the launch dialog's profile picker.
   *
   * Profiles are defined ONCE on the host (the helper auto-discovers `~/.claude`,
   * `~/.zlaude`, `~/.codex` and reads an optional `profiles.yaml`), which is why
   * the client fetches them instead of storing them per-host — the same reason
   * the phone's `ProfilesGateway` exists. `agent:profiles` has been wired end to
   * end since 88cc932 fixed the `{"profiles": […]}` envelope, but nothing in the
   * renderer called it until the launch dialog did.
   */
  const profiles = ref<AgentProfile[]>([]);
  /** True while `loadProfiles` is in flight. */
  const profilesLoading = ref(false);
  /**
   * Set when the fetch itself failed, distinguishing "this host has no profiles"
   * from "we could not ask".
   *
   * The phone collapses both to an empty list and shows nothing — a host with no
   * CLI, a failing probe and a host with one profile all look identical there.
   * The desktop keeps them apart because it has the room to: an empty list is a
   * normal state the dialog explains in a line, whereas a failed fetch is worth
   * saying out loud so the user knows the picker is missing options rather than
   * that the host has none. Neither blocks the launch — a profile is optional,
   * and the engine default is exactly what omitting `--profile` selects.
   */
  const profilesError = ref<string | null>(null);
  /**
   * Which connection `profiles` describes, so a stale response from the host we
   * just left cannot overwrite the one we are on (the phone guards the same race
   * with a generation counter plus an `isCurrentHost` check).
   */
  let profilesFor: ConnectionId | null = null;

  async function loadProfiles(connectionId: ConnectionId): Promise<void> {
    profilesLoading.value = true;
    profilesError.value = null;
    profilesFor = connectionId;
    try {
      const rows = await api.agent.profiles(connectionId);
      if (profilesFor !== connectionId) return;
      profiles.value = parseProfileRows(rows);
    } catch (e) {
      if (profilesFor !== connectionId) return;
      profiles.value = [];
      profilesError.value = (e as Error).message || 'Could not list this host’s agent profiles.';
    } finally {
      if (profilesFor === connectionId) profilesLoading.value = false;
    }
  }

  return { usage, loading, loadUsage, profiles, profilesLoading, profilesError, loadProfiles };
});
