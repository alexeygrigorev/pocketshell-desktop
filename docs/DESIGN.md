# PocketShell Desktop — Visual Design Spec

Status: **specification only.** Nothing in this document has been applied to
`src/`. It is written against the *restructured* navigation (session list as
the default host view; per-session Terminal/Conversation/Files tabs; Usage and
Ports as header buttons), which is what the screenshots below already show.

Every recommendation here is grounded in one of four sources, cited inline:

| Source | What it grounds |
|---|---|
| `docs/screenshots/*.png` (captured from the running app, see §1) | the "before" state |
| `%LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json` + Windows Terminal 1.24.11911.0 `defaults.json` | every terminal value in §3 |
| The Android app at `C:\Users\alexey\git\pocketshell` (v0.4.8) — `shared/ui-kit/.../theme/{Color,Type,Shape,Spacing}.kt`, `FolderListScreen.kt`, `mockups/tree/index.html` | the token values and component geometry in §4–§5 |
| WCAG 2.1 relative-luminance math, computed per pair | every contrast number stated |

---

## 1. Current state — captured screenshots

Captured by driving the **built** app (`npm run build` → `out/main/index.js`)
with Playwright's `_electron.launch`, against the deterministic Docker fixture
(`tests-docker/docker-compose.yml`, service `helper`, port 3205, committed
`test_key`). Viewport 1280×800, matching `BrowserWindow`'s default size in
`src/main/index.ts`.

| File | State |
|---|---|
| `docs/screenshots/01-host-picker.png` | Host picker, 3 hosts listed |
| `docs/screenshots/02-workspace-sessions.png` | Connected host; session list as default view; right pane empty state |
| `docs/screenshots/03-terminal-attached.png` | Session `main` attached, `tmux` status bar, real command output |
| `docs/screenshots/04-session-conversation.png` | Conversation tab, engine/session picker, **empty** (see gap below) |
| `docs/screenshots/05-session-files.png` | Files tab, SFTP listing of `/home/testuser`, editor empty state |
| `docs/screenshots/06-ports-overlay.png` | Ports overlay panel over the workspace |
| `docs/screenshots/07-usage-overlay.png` | Usage overlay, 3 provider cards (codex/claude/copilot) with meters |
| `docs/screenshots/08-session-list-default.png` | Back on the Terminal tab |

Two later passes re-captured the same states from the same harness, so the
three sets diff against each other directly:

| Prefix | Pass |
|---|---|
| `01`…`08` | before the token/type/layout work of this document |
| `after-01`…`after-08` | after it |
| `composer-*` | the prompt-composer panel's own states |
| **`polish-01`…`polish-16`** | after the POLISH.md pass (§5.8 icons, §5.1 ghost chrome, §5.9 motion) — plus the Files dirty state, four composer states, and the redesigned Usage overlay at 1 / 3 / 6+ providers including null-percentage rows |

**Gap — not captured:** the Conversation tab is shown *empty*. The fixture's
stub agents seed `~/.claude/projects/` but the tmux session `main` has no
matching agent log, so `Load` returns nothing. The populated conversation
state (message bubbles, tool-call blocks, `.message.user` / `.message.assistant`
styling) is therefore **not** photographed. §5.6 specifies it from the
component's existing CSS and the Android `conversation.html` mockup rather than
from a screenshot — treat that one section as less grounded than the rest.

### What the screenshots show

1. **Density is inconsistent.** The topbar is ~42px tall, the session-tab strip
   ~30px, session rows ~29px, and the host-picker rows ~52px. Four different
   rhythms in one app.
2. **The type scale has ~20 distinct sizes.** `grep font-size` across
   `src/renderer/**/*.vue` returns `0.7 / 0.72 / 0.75 / 0.78 / 0.8 / 0.85 /
   0.88 / 0.9 / 0.95 / 1.1 / 1.5 rem` plus a `14px` root. Most of these
   differences are not perceivable and none are intentional.
3. **Colour has escaped the token set.** `--bg/--fg/--muted/--accent/--error/
   --border` are the only six tokens, but 30+ raw Catppuccin hexes are
   hard-coded in component styles (`#181825` panel background in four files,
   `#a6e3a1` success in four, `#f9e2af` warning in five, `#11111b`, `#cba6f7`,
   `#bac2de`, …). There is no success or warning token, so every component
   invents one.
4. **`rgba(137, 180, 250, …)`** — the accent colour, re-typed by hand as raw
   RGB in six files at four different alphas (.06/.08/.14/.16) for hover and
   selection. Any accent change silently breaks all six.
5. **Primitives are copy-pasted, not shared.** `.icon-btn` is redefined in 7
   files, `.muted` in 10, `.error` in 5, `.empty` in 5 — each with slightly
   different padding and size.
6. **The terminal is visually foreign to the app** — `#1e1e2e` chrome against
   a `#1e1e2e` terminal, so the most important surface in the product has no
   edge at all (`03-terminal-attached.png`).

---

## 2. Typography

### 2.1 The problem with the current stack

`src/renderer/App.vue` sets:

```css
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
```

On this target (Windows 11, Electron 33) every entry before `'Segoe UI'` is
dead — `-apple-system` and `BlinkMacSystemFont` are macOS-only, `Roboto` is
never reached. So the app always renders in **Segoe UI**, and the stack is
three tokens of noise around one real choice. Worse, on Windows 11 the *system*
UI font is Segoe UI **Variable**, not Segoe UI; naming the static face opts the
app out of the optical-size axis that makes Windows 11 chrome look current.

### 2.2 Recommendation: bundle Inter Variable

**Package:** `@fontsource-variable/inter` — version 5.3.0, license **OFL-1.1**
(verified via `npm view`). Self-hosted woff2, no network fetch at runtime,
which matters because Electron's renderer has no business reaching Google
Fonts.

Why Inter specifically, rather than "a nicer font":

- **It is already the sibling project's design font.** The Android repo's
  mockups declare `font-family: Inter, ui-sans-serif, system-ui, …` in
  `mockups/tree/index.html:24` and `docs/mockups/styles.css`. Adopting Inter on
  the desktop makes the two clients one product rather than two.
- **It renders correctly on Windows.** Inter is hinted and was designed for
  screen UI at 11–15px, which is exactly the range this app lives in (see the
  scale below). This is the size band where most "designer" fonts fall apart on
  Windows' greyscale antialiasing.
- **It has real tabular figures.** The session list, the Usage meters and the
  Ports table all show columns of numbers that currently jitter between rows
  because Segoe UI's default figures are proportional. `font-variant-numeric:
  tabular-nums` fixes that with one declaration — see §5.3.

Install:

```
npm i @fontsource-variable/inter
```

and add `import '@fontsource-variable/inter';` to `src/renderer/main.ts`.
Vite fingerprints and inlines the woff2 into `out/renderer/assets/`.

**Fallback stack** (Inter missing → the best native face on each OS, no dead
entries):

```css
--font-ui: 'Inter Variable', 'Segoe UI Variable Text', 'Segoe UI',
           system-ui, sans-serif;
```

If bundling is rejected, the correct zero-dependency fallback is
`'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif` — drop the two
Apple aliases and `Roboto` regardless.

### 2.3 Monospace: Consolas everywhere

The user's Windows Terminal is set to **Consolas** (§3). Use the same face for
the app's mono chrome — session names, paths, ports, IDs — so the terminal and
the UI that frames it read as one surface. Consolas ships with every Windows
install since Vista and with Office on macOS, so no bundling is needed.

```css
--font-mono: Consolas, 'Cascadia Mono', ui-monospace, monospace;
```

