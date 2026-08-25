/**
 * The palette a rendered markdown preview is painted in, and the stylesheet it
 * becomes.
 *
 * ## Why the palette has to travel at all
 *
 * The preview is an `<iframe>` on a different origin. CSS custom properties do
 * not cascade across that boundary — the frame's document has its own `:root`
 * and knows nothing about the one the app wrote its tokens onto — so a
 * stylesheet inside the frame cannot say `var(--fg)` and get the app's ink. The
 * only way for a preview to follow the theme is for the VALUES to cross:
 * resolved in the renderer (which is the one process that knows which theme is
 * applied), handed to main over IPC, and written into the generated document's
 * own `:root`.
 *
 * ## Why this is its own module, with no imports
 *
 * Because BOTH sides need part of it. Main needs all of it — the validation and
 * the stylesheet — and the renderer needs the token NAMES so it knows which
 * custom properties to resolve. Keeping the list next to the converter would
 * have meant the renderer importing a module that imports `marked`, dragging a
 * 45 KB parser into the renderer bundle to answer the question "which token
 * names do I look up", which is exactly the cost that converting in main
 * exists to avoid. This module imports nothing, so both sides share it for
 * free — the same arrangement `mimeTypes.ts` already has with `fileKind.ts`.
 */

/**
 * The design tokens the generated stylesheet needs, by name.
 *
 * Deliberately short. Every entry is a token the app already resolves for its
 * own surfaces, so a theme switch moves all of them together and nothing here
 * needs a per-theme value of its own — which is the property that keeps this
 * file out of the palette business entirely. The set is: the prose ground and
 * ink, the quieter ink for de-emphasised headings and quotes, three structural
 * lines, the accent, the editor's own ground and ink (so a fenced code block in
 * the preview matches the same block in the editor beside it), and the two font
 * families. A token nothing in the stylesheet references does not belong here:
 * it would be a value crossing the IPC bridge for no reason.
 */
export const PALETTE_TOKENS = [
  '--bg',
  '--surface',
  '--surface-2',
  '--fg',
  '--fg-secondary',
  '--border',
  '--border-soft',
  '--border-strong',
  '--accent',
  '--term-bg',
  '--term-fg',
  '--font-ui',
  '--font-mono',
] as const;

export type PaletteToken = (typeof PALETTE_TOKENS)[number];

/** Appearance of the applied theme, so the frame's own UI agrees with it. */
export type PreviewAppearance = 'dark' | 'light';

/** How a markdown preview should be painted. */
export interface PreviewStyle {
  palette: Record<PaletteToken, string>;
  appearance: PreviewAppearance;
}

/**
 * Fallbacks, as CSS SYSTEM COLOURS rather than literals.
 *
 * This is why no colour value appears anywhere in this file. `Canvas`,
 * `CanvasText`, `GrayText` and `LinkText` are CSS Color 4 system keywords that
 * resolve against the document's own `color-scheme`, so a preview that somehow
 * arrives with no palette is legible in either appearance instead of being
 * black on black. It also keeps the promise the design gate makes for the
 * renderer (`tests/unit/designGates.test.ts`: colour literals live in
 * `themes.ts` and nowhere else) true on this side of the IPC bridge as well,
 * where the gate does not reach — a second home for the palette is exactly the
 * kind of thing that rots.
 */
const FALLBACKS: Record<PaletteToken, string> = {
  '--bg': 'Canvas',
  '--surface': 'Canvas',
  '--surface-2': 'Canvas',
  '--fg': 'CanvasText',
  '--fg-secondary': 'CanvasText',
  '--border': 'GrayText',
  '--border-soft': 'GrayText',
  '--border-strong': 'GrayText',
  '--accent': 'LinkText',
  '--term-bg': 'Canvas',
  '--term-fg': 'CanvasText',
  '--font-ui': 'system-ui, sans-serif',
  '--font-mono': 'ui-monospace, monospace',
};

/**
 * Characters a token value may contain, and the length it may run to.
 *
 * The palette crosses an IPC boundary and is then interpolated into a `<style>`
 * block, which makes it a CSS injection site — a small one, since the values
 * originate in our own token block rather than on the remote host, but the
 * whole point of the renderer/main split is that main does not assume the
 * renderer was not compromised. So the grammar is an allowlist of the
 * characters real token values actually use (`#0d1117`, `rgba(13, 17, 23,
 * 0.72)`, `'Inter Variable', system-ui`, `13px`) and nothing else.
 *
 * What is missing is the point: no `;` or `}` (either would end the declaration
 * or the rule and let a value write rules of its own), no `<` or `>` (either
 * would let it close the `<style>` element), no `:` or `/` (so `url(https://…)`
 * cannot be spelled at all — the one thing that would reopen the network the
 * frame's CSP closed), and no backslash (a CSS escape is a way to spell any of
 * the above without using the character).
 */
