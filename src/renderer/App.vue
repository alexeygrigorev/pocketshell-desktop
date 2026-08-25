<script setup lang="ts">
// Root component: just the router-outlet. All views (HostPicker,
// HostWorkspace) are routed. Global theme vars live in <style>.
</script>

<template>
  <router-view />
</template>

<style>
/* ---------------------------------------------------------------------------
 * Design tokens — see docs/DESIGN.md §4.3.
 *
 * Palette is the Android client's (GitHub-dark-derived): #0D1117 ground,
 * #E6EDF3 text, cyan #22D3EE accent. Contrast ratios in the comments are
 * WCAG 2.1 relative-luminance, computed per pair against --bg unless noted.
 *
 * The six original names (--bg --fg --muted --accent --error --border) are
 * still defined, so nothing that predates the token set breaks.
 * ------------------------------------------------------------------------- */
:root {
  color-scheme: dark;

  /* ---- Surfaces (elevation 0 -> 3) ----------------------------------- */
  --bg: #0d1117; /* window / page ground */
  --surface: #161b22; /* topbar, side panel, cards, overlay body */
  --surface-2: #1c2129; /* inputs, chips, table heads, menus */
  --surface-3: #232a34; /* popovers / anything above an overlay */
  --scrim: rgba(1, 4, 9, 0.72); /* modal backdrop */

  /* ---- Text ---------------------------------------------------------- */
  --fg: #e6edf3; /* 16.02:1 on --bg */
  --fg-secondary: #8b949e; /*  6.15:1 — subtitles, timestamps, counts */
  --fg-muted: #6e7681; /*  4.12:1 — >=15px or decorative ONLY */

  /* ---- Lines --------------------------------------------------------- */
  --border: #2d333b; /* default hairline */
  --border-soft: #21262d; /* row separators inside a panel */
  --border-strong: #6e7681; /* 4.12:1 — inputs & controls (WCAG 1.4.11) */

  /* ---- Accent -------------------------------------------------------- */
  --accent: #22d3ee; /* 10.47:1 on --bg */
  --accent-dim: #0891b2; /* accent borders, active separators */
  --accent-soft: rgba(34, 211, 238, 0.12); /* selected row fill */
  --on-accent: #04101a; /* 10.62:1 on --accent */

  /* ---- Status -------------------------------------------------------- */
  --success: #22c55e;
  --warning: #f59e0b;
  --error: #ef4444;
  --agent: #a78bfa; /* agent/assistant role, per Android */
  --success-soft: rgba(34, 197, 94, 0.12);
  --warning-soft: rgba(245, 158, 11, 0.12);
  --error-soft: rgba(239, 68, 68, 0.12);
  --agent-soft: rgba(167, 139, 250, 0.14);

  /* ---- Interaction states -------------------------------------------- */
  /* Neutral lift for hover: tinting every hover with the accent makes hover
     read as selection, which is what the old rgba(137,180,250,.08) did. */
  --state-hover: rgba(230, 237, 243, 0.05);
  --state-active: rgba(230, 237, 243, 0.09);
  --state-selected: var(--accent-soft);
  --focus-ring: var(--accent);
  --focus-ring-width: 2px;
  --focus-ring-offset: 2px;
  --disabled-opacity: 0.45;

  /* ---- Terminal (see docs/DESIGN.md §3 — Windows Terminal / Campbell) -- */
  --term-bg: #0c0c0c;
  --term-fg: #cccccc;
  --term-font-size: 16px;
  --term-padding: 8px;

  /* ---- Code (file editor syntax colours) ------------------------------
   * Derived from Campbell (§3), because the Files tab's editor sits on
   * `--term-bg` for the reason FilesView already states: an open file and the
   * shell it came from should read as the same surface. A stock editor theme
   * dropped onto that ground would be the only thing in the app not speaking
   * the terminal's palette.
   *
   * Ratios are against `--term-bg` #0C0C0C, computed the same way as §3.3's
   * audit. Two roles deliberately step OUTSIDE Campbell, both for the reason
   * §3.3 already identified — the scheme's dim pairs are unreadable on its own
   * background — and both handled here the way `minimumContrastRatio: 3`
   * handles them in the terminal: lift only the failing pair, leave the rest
   * pixel-identical.
   *   - comment: Campbell brightBlack #767676 is 4.31:1, and §4.3 reserves
   *     that band for >=15px or decorative text. Comments are 13px prose and
   *     are read, so they take `--fg-secondary`'s value (6.36:1) instead.
   *   - meta: Campbell magenta/brightMagenta are 2.44:1 / 3.20:1 — the exact
   *     pair §3.3 calls "genuinely unreadable". Decorators, preprocessor lines
   *     and doctypes take the app's own `--agent` violet (7.19:1).
   */
  --code-comment: #8b949e; /*  6.36:1 — lifted, see above */
  --code-keyword: #3b78ff; /*  4.95:1 — Campbell brightBlue */
  --code-string: #c19c00; /*  7.47:1 — Campbell yellow */
  --code-number: #16c60c; /*  8.49:1 — Campbell brightGreen */
  --code-function: #f9f1a5; /* 16.91:1 — Campbell brightYellow */
  --code-type: #61d6d6; /* 11.27:1 — Campbell brightCyan */
  --code-variable: #cccccc; /* 12.18:1 — Campbell foreground */
  --code-tag: #3a96dd; /*  6.14:1 — Campbell cyan */
  --code-attribute: #61d6d6; /* 11.27:1 — Campbell brightCyan */
  --code-punctuation: #8b949e; /*  6.36:1 — brackets, dimmed a step */
  --code-meta: #a78bfa; /*  7.19:1 — substituted, see above */
  --code-invalid: #e74856; /*  5.09:1 — Campbell brightRed */
  --code-link: #22d3ee; /* 10.82:1 — the app accent, so links read as links */
  --code-heading: #f2f2f2; /* 17.47:1 — Campbell brightWhite */
  --code-inserted: #16c60c; /*  8.49:1 — diff +, Campbell brightGreen */
  --code-deleted: #e74856; /*  5.09:1 — diff -, Campbell brightRed */

  /* Editor chrome. Line numbers are decorative and may sit at 4.31:1; the
     cursor and selection are Windows Terminal's own (defaults.json cursor
     #FFFFFF, selection = white at ~50% alpha, taken down here because an
     editor selection covers text that is still being read). */
  --code-gutter-fg: #767676;
  --code-gutter-fg-active: #cccccc;
  --code-active-line: rgba(255, 255, 255, 0.04);
  --code-selection: rgba(255, 255, 255, 0.22);
  --code-selection-inactive: rgba(255, 255, 255, 0.1);
  --code-cursor: #ffffff;
  --code-bracket-match: rgba(34, 211, 238, 0.25);

  /* ---- Typography ---------------------------------------------------- */
  --font-ui: 'Inter Variable', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif;
  --font-mono: Consolas, 'Cascadia Mono', ui-monospace, monospace;

  --fs-100: 11px;
  --lh-100: 1.45;
  --fs-200: 12px;
  --lh-200: 1.45;
  --fs-300: 13px;
  --lh-300: 1.3846; /* = Android bodyDense 13sp/18sp */
  --fs-400: 15px;
  --lh-400: 1.3;
  --fs-500: 18px;
  --lh-500: 1.25;
  --fs-600: 20px;
  --lh-600: 1.2;

  --fw-regular: 400;
  --fw-medium: 500;
  --fw-semibold: 600;
  --fw-bold: 700;

  /* ---- Space (4px grid, per Android Spacing.kt) ----------------------- */
  --sp-1: 4px;
  --sp-2: 8px;
  --sp-3: 12px;
  --sp-4: 16px;
  --sp-5: 24px;
  --sp-6: 32px;

  /* ---- Radii --------------------------------------------------------- */
  --r-sm: 4px; /* chips, badges, tags, selected-row band */
  --r-md: 6px; /* buttons, inputs, tab segments */
  --r-lg: 10px; /* cards, panels */
  --r-xl: 14px; /* overlay / modal */

  /* ---- Density ------------------------------------------------------- */
  --row-h: 28px; /* list rows: session, file, forward */
  --row-pad-x: 10px;
  --row-pad-y: 6px;
  --control-h: 28px; /* buttons, inputs, selects */
  --control-h-sm: 24px;
  --topbar-h: 40px;
  --tabbar-h: 32px;

  /* ---- Motion (per Android docs/design-system.md §motion) ------------- */
  --dur-fast: 150ms;
  --dur-normal: 200ms;
  --dur-slow: 280ms; /* overlay entrance only */
  --ease: cubic-bezier(0.2, 0, 0, 1);
  --ease-out: cubic-bezier(0, 0, 0.2, 1); /* decelerate: things arriving */
}