This deliberately diverges from the Android app, which bundles JetBrains Mono
(`shared/core-terminal/src/main/assets/fonts/JetBrainsMono-Regular.ttf`).
Matching the user's own terminal beats matching the phone here — that is the
explicit ask.

### 2.4 Type scale

Derived from the Android ladder in `shared/ui-kit/.../theme/Type.kt` (11 / 13 /
15 / 16 / 18 / 20 sp) mapped 1:1 to px, which is correct because Android `sp`
at the default font scale and CSS `px` in Electron are both 1/160-inch-class
device-independent units at 100% scaling.

| Token | Size | Weight | Line height | Used for |
|---|---|---|---|---|
| `--fs-100` | 11px | 600 | 1.45 | section headers (`SESSIONS`), chips, badges, timestamps, table headers |
| `--fs-200` | 12px | 400 | 1.45 | dense secondary text, hints, breadcrumbs |
| `--fs-300` | **13px** | 400 / 500 | **1.3846** | the workhorse — every list row, tab label, button, input |
| `--fs-400` | 15px | 600 | 1.3 | folder-group headers, session title, card titles, overlay titles |
| `--fs-500` | 18px | 600 | 1.25 | overlay/section headings ("Provider usage", "Port forwarding") |
| `--fs-600` | 20px | 700 | 1.2 | the `PocketShell` wordmark on the host picker only |

`--fs-300`'s 1.3846 is not arbitrary: it is Android's `bodyDense` 13sp/18sp
exactly, so a 13px row is 18px tall in both clients.

Weights come from Inter Variable's `wght` axis — 400 body, 500 for list-row
titles (enough to separate a session name from its timestamp without the
"bolded list" look), 600 for headers and the selected tab, 700 for the wordmark.
**Do not use 800/900**; the current `h1` at `1.5rem` with browser-default bold
is the heaviest thing in the app and it is a picker heading.

Two global rules to add alongside the scale:

```css
body { -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
```

`-webkit-font-smoothing: antialiased` is the CSS equivalent of Windows
Terminal's `"antialiasingMode": "grayscale"` (§3), so the UI and the terminal
are rasterised the same way.

---

## 3. Terminal — Consolas, from the user's Windows Terminal

### 3.1 What the settings file actually contains

`C:\Users\alexey\AppData\Local\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json`:

- `profiles.defaults.font` = `{ "face": "Consolas", "size": 16 }`
- `defaultProfile` = `{2ece5bfe-…}` = the **Git Bash** profile, which repeats
  the same font block and adds `"bellStyle": "none"`
- `"schemes": []` and `"themes": []` — **both empty**
- top level: `"copyOnSelect": false`, `"copyFormatting": "none"`,
  and remapped keys: `ctrl+c` → `Terminal.CopyToClipboard`,
  `ctrl+v` → `Terminal.PasteFromClipboard`

> **The user's colour scheme is not in the file.** No profile sets
> `colorScheme` and `schemes` is empty, so the effective scheme is Windows
> Terminal's built-in default. The values below are read out of the installed
> product's `defaults.json` (Windows Terminal **1.24.11911.0**, at
> `C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_1.24.11911.0_x64__8wekyb3d8bbwe\defaults.json`),
> where every shipped profile carries `"colorScheme": "Campbell"`. These are
> the real built-in values, not a reconstruction.