const VALUE_ALLOWED = /^[A-Za-z0-9 ,.%#()'"_-]{1,120}$/;

/**
 * Take whatever the renderer sent and return a palette that is safe to
 * interpolate.
 *
 * Unknown keys are dropped rather than passed through, and a value that fails
 * the grammar falls back to its system colour rather than failing the whole
 * preview: a stylesheet with one wrong colour is still a legible document,
 * while a refused preview over one malformed token would be a puzzling dead
 * end with nothing on screen to explain it.
 */
export function sanitisePalette(raw: unknown): Record<PaletteToken, string> {
  const source = (raw ?? {}) as Record<string, unknown>;
  const out = {} as Record<PaletteToken, string>;
  for (const token of PALETTE_TOKENS) {
    // An OWN-property check, not `source[token]`, and it is not pedantry: a
    // payload of `{ __proto__: { '--bg': 'red' } }` has no own `--bg` at all,
    // yet a plain index would read `red` off the prototype chain. Structured
    // clone strips prototypes on the way through IPC, so this is unreachable
    // today — which is exactly why it would become reachable the moment anyone
    // called this with an object built in main. Reading own properties only
    // costs nothing.
    //
    // `Object.prototype.hasOwnProperty.call` rather than `Object.hasOwn`:
    // this module is compiled by the renderer's tsconfig too (fileKind and the
    // files store share it), and that one's lib predates ES2022.
    const value = Object.prototype.hasOwnProperty.call(source, token)
      ? source[token]
      : undefined;
    out[token] =
      typeof value === 'string' && VALUE_ALLOWED.test(value.trim())
        ? value.trim()
        : FALLBACKS[token];
  }
  return out;
}

/** `'light'` only when it was asked for by name; anything else is dark. */
export function sanitiseAppearance(raw: unknown): PreviewAppearance {
  return raw === 'light' ? 'light' : 'dark';
}

/**
 * The markdown preview's stylesheet, in the app's tokens.
 *
 * Deliberately small and deliberately not a clone of GitHub's markdown CSS:
 * this is a preview pane a few hundred pixels wide inside a file browser, not a
 * documentation site. What it has to do is (a) not be Times New Roman, (b) make
 * code blocks read as code, (c) follow the theme, and (d) keep a wide table or
 * a long unbroken URL from pushing the whole document sideways — the last one
 * being the failure that makes a preview feel broken rather than merely plain.
 *
 * The tokens arrive already validated by {@link sanitisePalette}; they are
 * written into one `:root` block and everything below references them by name,
 * so this reads like any other stylesheet in the app and moves with the theme
 * the moment a re-mint hands it new values.
 */
export function markdownStylesheet(style: PreviewStyle): string {
  const vars = PALETTE_TOKENS.map((token) => `${token}:${style.palette[token]};`).join('');
  return `
:root{${vars}color-scheme:${style.appearance};}
*{box-sizing:border-box;}
html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);}
body{font-family:var(--font-ui);font-size:14px;line-height:1.6;}
.md{max-width:52rem;margin:0 auto;padding:24px 28px 64px;}
.md>*:first-child{margin-top:0;}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.6em 0 .6em;font-weight:600;}
h1{font-size:1.9em;}h2{font-size:1.45em;}h3{font-size:1.2em;}
h4,h5,h6{font-size:1em;}
h1,h2{padding-bottom:.3em;border-bottom:1px solid var(--border-soft);}
h4,h5,h6{color:var(--fg-secondary);}
p{margin:0 0 1em;}
a{color:var(--accent);text-decoration:underline;text-underline-offset:2px;}
strong{font-weight:600;}
hr{border:none;border-top:1px solid var(--border);margin:2em 0;}
ul,ol{margin:0 0 1em;padding-left:1.6em;}
li{margin:.25em 0;}
li>input[type=checkbox]{margin-right:.4em;}
blockquote{margin:0 0 1em;padding:.1em 1em;border-left:3px solid var(--border-strong);color:var(--fg-secondary);}
code,kbd,samp{font-family:var(--font-mono);font-size:.92em;}
:not(pre)>code{background:var(--surface-2);border:1px solid var(--border-soft);border-radius:4px;padding:.12em .35em;}
pre{background:var(--term-bg);color:var(--term-fg);border:1px solid var(--border);border-radius:6px;padding:12px 14px;margin:0 0 1em;overflow-x:auto;}
pre code{background:none;border:none;padding:0;font-size:.92em;}
table{border-collapse:collapse;margin:0 0 1em;display:block;width:max-content;max-width:100%;overflow-x:auto;}
th,td{border:1px solid var(--border);padding:.4em .7em;text-align:left;}
th{background:var(--surface);font-weight:600;}
tr:nth-child(even) td{background:var(--surface-2);}
img{max-width:100%;height:auto;}
/* A long path or URL in prose must wrap rather than widen the document: the
   pane is narrow, and a horizontal scrollbar on the BODY makes every other
   line unreadable. Code blocks and tables scroll inside themselves instead. */
p,li,h1,h2,h3,h4,h5,h6{overflow-wrap:anywhere;}
`.trim();
}
