/**
 * The host-scoped overlay destinations, named once.
 *
 * Ports, Usage and Settings are reachable from two triggers that must never
 * disagree — the session panel's header and the collapsed rail (see
 * components/HostActionsMenu.vue) — and their open/closed state lives in a
 * third place, `HostWorkspaceView`'s `panel` ref. Three files, one vocabulary.
 *
 * It is a plain module rather than a type exported from the `.vue` file for a
 * practical reason as well as a tidy one: `env.d.ts` declares every `*.vue` as
 * `DefineComponent<…, any>`, so a named type exported from a component is
 * invisible to the type-aware lint rules and collapses to `any` at the import
 * site. A `.ts` module is seen by everything.
 */

export type HostPanel = 'ports' | 'usage' | 'settings';

export interface HostPanelItem {
  panel: HostPanel;
  label: string;
  /**
   * True for the app-level entry, which is set apart by a rule rather than
   * grouped with the host-level pair. It is the same distinction the retired
   * panel-foot row drew by pushing the gear to the far corner: Ports and Usage
   * are facts about THIS host, Settings is a fact about the app.
   */
  appLevel?: boolean;
}

/**
 * Menu order: the two host overlays, then Settings.
 *
 * The labels are the full phrases rather than the one-word button captions the
 * foot row used (`Ports`, `Usage`). A menu row has horizontal space a 200px
 * panel strip does not, and "Port forwarding" says what the overlay contains
 * where "Ports" only hints at it — which was half of commit ca79ae2's worry
 * about these two controls becoming a memory test.
 */
export const HOST_PANEL_ITEMS: readonly HostPanelItem[] = [
  { panel: 'ports', label: 'Port forwarding' },
  { panel: 'usage', label: 'Provider usage' },
  { panel: 'settings', label: 'Settings', appLevel: true },
];