Other values inherited from that same built-in default block (also not in the
user's file, also read from `defaults.json`): `cursorShape: "bar"`,
`padding: "8, 8, 8, 8"`, `historySize: 9001`,
`antialiasingMode: "grayscale"`, `snapOnInput: true`,
`wordDelimiters: " /\\()\"'-.,:;<>~!@#$%^&*|+=[]{}~?│"`.

### 3.2 The one conversion that needs stating

Windows Terminal's `font.size` is in **points**. CSS/xterm `fontSize` is in
**px**. At 96 DPI:

```
16pt × 96/72 = 21.33px  →  fontSize: 21
```

Sanity check: 21px Consolas in an ~800px-tall pane yields ≈30 rows, and
Windows Terminal's own `initialRows` default is exactly **30**. The conversion
is right. Note the current `TerminalView.vue` uses `fontSize: 13` — the new
value is a large, deliberate jump, which is what "take the config from Windows
Terminal" means. Expose it as `--term-font-size` so it stays tunable.

`lineHeight` stays at **1.0**: the user sets no `font.cellHeight`, so Windows
Terminal uses Consolas' natural cell, whose design line box is ≈1.0em.

### 3.3 Contrast audit of Campbell

Computed against Campbell's own background `#0C0C0C`:

| Colour | Hex | Ratio | |
|---|---|---:|---|
| foreground / white | `#CCCCCC` | 12.18:1 | AAA |
| brightWhite | `#F2F2F2` | 17.47:1 | AAA |
| brightYellow | `#F9F1A5` | 16.91:1 | AAA |
| brightCyan | `#61D6D6` | 11.27:1 | AAA |
| brightGreen | `#16C60C` | 8.49:1 | AAA |
| yellow | `#C19C00` | 7.47:1 | AAA |
| cyan | `#3A96DD` | 6.14:1 | AA |
| green | `#13A10E` | 5.71:1 | AA |
| brightRed | `#E74856` | 5.09:1 | AA |
| brightBlue | `#3B78FF` | 4.95:1 | AA |
| brightBlack | `#767676` | 4.31:1 | AA-large |
| red | `#C50F1F` | 3.23:1 | AA-large |
| brightMagenta | `#B4009E` | 3.20:1 | AA-large |
| **magenta** | `#881798` | **2.44:1** | **fail** |
| **blue** | `#0037DA` | **2.38:1** | **fail** |

Campbell's dim `blue` and `magenta` are genuinely unreadable on its own
background — a known property of the scheme, not a transcription error. Rather
than editing the user's palette, set xterm's
**`minimumContrastRatio: 3`**, which lifts only the failing pairs at render
time and leaves the other 14 colours pixel-identical to Windows Terminal.
(Set it to `1` to disable if byte-exact parity is preferred over legibility.)

### 3.4 The options object

Diff-ready replacement for the `TERMINAL_OPTIONS` const in
`src/renderer/components/TerminalView.vue`. Every option name below was
verified against `node_modules/@xterm/xterm/typings/xterm.d.ts` (6.0.0).

```ts
/**
 * Terminal look & feel, transcribed from the user's Windows Terminal config.
 *
 * Source: %LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\
 *         LocalState\settings.json  (font face/size, bellStyle)
 *   plus  Windows Terminal 1.24 defaults.json  (everything the user's file
 *         leaves unset: the Campbell scheme, bar cursor, 8px padding,
 *         9001-line scrollback, grayscale AA, word delimiters).
 * The user's settings.json has "schemes": [] and no `colorScheme` key, so the
 * built-in default scheme — Campbell — is what they actually see.
 */
const TERMINAL_OPTIONS: ITerminalOptions = {
  // profiles.defaults.font.face = "Consolas"
  fontFamily: 'Consolas, "Cascadia Mono", ui-monospace, monospace',
  // profiles.defaults.font.size = 16 POINTS -> 16 * 96/72 = 21.33 CSS px.
  fontSize: 21,
  fontWeight: 400,
  fontWeightBold: 700,
  // No `font.cellHeight` override, so Consolas' natural cell (~1.0em).
  lineHeight: 1.0,
  letterSpacing: 0,

  // defaults.json: cursorShape "bar". Windows Terminal blinks by default.
  cursorStyle: 'bar',
  cursorBlink: true,
  cursorInactiveStyle: 'outline',

  // defaults.json: historySize 9001, snapOnInput true.
  scrollback: 9001,
  scrollOnUserInput: true,

  // defaults.json: wordDelimiters — makes double-click word selection split
  // paths and punctuation exactly as it does in Windows Terminal.
  wordSeparator: ' /\\()"\'-.,:;<>~!@#$%^&*|+=[]{}~?\u2502',

  drawBoldTextInBrightColors: true,
  // Campbell's dim blue (2.38:1) and magenta (2.44:1) are unreadable on its
  // own background; this lifts only those and leaves the rest untouched.
  minimumContrastRatio: 3,

  // Built-in "Campbell" scheme, verbatim. Windows Terminal names the
  // magenta slot "purple"; xterm calls it `magenta`.
  theme: {
    background: '#0C0C0C',
    foreground: '#CCCCCC',
    cursor: '#FFFFFF',
    cursorAccent: '#0C0C0C',
    // Campbell defines no selectionBackground; Windows Terminal falls back to
    // white drawn at ~50% alpha. Kept translucent so text stays readable.
    selectionBackground: 'rgba(255, 255, 255, 0.35)',
    selectionInactiveBackground: 'rgba(255, 255, 255, 0.18)',
    black: '#0C0C0C',
    red: '#C50F1F',
    green: '#13A10E',
    yellow: '#C19C00',
    blue: '#0037DA',
    magenta: '#881798',
    cyan: '#3A96DD',
    white: '#CCCCCC',
    brightBlack: '#767676',
    brightRed: '#E74856',
    brightGreen: '#16C60C',
    brightYellow: '#F9F1A5',
    brightBlue: '#3B78FF',
    brightMagenta: '#B4009E',
    brightCyan: '#61D6D6',
    brightWhite: '#F2F2F2',
  },
};
```

And the scoped style in the same file, replacing the current `padding: 6px` /
`background: #1e1e2e`:

```css
.terminal {
  width: 100%;
  height: 100%;
  /* Windows Terminal defaults.json: padding "8, 8, 8, 8" */
  padding: 8px;
  background: var(--term-bg);       /* #0C0C0C — Campbell */
  overflow: hidden;
  /* Windows Terminal defaults.json: antialiasingMode "grayscale" */
  -webkit-font-smoothing: antialiased;
}
```

**Not mappable:** `bellStyle: "none"` has no xterm 6 equivalent (`bellStyle`
was removed in xterm 5 and no bell is emitted), so the user's setting is
satisfied by doing nothing.

---

## 4. Colour tokens

### 4.1 Recommendation: adopt the Android palette

The current tokens are Catppuccin Mocha (`#1e1e2e` / `#cdd6f4` / `#89b4fa`).
The Android app is on a GitHub-dark-derived palette
(`shared/ui-kit/src/main/java/com/pocketshell/uikit/theme/Color.kt`):
`#0D1117` / `#E6EDF3` / cyan `#22D3EE`. Two reasons to move:

1. **Product coherence.** These are two clients of one product. The phone's
   palette is the documented one (`docs/design-system.md`, 700 lines of token
   tables); the desktop's Catppuccin was a scaffold default.
2. **It resolves the terminal-edge problem for free.** Campbell's `#0C0C0C`
   against Catppuccin's `#1e1e2e` is a visible violet-vs-neutral clash. Against
   `#0D1117` the ratio is **1.03:1** — the terminal reads as a slightly deeper
   well in the same neutral family, exactly the relationship the Android app
   builds deliberately with `TermBg #010409` vs `Background #0D1117`.

### 4.2 Contrast (computed, WCAG 2.1)

Text tokens, against the three surface elevations:

| Token | Hex | on `--bg` | on `--surface` | on `--surface-2` |
|---|---|---:|---:|---:|
| `--fg` | `#E6EDF3` | 16.02 AAA | 14.64 AAA | 13.68 AAA |
| `--fg-secondary` | `#8B949E` | 6.15 AA | 5.62 AA | 5.26 AA |
| `--fg-muted` | `#6E7681` | 4.12 | 3.77 | 3.52 |
| `--accent` | `#22D3EE` | 10.47 AAA | 9.57 AAA | 8.95 AAA |
| `--success` | `#22C55E` | 8.31 AAA | 7.59 AAA | 7.10 AAA |
| `--warning` | `#F59E0B` | 8.81 AAA | 8.05 AAA | 7.53 AAA |
| `--error` | `#EF4444` | 5.03 AA | 4.60 AA | 4.30 |
| `--agent` | `#A78BFA` | 6.95 AA | 6.36 AA | 5.94 AA |
| `--on-accent` on `--accent` | `#04101A` | — | — | 10.62 AAA |

Two rules fall out of this table:

- **`--fg-muted` (4.12:1) is below AA for body text.** Restrict it to ≥15px
  text or to genuinely decorative content (the `··` separators, disabled
  glyphs). Everything currently using `--muted` for real information —
  session timestamps, `user@host` in the picker, folder counts — must move to
  `--fg-secondary` (6.15:1). The current app has the same defect and worse:
  Catppuccin `--muted #7f849c` on `#1e1e2e` is **4.44:1**, and it is used for
  every timestamp and subtitle in the product.
- **`--error` on `--surface-2` is 4.30:1**, marginally under AA. Error text
  inside inputs/menus should sit on `--surface` or `--bg`, not `--surface-2`.

Non-text pairs:

| Pair | Ratio | Note |
|---|---:|---|
| `--surface` on `--bg` | 1.09 | elevation step — intentionally subtle, carried by the border |
| `--surface-2` on `--surface` | 1.07 | ditto |
| `--border` `#2D333B` on `--bg` | 1.49 | decorative hairline only; exempt from 1.4.11 |
| `--border-strong` `#6E7681` on `--bg` | 4.12 | ✅ ≥3:1 — **required** for input/control boundaries |
| `--border-strong` on `--surface-2` | 3.52 | ✅ still ≥3:1 |

WCAG 1.4.11 requires 3:1 for boundaries that are the *only* way to identify a
control. `--border` at 1.49:1 cannot carry a text input; that is why
`--border-strong` exists and why §5.3 mandates it on inputs and selects.

### 4.3 The token block

Ready to paste over the `:root` block in `src/renderer/App.vue`. It is
additive-compatible: the six existing names (`--bg --fg --muted --accent
--error --border`) are all still defined, so nothing breaks on the first
commit.

```css
:root {
  color-scheme: dark;

  /* ---- Surfaces (elevation 0 -> 3) ----------------------------------- */
  --bg:            #0D1117;  /* window / page ground */
  --surface:       #161B22;  /* topbar, side panel, cards, overlay body */
  --surface-2:     #1C2129;  /* inputs, chips, table heads, menus */
  --surface-3:     #232A34;  /* popovers / anything above an overlay */
  --scrim:         rgba(1, 4, 9, 0.72);   /* modal backdrop */

  /* ---- Text ---------------------------------------------------------- */
  --fg:            #E6EDF3;  /* 16.02:1 on --bg */
  --fg-secondary:  #8B949E;  /*  6.15:1 — subtitles, timestamps, counts */
  --fg-muted:      #6E7681;  /*  4.12:1 — >=15px or decorative ONLY */

  /* ---- Lines --------------------------------------------------------- */
  --border:        #2D333B;  /* default hairline */
  --border-soft:   #21262D;  /* row separators inside a panel */
  --border-strong: #6E7681;  /* 4.12:1 — inputs & controls (WCAG 1.4.11) */

  /* ---- Accent -------------------------------------------------------- */
  --accent:        #22D3EE;  /* 10.47:1 on --bg */
  --accent-dim:    #0891B2;  /* accent borders, active separators */
  --accent-soft:   rgba(34, 211, 238, 0.12);  /* selected row fill */
  --on-accent:     #04101A;  /* 10.62:1 on --accent */

  /* ---- Status -------------------------------------------------------- */
  --success:       #22C55E;
  --warning:       #F59E0B;
  --error:         #EF4444;
  --agent:         #A78BFA;  /* agent/assistant role, per Android */
  --success-soft:  rgba(34, 197, 94, 0.12);
  --warning-soft:  rgba(245, 158, 11, 0.12);
  --error-soft:    rgba(239, 68, 68, 0.12);
  --agent-soft:    rgba(167, 139, 250, 0.14);

  /* ---- Motion --------------------------------------------------------- */
  /* --dur-slow and --ease-out were added by POLISH.md §4.1: the overlay
     entrance is the one thing slow enough to want a decelerating curve.
     --ease stays the default for state changes (hover tints, rotation). */
  --dur-fast:      150ms;
  --dur-normal:    200ms;
  --dur-slow:      280ms;                       /* overlay entrance only */
  --ease:          cubic-bezier(0.2, 0, 0, 1);
  --ease-out:      cubic-bezier(0, 0, 0.2, 1);  /* decelerate: things arriving */

  /* ---- Interaction states -------------------------------------------- */
  /* Neutral lift for hover: tinting every hover cyan (as the app does today
     with rgba(137,180,250,.08)) makes hover read as selection. */
  --state-hover:    rgba(230, 237, 243, 0.05);
  --state-active:   rgba(230, 237, 243, 0.09);
  --state-selected: var(--accent-soft);
  --focus-ring:     var(--accent);
  --focus-ring-width: 2px;
  --focus-ring-offset: 2px;
  --disabled-opacity: 0.45;

  /* ---- Terminal (see DESIGN.md §3 — Windows Terminal / Campbell) ------ */
  --term-bg:        #0C0C0C;
  --term-fg:        #CCCCCC;
  --term-font-size: 21px;   /* = 16pt at 96 DPI */
  --term-padding:   8px;

  /* ---- Typography ---------------------------------------------------- */
  --font-ui:   'Inter Variable', 'Segoe UI Variable Text', 'Segoe UI',
               system-ui, sans-serif;
  --font-mono: Consolas, 'Cascadia Mono', ui-monospace, monospace;

  --fs-100: 11px;  --lh-100: 1.45;
  --fs-200: 12px;  --lh-200: 1.45;
  --fs-300: 13px;  --lh-300: 1.3846;  /* = Android bodyDense 13sp/18sp */
  --fs-400: 15px;  --lh-400: 1.3;
  --fs-500: 18px;  --lh-500: 1.25;
  --fs-600: 20px;  --lh-600: 1.2;

  --fw-regular: 400;
  --fw-medium:  500;
  --fw-semibold: 600;
  --fw-bold:    700;

  /* ---- Space (4px grid, per Android Spacing.kt) ----------------------- */
  --sp-1:  4px;
  --sp-2:  8px;
  --sp-3: 12px;
  --sp-4: 16px;
  --sp-5: 24px;
  --sp-6: 32px;

  /* ---- Radii --------------------------------------------------------- */
  --r-sm: 4px;   /* chips, badges, tags, selected-row band */
  --r-md: 6px;   /* buttons, inputs, tab segments */
  --r-lg: 10px;  /* cards, panels */
  --r-xl: 14px;  /* overlay / modal */

  /* ---- Density ------------------------------------------------------- */
  --row-h:      28px;  /* list rows: session, file, forward */
  --row-pad-x:  10px;
  --row-pad-y:   6px;
  --control-h:  28px;  /* buttons, inputs, selects */
  --control-h-sm: 24px;
  --topbar-h:   40px;
  --tabbar-h:   32px;

  /* ---- Motion (per Android docs/design-system.md §motion) ------------- */
  --dur-fast:   150ms;
  --dur-normal: 200ms;
  --ease:       cubic-bezier(0.2, 0, 0, 1);
}
```

---

## 5. Layout & components

### 5.0 Global rules

```css
body {
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  line-height: var(--lh-300);
  -webkit-font-smoothing: antialiased;
}

/* Numbers must not jitter between rows: timestamps, ports, percentages. */
.session-time, .fwd-table, .meter-pct, .sz, .host-detail {
  font-variant-numeric: tabular-nums;
}

/* One focus treatment for the whole app. There is none today. */
:where(button, a, input, select, textarea, [tabindex]):focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
/* Rows live inside `overflow-y: auto` lists, which clip a +2px offset ring. */
:where(.session-row, .entry, .folder-header):focus-visible {
  outline-offset: -2px;
}
```

The focus rule is not cosmetic — the app is keyboard-driven around a terminal,
and right now nothing shows focus except the browser default that the custom
`background: transparent` buttons largely suppress.

**Revised (POLISH.md §5).** This rule originally also set `border-radius:
var(--r-md)`. That declaration is deleted: Chromium already draws the outline
along the focused element's own corners, so it did not shape the *ring* — it
mutated the *element*, visibly rounding the square editor textarea the moment
it took focus. The inset-offset variant above is the second half of the fix.

### 5.1 Shared primitives (extract before restyling)

`.icon-btn` (7 copies), `.muted` (10), `.error` (5), `.empty` (5) should become
one set of global classes in `App.vue`'s unscoped `<style>`, then be deleted
from the component `<style scoped>` blocks. Restyling 7 copies of `.icon-btn`
by hand is how the current drift happened.

**Revised (POLISH.md §3).** The single bordered `.icon-btn` is split in two,
both *ghost*: invisible at rest, filled on hover, in the VS Code register. The
old primitive sized itself from `padding + the glyph's advance width`, so two
adjacent icon buttons were visibly different widths; icon-only buttons are now
square by construction. Nine bordered rectangles at rest in a 40px topbar were
the single biggest "unpolished" signal in the before-screenshots.

```css
/* Ghost SQUARE icon button — toolbars, panel headers, row actions. */
.icon-btn {
  width: var(--control-h); height: var(--control-h);
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--r-md);
  color: var(--fg-secondary);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease),
              color var(--dur-fast) var(--ease);
}
.icon-btn:hover:not(:disabled) { background: var(--state-hover); color: var(--fg); }
.icon-btn:active:not(:disabled) { background: var(--state-active); }
.icon-btn:disabled { opacity: var(--disabled-opacity); cursor: default; }
.icon-btn.sm { width: var(--control-h-sm); height: var(--control-h-sm); }

/* Ghost LABELED button — text actions (Ports, Usage, Disconnect). */
.btn-ghost {
  height: var(--control-h);
  display: inline-flex; align-items: center; gap: var(--sp-1);
  padding: 0 var(--sp-2);
  background: transparent;
  border: none;
  border-radius: var(--r-md);
  color: var(--fg-secondary);
  font-family: var(--font-ui);
  font-size: var(--fs-300); font-weight: var(--fw-medium); line-height: 1;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease),
              color var(--dur-fast) var(--ease);
}
.btn-ghost:hover:not(:disabled) { background: var(--state-hover); color: var(--fg); }
.btn-ghost:disabled { opacity: var(--disabled-opacity); cursor: default; }

/* Loading: the icon spins in place rather than being swapped for a bare `…`,
   which used to change the button's content width mid-action. */
.spin { animation: icon-spin 900ms linear infinite; }
@keyframes icon-spin { to { transform: rotate(360deg); } }

.muted { color: var(--fg-secondary); }
.error { color: var(--error); font-size: var(--fs-200); }
.empty { color: var(--fg-muted); font-style: italic; padding: var(--sp-4); }
```

A bordered look now survives **only** where chrome is earned: filled accent
actions (`Load`, `Add`, `Save`), the stateful `Auto-forward` toggle, the `Scan`
button that sits beside it in the same form bar, and form controls. Status
chips keep their tinted borders — they are status, not controls.

**Badge metric (POLISH.md §7).** Every `--r-sm` badge-like — `.chip`, `.tag`,
`.agent-badge`, `.kind`, `.status`, `.window-tag`, `.resume-chip`,
`.block-toggle` — uses `padding: 0 var(--sp-1)`, `line-height: var(--lh-100)`,
and `display: inline-flex; align-items: center; gap: var(--sp-1)`. The
inline-flex is also what centres an icon against the label once a chip
contains one.

### 5.2 Host picker (`01-host-picker.png`)

Today: 720px column, 52px rows, `1.5rem` bold `h1`, a `.badge` reading
"select a host".

- Wordmark `PocketShell` → `--fs-600` / `--fw-bold`, colour `--fg`. Drop the
  "select a host" badge — the list is self-evident and the badge is the only
  bordered pill on the screen.
- Host rows → `--surface`, `1px solid var(--border-soft)`, `--r-lg`, height
  44px (this is the one place a taller, card-like row is right — it is a
  landing screen, not a dense list). Matches the Android `HostCard`'s 14dp/
  44dp geometry, scaled.
- Host name `--fs-400`/`--fw-semibold`; `user@host:port` `--font-mono`/
  `--fs-200`/`--fg-secondary` (currently `--muted` at 4.44:1 — a real
  legibility fix).
- Hover: `background: var(--state-hover); border-color: var(--border-strong)`.
  Replace `border-color: var(--accent)` — reserve accent for *selected*, never
  hover.
- Add a leading 8px status dot per host (idle `--fg-muted`, connecting
  `--warning` pulsing, connected `--success`) to mirror the Android
  `StatusDot`; the desktop currently shows connection state only as the text
  "connecting…".

### 5.3 Session list — the default host view (`02`, `08`)

This is now the primary screen, and `src/renderer/sessionGrouping.ts` already
ports the phone's grouping (`groupSessionsByFolder`, folders sorted by recent
activity with `Untracked` pinned last — the Android *no-watched-roots* path).
The visual spec follows Android `FolderListScreen.kt`:

> **Superseded by docs/SESSIONLIST.md (implemented).** The *leaf*-level tree
> below is gone: on a real host the distribution is 1:1 (11 folders, 11
> sessions), so every folder header cost a row to say nothing, and the session
> name is *derived from the folder path*, so the two lines were the same fact
> twice.
>
> The panel is not flat, though. One folder level survives, at the **root** —
> `$HOME`'s children (`git`, `tmp`, …) plus an `other` catch-all — because
> that is the level the 1:1 measurement does *not* apply to: all 11 of those
> sessions live under one `git`. So the header earns its row there, and only
> there. See SESSIONLIST.md §2–§3 for the current row spec. The `SESSIONS`
> header row and the chip metric stand; the rest of this table is history.

| Element | Spec |
|---|---|
| Panel | `--surface`, `border-right: 1px solid var(--border)`, min-width **200px** (**revised**: 240 contradicted the 200px drag clamp). `container-type: inline-size` |
| `SESSIONS` header | `--fs-100`/`--fw-semibold`/`--fg-muted`, `letter-spacing: .08em`, uppercase — keep as is, it is already right |
| `.session-row` | height `--row-h` (28px), padding `0 var(--row-pad-x) 0 var(--sp-2)`, **no child indent** — there is no parent row to align under |
| `.dot` | 8px; `--fg-muted` detached, `--success` attached (replaces the hard-coded `#a6e3a1`) |
| `.label` (primary) | folder basename, `--font-ui`/`--fs-300`, `flex: 1 1 auto; min-width: 0`. `--fw-semibold` when attached. Middle-truncates via a `.label-head` (shrink + ellipsis) / `.label-tail` (protected, last 8 chars) span pair, so `pocketshell-desktop` degrades to `poc…-desktop` rather than to `pocketshell` |
| `.row-name` (secondary) | session name, `--font-mono`/`--fs-100`/`--fg-secondary`, end-ellipsis. Rendered **only** when the name is not derivable from the label, or the folder holds siblings |
| `.agent-badge` | unchanged — `--agent` on `--agent-soft`, `--r-sm`, `--fs-100`, the shared chip metric (POLISH.md §7) |
| `.row-time` | **relative** (`now`, `12m`, `3h`, `2d`, then `Aug 12`), `--fs-100`/`--fg-secondary`/`tabular-nums`, right-aligned. Absolute form moved to the row tooltip. Hidden under `@container (width < 230px)` |
| Row tooltip | three lines: session name, full folder path, absolute time |
| `.session-row:hover` | `background: var(--state-hover)` |
| `.session-row.current` | `background: var(--state-selected)`, plus a 2px `--accent` left rail; **remove** the current cyan-tinted hover so hover and selection stop looking alike |
| Footer | a full-width `New session` button opening the folder-first picker. The bare name field it replaced is **deleted**: the name is derived from the folder, never typed |
| Retired | The `attached` text tag (dot + weight + sort position say it) and the absolute `.session-time`. `.folder-header`, `.disclosure` and the 28px child indent were retired with the leaf tree and are back at the root level; `.folder-count` stays retired — the root header carries a bare integer, not a `· N sessions` label |