* {
  box-sizing: border-box;
}
html,
body,
#app {
  height: 100%;
  margin: 0;
}
body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  line-height: var(--lh-300);
  /* CSS equivalent of Windows Terminal's "antialiasingMode": "grayscale", so
     the UI and the terminal it frames are rasterised the same way. */
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

/* Numbers must not jitter between rows: timestamps, ports, percentages. */
.session-time,
.fwd-table,
.meter-pct,
.sz,
.host-detail,
.folder-count {
  font-variant-numeric: tabular-nums;
}

/* One focus treatment for the whole app. The app is keyboard-driven around a
   terminal, and the transparent-background buttons suppress the UA default.
   Deliberately NO border-radius here: Chromium already draws the outline
   along the element's own corners, so setting one would *mutate the focused
   element's geometry* — square things (the editor textarea) visibly rounded
   themselves on focus. See docs/POLISH.md §5. */
:where(button, a, input, select, textarea, [tabindex]):focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
/* Rows live inside `overflow-y: auto` lists, which clip a +2px offset ring.
   Inset it instead. `.folder-header` is a <button> and benefits today; the
   list rows are forward-compatible for when they become keyboard-reachable. */
:where(.session-row, .entry, .folder-header):focus-visible {
  outline-offset: -2px;
}

/* Loading spin for refresh icons: the button keeps its icon instead of
   swapping to an ellipsis character, which changed its width mid-action. */
