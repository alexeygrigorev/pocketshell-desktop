<script setup lang="ts">
// SessionRedirectView: what `/host/:name/session/:session` resolves to now that
// a workspace is addressed by FOLDER rather than by session
//
//
// It is a resolver, not a view: it looks the session up, finds the folder that
// holds it, and REPLACES the current history entry with that folder's
// workspace, with the session's tab selected. Nothing of it is ever seen for
// longer than a frame unless the store has to be refreshed first.
//
// ## Why the old route is not simply deleted
//
// Hard cuts, no backwards compatibility — and that
// means the HOST contract: helper spellings, wire formats, fallback ladders,
// the things where carrying two shapes means two things that can silently
// disagree with the server. This is the app's own history stack. A deep link in
// a window a user left open overnight costs nothing to honour and lands them
// where they were going, and there is no second implementation to drift: this
// file resolves onto the one workspace route and has no behaviour of its own.
//
// It is also NOT permanent surface. Nothing in the app produces this route any
// more; only history does, and history is finite.
import { onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useConnectionStore } from '../stores/connection';
import { useProjectsStore } from '../stores/projects';
import { useSessionsStore } from '../stores/sessions';
import { useSettingsStore } from '../stores/settings';
import { groupSessionsIntoRoots } from '../sessionGrouping';

const route = useRoute();
const router = useRouter();
const connection = useConnectionStore();
const projects = useProjectsStore();
const sessions = useSessionsStore();
const settings = useSettingsStore();

/**
 * The folder key holding [sessionName], out of the same grouping the panel
 * renders, using the roots registered for [host].
 *
 * Deriving it from the grouping rather than from the session's raw `path` is
 * what makes the answer agree with the panel in every case the grouping is
 * there for: the home-relative rewrite that folds tmux's two spellings of one
 * directory together, the pseudo-folder an untracked session gets, and the
 * sibling-inferred path.
 */
function folderFor(host: string, sessionName: string): string | null {
  for (const root of groupSessionsIntoRoots(
    sessions.sessions,
    projects.home,
    settings.sessionRootsFor(host),
  )) {
    const dir = root.directories.find((d) =>
      d.rows.some((r) => r.session.name === sessionName),
    );
    if (dir) return dir.key;
  }
  return null;
}

onMounted(async () => {
  const host = route.params['name'] as string;
  const session = String(route.params['session'] ?? '');
  const connectionId = connection.connectionId;

  // The store can be empty on a cold start into this route, and an empty store
  // has no folders to resolve against — so refresh ONCE before giving up. Only
  // once: a session that is genuinely gone must land somewhere rather than
  // retry, and the host's empty state is a truthful answer to "that session no
  // longer exists".
  if (connectionId && !sessions.sessions.length) {
    await sessions.refresh(connectionId);
    await projects.ensureHome(connectionId);
  }

  const folder = session ? folderFor(host, session) : null;
  // `void`: vue-router rejects the returned promise on an aborted or redirected
  // navigation, and neither is an error here.
  if (folder) {
    void router.replace({
      name: 'folder',
      params: { name: host, folder },
      query: { tab: session },
    });
    return;
  }
  void router.replace({ name: 'host-sessions', params: { name: host } });
});
</script>

<template>
  <div class="resolving">
    <p class="muted">opening…</p>
  </div>
</template>

<style scoped>
.resolving {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.muted {
  font-size: var(--fs-300);
}
</style>