**Gap to flag:** Android sorts agent sessions above plain shells and puts an
agent badge (`Claude` / `Codex` / `OpenCode`, purple `--agent` on
`--agent-soft`, `--r-sm`, `--fs-100` mono) on every row. `SessionSummary` in
`src/shared/types.ts` carries only `{name, created, activity, attached, path}`
— **no agent kind** — so neither is implementable today. `sessionGrouping.ts`
already documents this. The badge slot should be laid out now (fixed 72px
trailing column) so adding the field later is a data change, not a layout
change.

### 5.3b Host workspace chrome — NO topbar (revised, implemented)

The host topbar — back, collapse, `hetzner · alexey@135.181.114.209`,
Ports/Usage/Settings, disconnect — is **gone**. It was a full `--topbar-h` of
chrome above every terminal whose largest element was an identity label, in an
app whose whole point is the terminal; the same reasoning that merged the
session bar and tab strip (§5.4) applies one row up. Every control was
redistributed, none deleted:

| Was in the topbar | Lives now | Why there |
|---|---|---|
| Host label (`name · user@hostname`) | **the OS window title** | The native title bar was already spending its row saying the static word "PocketShell". Built by the pure `src/shared/windowTitle.ts`, applied over `win:setTitle`; the renderer drives it because the title mirrors the *view*, not the connection (Back keeps the link alive while the picker shows). Also puts the host in the taskbar and Alt-Tab. |
| Back arrow | leading slot of the session panel's `SESSIONS` header | An arrow beside `SESSIONS` reads as "leave this host's sessions". The header row was already paying `--topbar-h`. |
| Collapse toggle (`panel-left`) | trailing slot of the same header, beside Refresh | The hide control sits on the thing it hides. |
| Ports / Usage / Settings | a `.host-actions` row at the panel's **foot**, below "New session" | Host-scoped, so they belong to the host-scoped surface; bottom-most = most global (the VS Code gear-at-the-bottom register, gear far right). Ports and Usage keep text labels; two unlabeled overlay glyphs would be a memory test. Fits the 200px floor: ~150px of controls. |
| Disconnect | the **host picker**, on the connected host's row | Every disconnect already navigated to the picker; the button now lives at its destination, labeled, beside where the connection was opened. The connected row also gets the §5.2 `--success` dot, and clicking it re-enters the workspace **without re-dialling** (a second dial would orphan the live connection). |
| Missing-tools notice | unchanged — the workspace's top strip | Rendered only when a tool is absent, so the usual cost is zero rows. |

