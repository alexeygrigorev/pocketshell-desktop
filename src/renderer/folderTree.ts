/**
 * The session panel's tree, derived once and read by everything that needs it.
 *
 * `SessionTree.vue` computed this privately, and that was fine while it was the
 * only reader. It is not any more: `Ctrl+↑` / `Ctrl+↓` move to the previous or
 * next FOLDER WORKSPACE, and the chord is owned by `HostWorkspaceView` because
 * that is where the route lives — so two components now need the same list, in
 * the same order, keyed the same way.
 *
 * Deriving it twice would be the exact failure this codebase has already paid
 * for once. `$HOME` decides whether a folder is keyed `~/git/foo` or
 * `/home/me/git/foo`, and two spellings of one key is a panel row that opens a
 * workspace with no tabs in it — the bug `sessionGrouping`'s `rootHostPath`
 * exists to prevent on the other side of the same conversion. A chord that
 * navigated by a key the panel spells differently would put the user in an
 * empty workspace and highlight no row, which reads as the folder having
 * vanished.
 *
 * So the derivation moves HERE, and both call sites read it. Everything in it
 * is the code that used to sit in `SessionTree`, unchanged in behaviour: the
 * store reads are the same, the `$HOME` fallback is the same, and
 * `groupSessionsIntoRoots` is the same pure function it always was.
 */
import { computed, type ComputedRef } from 'vue';
import {
  groupSessionsIntoRoots,
  inferHome,
  type SessionDirectory,
  type SessionRootFolder,
} from './sessionGrouping';
import { useProjectsStore } from './stores/projects';
import { useSessionsStore } from './stores/sessions';
import { useSettingsStore } from './stores/settings';

export interface FolderTree {
  /**
   * The host's `$HOME`, resolved or inferred. Null only when it could not be
   * had either way, which is the case the panel's `+` renders disabled for.
   */
  home: ComputedRef<string | null>;
  /** Root sections, in panel order. */
  roots: ComputedRef<SessionRootFolder[]>;
  /**
   * Every folder row, flattened in the order they are drawn — root by root,
   * folders inside each. This is the list an arrow key walks, and it is
   * flattened rather than nested because a `Ctrl+↓` at the last folder of `git`
   * means the first folder of the next root: the user is stepping down the
   * PANEL, and the root headers they pass are not stops, they are labels.
   */
  folders: ComputedRef<SessionDirectory[]>;
}

export function useFolderTree(): FolderTree {
  const projects = useProjectsStore();
  const sessions = useSessionsStore();
  const settings = useSettingsStore();

  /**
   * Read from the projects store, with an inference from the session paths as
   * the fallback so a host whose `$HOME` never resolved still groups instead of
   * dropping every session into `other`. `groupSessionsIntoRoots` infers on its
   * own when handed null, so passing an already-inferred home through it is
   * idempotent — this widens where the answer is visible, it does not change it.
   */
  const home = computed(() => projects.home ?? inferHome(sessions.sessions.map((s) => s.path)));

  const roots = computed(() =>
    groupSessionsIntoRoots(sessions.sessions, home.value, settings.sessionRoots),
  );

  const folders = computed(() => roots.value.flatMap((root) => root.directories));

  return { home, roots, folders };
}
