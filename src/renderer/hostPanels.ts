/**
 * The host-scoped overlay destinations, named once.
 *
 * Ports, Usage and Settings are reachable from two surfaces that must never
 * disagree — the session panel's header and the collapsed rail — and their
 * open/closed state lives in a third place, `HostWorkspaceView`'s `panel` ref.
 * Three files, one vocabulary.
 *
 * How they are reached differs by one control, and deliberately: Ports and
 * Usage sit inside the overflow menu (components/HostActionsMenu.vue), Settings
 * has its own gear on both surfaces. See {@link HOST_PANEL_ITEMS}.
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
}

/**
 * What the OVERFLOW MENU holds: the two host overlays, and only those.
 *
 * `settings` is still a `HostPanel` — the workspace opens the same overlay —
 * but it is no longer a menu ROW. The user asked for the strip to read
 * `⋯ · refresh · settings · hide`, which pulls the gear back out as its own
 * control, and that is affordable in a way Ports and Usage are not: the gear is
 * icon-only everywhere else in this app, so it needs no label and costs one
 * 14px slot. "Ports" and "Usage" as bare glyphs is exactly the memory test
 * commit ca79ae2 refused, and they stay here where they keep their WORDS.
 *
 * Those words are the full phrases rather than the one-word captions the
 * retired foot row used. A menu row has horizontal space a 200px panel strip
 * does not, and "Port forwarding" says what the overlay contains where "Ports"
 * only hints at it.
 *
 * The `appLevel` flag went with the gear. It existed to draw a rule between the
 * host-level pair and the app-level entry, and with the app-level entry gone
 * from this list there is nothing left to separate — a rule under a two-item
 * menu would divide it from nothing.
 *
 * NOTE for whoever adds the next host overlay: both triggers of this menu are
 * still the collapsed rail's only route to what is in it, so an item added here
 * is reachable from both states for free. A control promoted OUT of here, as
 * the gear just was, has to be added to the rail by hand or the collapsed panel
 * quietly offers less than the expanded one.
 */
export const HOST_PANEL_ITEMS: readonly HostPanelItem[] = [
  { panel: 'ports', label: 'Port forwarding' },
  { panel: 'usage', label: 'Provider usage' },
];