**Collapsed state is a rail, not nothing.** With the topbar gone, a zero-width
collapse would take the expand toggle — and with it every host control — off
screen. Collapsing now leaves a ~36px rail (`--surface`, right hairline)
holding the expand toggle and the back arrow, so both stay one click away
while ~90% of the panel's width still goes to the terminal.

Alignment note: the `SESSIONS` header and the session bar across the splitter
are both `--topbar-h`, so the window's top row reads as one line broken only
by the panel seam.

### 5.4 Session workspace header — ONE row (`03`, `04`, `05`)

Android uses a filled `SegmentedToggle` (selected = accent fill, `--on-accent`
label). **Keep the underline** on desktop — a filled cyan segment at 13px is
heavy for a mouse UI, and the underline already reads correctly in
`03-terminal-attached.png`.

**Revised: the identity bar and the tab strip are one row.** They were two
full-height bars, `--topbar-h` + `--tabbar-h` = 72px of chrome above every
terminal, in an app whose whole point is the terminal. Merged, the row is one
`--topbar-h` — a full bar height, not a compromise between two — and the
terminal gains the 40px the tab strip used to take.

- `.session-bar` `height: var(--topbar-h)`, `align-items: stretch`, **no
  vertical padding**, `border-bottom: 1px solid var(--border)`
- **Tabs lead.** They are the only thing in the row that is clicked, and a
  leading identity label of unpredictable length would shift them horizontally
  on every session switch. A control that moves under the cursor per session is
  worse than a name that sits further right
- `.tab` full row height, `--fs-300`/`--fw-medium`/`--fg-secondary`, padding
  `0 var(--sp-3)`, `border-bottom: 2px solid transparent`, `margin-bottom: -1px`.
  Full height is what lets the active tab's 2px underline land **on the row's own
  bottom border**; centring shorter buttons in a taller bar would leave that
  underline floating mid-row with a gap beneath it
- `.tab:hover` → `color: var(--fg)`; `.tab.active` → `color: var(--fg)`,
  `--fw-semibold`, `border-bottom-color: var(--accent)`
- Session name trails, `flex: 1`, right-aligned, `--font-mono`/`--fs-300`/
  `--fg-secondary`, end-ellipsis; close button as `.icon-btn` at the far right
- **The path is not rendered.** A session is named after the directory it runs
  in, so name-plus-path is one fact written twice — the same redundancy
  `docs/SESSIONLIST.md` removed from the session panel. The full path is the
  name's `title` tooltip, where it costs no width

### 5.5 Overlays — Usage and Ports (`06`, `07`)

Both are header buttons opening `OverlayPanel.vue`. Current backdrop is
`rgba(0,0,0,0.5)`; the panel has no elevation cue beyond a border.

- `.overlay-backdrop` → `background: var(--scrim)`, `backdrop-filter: blur(2px)`
- `.overlay-panel` → `background: var(--surface)`, `border: 1px solid
  var(--border)`, `border-radius: var(--r-xl)`, `box-shadow: 0 16px 48px
  rgba(0,0,0,.5)`
- **Sizes to its content (revised).** The panel used a fixed
  `height: min(720px, 88vh)`, so a panel holding 180px of content rendered as
  a mostly-empty rectangle. It is now `max-height`, with the body scrolling
  past the cap. Width is a `size` prop: `lg` = 960px (the wide port-forward
  table), `md` = 720px (anything narrower — a panel wider than its content is
  just a void with a border around it).
- **Panel-scoped controls live in the header**, via a named `actions` slot
  rendered beside the close button. A refresh control floating at the top-left
  of the body read as orphaned debris under the title.
- **Entrance (POLISH.md §4.3).** `<Transition name="overlay" appear>`: the
  backdrop fades over `--dur-normal --ease-out` while the panel rises 8px and
  scales from `0.985` over `--dur-slow --ease-out`; leaving is a plain
  `--dur-fast` fade with no scale, because dismissal should feel faster than
  arrival. Overlays used to pop in fully formed in one frame.
- `.overlay-title` → `--fs-500`/`--fw-semibold`
- **Remove the duplicated heading.** `07-usage-overlay.png` shows
  "Provider usage" twice — once as the overlay title, once as the view's own
  `h2`. `UsageView.vue`'s `h2` and `PortPanelView.vue`'s equivalent should be
  dropped when hosted in an overlay.
- **Usage is a table, not cards (revised — supersedes the `.card` spec).**
  The job of this screen is *comparison* — "who is nearly out?" — and three
  side-by-side cards each laid out their own label/bar/percentage tracks, so
  no meter aligned with any other meter and card heights moved with the data.
  It is now one shared grid, `128px 72px minmax(160px, 1fr) 128px` with an
  `--sp-4` column gap: **provider · window · remaining · resets**. Every meter
  sits in one continuous column and every percentage right-aligns to one edge,
  so the shortest bar is the answer at a glance; the form holds at 1 provider
  and at 6+ without reflowing, and rows cannot end up different heights.
  - Window labels use the helper's own `window` value (`5h`/`7d`/`weekly`/
    `monthly`) when present, falling back to `short-term`/`long-term`.
  - `.meter` 8px on a `--bg` well (was 6px on `--surface-3`, barely
    distinguishable from the card behind it); `.meter-fill` `--success` >50%,
    `--warning` >20%, `--error` otherwise (replaces the raw
    `#a6e3a1/#f9e2af/#f38ba8`); `.pct` 40px, `--font-mono`, `tabular-nums`,
    right-aligned.
  - One hairline per provider group, as a full-width grid child — a per-cell
    border is broken up by the column gaps and reads as stray underlines.
  - `.reset` is `--fs-100`/`--fg-secondary` and shows a **relative** time
    ("in 2h 14m"), with the absolute timestamp on `title`. A reset already in
    the past falls back to the absolute date.
- **Null percentages are not empty rows.** `percent_remaining` is `null` for
  codex and grok on helper 0.4.44 — that means *the meter* is unknown, not
  that the provider has nothing to say. When the percentage is missing the
  remaining cell reads a quiet italic `not reported` and the **reset becomes
  the row's primary content** (`--fs-200`/`--fw-medium`/`--fg`), because
  "codex resets in 2h" is the useful half anyway. Only when the reset is
  *also* null is the row genuinely quiet. Never coerce null to 0: a 0%-wide
  bar reads as "quota exhausted".
- Status chips → `.status.limited` `--warning` on `--warning-soft`,
  `.blocked/.error` `--error` on `--error-soft`, all `--r-sm`/`--fs-100`.
  **`ok` renders no chip** — a row of "ok" badges is noise, and the meter
  already says so when it is fine. Likewise the `block_reason` footnote is
  `--fg-secondary`, not amber: the meter colour carries the level and the
  badge carries the category, and three amber signals for one fact was the
  old card's loudest problem.