.spin {
  animation: icon-spin 900ms linear infinite;
}
@keyframes icon-spin {
  to {
    transform: rotate(360deg);
  }
}

/* One global reduced-motion guard, covering .spin, the overlay entrance, the
   host-picker pulse and every hover transition. Components no longer carry
   their own @media blocks. */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}

/* ---------------------------------------------------------------------------
 * Shared primitives — see docs/DESIGN.md §5.1.
 *
 * These were previously copy-pasted per component (.icon-btn in 7 files,
 * .muted in 10, .error in 5, .empty in 5), each drifting a little. They live
 * here now; the component <style scoped> blocks no longer redefine them.
 * ------------------------------------------------------------------------- */
/* Ghost SQUARE icon button — toolbars, panel headers, table-row actions. The
   VS Code register: invisible at rest, filled on hover. Square by
   construction, so the icon is optically centred and adjacent buttons are
   identical widths (the old `padding + glyph advance` sizing made `<-` and
   the hamburger visibly different boxes). See docs/POLISH.md §3. */
.icon-btn {
  width: var(--control-h);
  height: var(--control-h);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--r-md);
  color: var(--fg-secondary);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.icon-btn:hover:not(:disabled) {
  background: var(--state-hover);
  color: var(--fg);
}
.icon-btn:active:not(:disabled) {
  background: var(--state-active);
}
.icon-btn:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
.icon-btn.sm {
  width: var(--control-h-sm);
  height: var(--control-h-sm);
}

/* Ghost LABELED button — header text actions (Ports, Usage, disconnect).
   Same register as .icon-btn; it just has words in it. */
.btn-ghost {
  height: var(--control-h);
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 0 var(--sp-2);
  background: transparent;
  border: none;
  border-radius: var(--r-md);
  color: var(--fg-secondary);
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
  line-height: 1;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.btn-ghost:hover:not(:disabled) {
  background: var(--state-hover);
  color: var(--fg);
}
.btn-ghost:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
.muted {
  color: var(--fg-secondary);
}
.error {
  color: var(--error);
  font-size: var(--fs-200);
}
.empty {
  color: var(--fg-muted);
  font-style: italic;
  padding: var(--sp-4);
}
</style>