- Ports `.fwd-table` → `th` in `--fs-100`/`--fw-semibold`/`--fg-muted`
  uppercase on `--surface-2`; `td` `--font-mono`/`--fs-200`; row separator
  `--border-soft`. `.kind.local/.remote/.dynamic` → `--accent` / `--warning` /
  `--agent` (replaces `#89b4fa` / `#f9e2af` / `#cba6f7`).
- `.toggle.on` (Auto-forward) → `--accent-soft` fill, `--accent` text,
  `--accent-dim` border.

### 5.4b Prompt composer — a floating, movable card (`PromptComposer.vue`)

Behaviour is `docs/COMPOSER.md`'s; this is only where it sits and what it is
made of. The composer is **not** a docked row and **not** a full-bleed bar: it
is a card hovering over the session body, inside a `.composer-dock` that is
inset from that body and transparent to the mouse. **The user drags it and
resizes it**; what follows is where it starts and what it is made of.

| | |
|---|---|
| Inset | `--sp-3` on all four sides, applied to the dock. The gap *is* the floating cue; without it an overlay still reads as welded to the window |
| Rest | bottom-**right**, 720×240. ≈80 columns of the draft's 13px mono. Terminal output is left-aligned, so resting right and stopping at 720px keeps line starts, the prompt column and the left of tmux's status bar readable beside it |
| Move | by the header strip (`cursor: move`), clamped fully inside the pane, 12px edge snap on release |
| Resize | eight grips: four 6px edges, four 14px corners. Floors 360×190, height capped at 80% of the pane |
| Corners / elevation | `--r-xl` and `0 8px 32px rgba(0,0,0,.5)` — §5.5's `OverlayPanel` treatment, Y offset pulled in from 16px because a card that can sit flush against the bottom of its dock would throw that shadow off the pane and leave its *top* edge, the one with terminal text behind it, unseparated |
| Surface | `--surface`, fully opaque, `--border` hairline. Never translucent: terminal text bleeding through a prompt field is unreadable for both |
| Toggle | ONE control opens and closes it, pinned to the pane's bottom-right corner and present in both states, so the same pixel alternates down/up. It cannot live on the card — the card moves. The card's header keeps maximize/restore only |
| Closed | the card is removed; the toggle widens leftward into a 32px rail (`border-radius: 999px`) showing the waiting draft's first line and an attachment count |
| Reserved | `.tab-body` permanently pads the pill's height plus its inset, whatever the composer is doing — so the terminal's row count never changes and the remote tmux never reflows. See COMPOSER.md §21.2 and §21.4 |

The two constants (`--composer-rail-h`, `--composer-inset`) live on
`.session-workspace`, not in `:root`: they describe one pane's relationship with
the composer, and one declaration keeps the reserved strip and the card's inset
equal by construction.

### 5.5b Splitter (`02`, `03` · `HostWorkspaceView.vue`)

Transparent at rest, `--accent-dim` on hover with a **250ms enter delay** —
VS Code's sash. The splitter used to paint a 4px `--bg` band between the
session panel and the pane, visibly darker than both surfaces and doubling the
1px panel border beside it; the panel's own hairline is the seam. The delay
applies on enter only (leaving transitions immediately), so sweeping the
cursor across the app never flashes a cyan bar.

### 5.6 Conversation (`04` — empty state only)

Not photographed populated (see §1). Specified from `ConversationView.vue`'s
existing selectors and the Android `docs/mockups/conversation.html`:

- `.message.user` → `--accent-soft` fill, `--r-lg`, left rail 2px `--accent`
- `.message.assistant` → `--surface` fill, `--r-lg`, left rail 2px `--agent`
  (replaces the hard-coded `rgba(166,227,161,.08)` green, which currently reads
  as a success state rather than as a speaker)
- `.role` → `--fs-100`/`--fw-semibold` uppercase, `--fg-muted`
- `.text` → `--fs-300`, line-height **1.5** (`--lh` relaxed — this is the only
  prose in the app and 1.3846 is too tight for paragraphs)
- `.block pre` → `--font-mono`/`--fs-200`, `background: var(--term-bg)`,
  `--r-md`, `--sp-3` padding — deliberately the terminal's background so code
  blocks and the terminal agree.

### 5.7 Files (`05`)

- `.entry` height `--row-h`, hover `--state-hover`, `.entry.active`
  `--state-selected` (currently `rgba(137,180,250,.16)`)
- **Entry icons — revised (POLISH.md §2.5).** `.ic` is gone; the row renders
  `<AppIcon :name="icon(e)" :class="icon(e)" />` and the 16px SVG box *is* the
  icon column (the old `1.1rem` width was sized for an emoji). Colours:
  directory `--warning`, file `--fg-muted`, symlink `--fg-secondary`, the `..`
  row `--fg-muted`. On **selected** only the file icon lifts to
  `--fg-secondary` so it does not read disabled against the accent fill;
  on **hover nothing changes** (icon-colour flicker under a sweeping cursor
  reads as smear — the row's `--state-hover` fill is the feedback).
  The original spec asked for exactly these tokens and could not have them:
  `icon()` returned colour emoji, and colour-emoji rasterisation ignores CSS
  `color` entirely. Real SVGs are what made the token system reach this column.
- `.entry.active` carries the same 2px `--accent` left rail as `.session-row`
  (**revised**): one list marking selection with a rail and the adjacent one
  without it was exactly the sort of inconsistency that reads as unfinished
- `.nm` `--font-mono`/`--fs-300`; `.sz` `--fs-100`/`--fg-secondary`/
  `tabular-nums`, right-aligned
- `.breadcrumb` `--fs-200`, crumb links **`--fg-secondary` → `--fg` on hover**
  (**revised**, POLISH.md §6.2), separators `--fg-muted`. The old all-`--accent`
  crumb row was the loudest thing on the Files screen while being pure
  navigation, and it contradicted §5.2's own rule that accent is reserved for
  *selected*
- `.editor` → `--font-mono`, `--fs-300`, `background: var(--term-bg)`,
  `color: var(--term-fg)`

### 5.8 Iconography — no character ever does an icon's job

**The rule: no character-as-icon anywhere in the app.** Not emoji, not
box-drawing characters, not arrows, not an icon *font*. Every glyph standing
in for a graphic affordance is a real inline SVG that inherits `currentColor`.

Font glyphs cannot be stroke-tuned or token-tinted, they sit on the text
baseline rather than a control's optical centre, they rotate around the wrong
origin, and colour emoji ignore CSS `color` outright — which is why this
document's own §5.7 asked for a `--warning` folder and could not have one for
two revisions. An icon *font* repeats the same mistake in a tidier form, so
`@vscode/codicons` was considered and rejected on exactly that ground (it also
carries a visible-attribution requirement).

**The mechanism** is one local component, `src/renderer/components/AppIcon.vue`
— no package, no loader, nothing fetched, the strict `file://` renderer
untouched. Its contract:

| | |
|---|---|
| Geometry | Feather 4.29 path data (**MIT**), verbatim, in a registry inside the component |
| Canvas | one `24 24` viewBox for every mark, so stroke weights are identical across the set |
| Stroke | `2`, round caps and joins — the thin geometric unfilled register of VS Code's Codicons |
| Colour | **always `currentColor`.** An icon never sets its own colour; the parent's `color:` token does |
| Sizes | **16** (default: toolbars, tree glyphs), **14** (dense bars, the disclosure chevron), **12** (chips, table-row actions, block toggles). No others |
| Alignment | flex-centring, never baseline. The component is `display: block; flex: none`, which kills the inline-SVG descender gap and stops a truncating label from squashing it |

Two marks are painted rather than stroked (`dot`), or are Feather shapes with
a `<rect>` re-expressed as a path (`panel-left`, VS Code's toggle-sidebar
mark), so the template stays a single path loop.

`ComposerIcon.vue` was an earlier local copy of this contract, written while
this component was still being specified; it has been folded in and deleted.
There is one icon component in the tree.

**What stays text, deliberately:** `·` metadata separators, `…` inside a label
(`Sending…`, `probing…`), `—`/`–` as punctuation and no-data placeholders,
`~` and `/` in displayed paths, `↑`/`↓` inside keyboard-shortcut tooltip copy,
and the composer's `/` button — a keycap for the literal character it inserts.
That family is text, not iconography. A **bare** `…` swapped in as a button's
whole content is *not* text: those became the spinning refresh icon.

### 5.9 Motion

`--dur-fast` for state changes, `--dur-normal`/`--dur-slow` with `--ease-out`
for things arriving. What animates: hover tints, disclosure rotation, the
overlay entrance (§5.5), the splitter highlight (§5.5b), meter-fill width, the
loading `.spin`, and a 2px `translateX` nudge on the host-picker chevron.

**What must NOT animate:**

- **The terminal. Ever.** No transition or animation on `.terminal`, its
  container, or anything xterm renders — resize, attach and tab-switch are
  instant.
- **List-row hover** (`.session-row`, `.entry`). VS Code renders list hover
  instantly because a cursor sweeping a list with lagging tints reads as
  smear, not smoothness. The absence of a `transition` here is deliberate —
  do not "fix" it. (Same reason the file-tree icons do not change colour on
  hover, §5.7.)
- **Panel/splitter drag geometry** — width follows the pointer 1:1.
- **Folder expand/collapse height.** The chevron rotation is the motion cue.

One global `@media (prefers-reduced-motion: reduce)` guard in `App.vue` covers
every animation and transition, so components carry no per-component
reduced-motion blocks.

---

## 6. Application plan

Ordered so that each step is independently shippable and low-risk. **Steps 1–3
touch only `App.vue` and `TerminalView.vue`** — the two files least likely to
collide with the in-flight navigation and feature work.

| # | File | Change | Risk |
|---|---|---|---|
| **1** | `src/renderer/App.vue` → `:root` | Replace the 6-token block with §4.3. Keep `--muted` as an alias so no component breaks. | none — additive |
| **2** | `src/renderer/App.vue` → `body` | `font-family: var(--font-ui)`; `font-size: var(--fs-300)`; `line-height: var(--lh-300)`; add `-webkit-font-smoothing: antialiased`. Add `@fontsource-variable/inter` dep + `import` in `main.ts`. | low |
| **3** | `src/renderer/components/TerminalView.vue` | Replace `TERMINAL_OPTIONS` with §3.4; set `.terminal` padding to 8px and background to `var(--term-bg)`. | low — one const, already hoisted |
| **4** | `src/renderer/App.vue` (unscoped) | Add global `.icon-btn` / `.muted` / `.error` / `.empty` + the `:focus-visible` rule (§5.0–5.1); delete the 7 local `.icon-btn` copies. | medium — touches 7 files |
| **5** | `SessionTree.vue` | §5.3 — row height, folder header scale, `.dot` → `--success`, split hover from selection. | medium |
| **6** | `HostWorkspaceView.vue`, `SessionWorkspaceView.vue` | §5.4 — `--topbar-h`/`--tabbar-h`, tab type scale, chip colours → `--success`/`--warning`. | medium |
| **7** | `OverlayPanel.vue`, `UsageView.vue`, `PortPanelView.vue` | §5.5 — scrim, radius, shadow; drop the duplicated `h2`; replace the 12 raw hexes with status tokens. | medium |
| **8** | `HostPickerView.vue` | §5.2 — wordmark, card rows, status dot, drop the badge. | low |
| **9** | `FilesView.vue`, `FileTree.vue`, `ConversationView.vue` | §5.6–5.7 — replace remaining raw hexes and `rgba(137,180,250,…)`. | low |

**Verification gate for each step:** re-run the capture used for §1 and diff
against `docs/screenshots/`. The driver launches the built app with an isolated
fake `HOME` so the user's real `~/.ssh/config` is never touched — note that the
fake profile directory **must contain an `AppData\Roaming` subtree**, or
Electron fails to resolve `app.getPath('appData')`, `requestSingleInstanceLock()`
returns false and the app exits silently with code 3.

**Definition of done — two gates.** Both are executed, not remembered:
`tests/unit/designGates.test.ts` runs them on every `npm run test:unit`, since
a rule that lives only in a document decays one locally-reasonable exception
at a time (which is exactly how the emoji arrived).

1. **Colour tokens.**
   `grep -rE "#[0-9a-fA-F]{6}" src/renderer --include=*.vue`
   returns hits only in `App.vue` and in `TerminalView.vue`'s Campbell theme.

2. **No character-as-icon** (§5.8).
   ```
   grep -rnP "[▸▾▼▶◀◁▷△▽←→↑↓☰⟳✕✖✗✓⌘●📁📄↪🔧📎]" src/renderer --include=*.vue
   ```
   returns zero matches **outside** (a) code comments, (b) the genuine-text
   cases listed in §5.8 — `↑`/`↓` in the composer's shortcut tooltip is the
   one arrow that legitimately survives, as copy — and (c) `TerminalView.vue`,
   whose glyphs come from the remote program and from Consolas and are
   off-limits on principle. The `·` `…` `—` `–` `~` family is exempt by
   design: that is text.

---

## 7. Conflicts and open questions

1. **Copy-on-select contradicts the user's Windows Terminal config.**
   `TerminalView.vue` was just given copy-on-mouse-up (`onDocumentMouseUp`).
   The user's `settings.json` sets **`"copyOnSelect": false`** explicitly. The
   desktop app is now doing the one thing the user turned off in the tool this
   spec is meant to mirror. Recommend making it opt-in and defaulting to off.

2. **The clipboard chords do not match the user's keybindings either.**
   `TerminalView.vue` binds Ctrl/Cmd-**Shift**-C/V. The user's `settings.json`
   remaps plain **`ctrl+c` → CopyToClipboard** and **`ctrl+v` → PasteFromClipboard**.
   Windows Terminal makes plain Ctrl-C safe by sending `^C` when there is no
   selection and copying when there is; if the desktop app adopts the user's
   binding it must replicate that conditional, or it will break SIGINT. Flagging
   rather than specifying — it is behaviour, not visual design.

3. **`fontSize: 21` is a 62% jump from the current 13.** It is the faithful
   conversion of 16pt (§3.2) and I recommend shipping it, but it visibly
   changes terminal density, so it should be a deliberate call rather than a
   surprise. `--term-font-size` exists to make it one line to revisit.

4. **Agent kind is missing from `SessionSummary`** (§5.3), which blocks both
   the Android agent-first sort and the agent badges. This is in the
   `src/shared/types.ts` area another agent is actively changing — worth
   coordinating rather than adding independently.

5. **Duplicated overlay headings** (§5.5) are a structural artifact of hosting
   full views inside `OverlayPanel`, not a styling bug; fixing it means the
   views need to know they are embedded, or the overlay needs to stop rendering
   a title.

6. **Android parity is deliberately broken in two places**, both on the user's
   explicit instruction or on desktop-input grounds: mono font is Consolas, not
   the phone's bundled JetBrains Mono (§2.3); tabs stay underlined rather than
   becoming a filled segmented control (§5.4).
