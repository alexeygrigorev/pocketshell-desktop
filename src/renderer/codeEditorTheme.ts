/**
 * The CodeMirror theme, expressed entirely in the app's design tokens.
 *
 * Not one colour literal appears below. Every value is a `var(--…)` reference
 * resolved by the browser against the token block in App.vue, which is the same
 * rule tests/unit/designGates.test.ts enforces for `.vue` files and the same
 * reason DoodleCanvas reads its pens out of computed style. The practical
 * payoff is that this file never has to be revisited when the palette moves:
 * `EditorView.theme` emits real CSS rules, so custom properties cascade into it
 * exactly as they do into any other stylesheet — including inheriting whatever
 * `:root` says at the moment of paint, which a JS colour constant cannot do.
 *
 * The syntax colours are Campbell-derived; App.vue's `--code-*` block carries
 * the derivation and the contrast audit.
 */
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

/**
 * Editor chrome: surface, gutter, cursor, selection.
 *
 * `{ dark: true }` is not cosmetic — it tells CodeMirror to register this as a
 * dark theme, which is what makes the built-in `dropCursor`, panel and
 * placeholder styles pick their dark variants. The app is `color-scheme: dark`
 * unconditionally (App.vue), so this is stated rather than detected.
 */
const chrome = EditorView.theme(
  {
    '&': {
      color: 'var(--term-fg)',
      backgroundColor: 'var(--term-bg)',
      height: '100%',
      // The editor's type is the terminal's type. Line height matches the
      // textarea this replaces so swapping the two does not reflow the pane.
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--fs-300)',
    },
    '&.cm-focused': {
      // CodeMirror draws a focus outline on the editor box by default. This
      // pane is the primary surface of the tab and is focused by simply
      // clicking into the file, so an outline around the whole thing reads as
      // a rendering artefact rather than as focus. The cursor is the affordance.
      outline: 'none',
    },
    '.cm-scroller': {
      fontFamily: 'inherit',
      lineHeight: '1.5',
      overflow: 'auto',
    },
    '.cm-content': {
      caretColor: 'var(--code-cursor)',
      padding: 'var(--sp-3) 0',
    },
    '.cm-line': {
      padding: '0 var(--sp-4)',
    },
    '.cm-cursor, .cm-dropCursor': {
      // Windows Terminal's cursorShape is "bar" (DESIGN.md §3.4); a 2px bar is
      // the same shape one line-height taller.
      borderLeftColor: 'var(--code-cursor)',
      borderLeftWidth: '2px',
    },
    '.cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'var(--code-selection-inactive)',
    },
    '&.cm-focused .cm-selectionBackground, &.cm-focused .cm-content ::selection': {
      backgroundColor: 'var(--code-selection)',
    },
    '.cm-activeLine': {
      backgroundColor: 'var(--code-active-line)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--term-bg)',
      color: 'var(--code-gutter-fg)',
      // A hairline in the app's own border token rather than a filled gutter:
      // the file is one surface, and a differently-shaded gutter would split it.
      borderRight: '1px solid var(--border-soft)',
      fontFamily: 'inherit',
      fontSize: 'var(--fs-200)',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 var(--sp-2) 0 var(--sp-3)',
      minWidth: '2.5ch',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'var(--code-active-line)',
      color: 'var(--code-gutter-fg-active)',
    },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: 'var(--code-bracket-match)',
      outline: 'none',
    },
    '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': {
      color: 'var(--code-invalid)',
    },
    '.cm-specialChar': {
      color: 'var(--code-invalid)',
    },
  },
  { dark: true },
);

/**
 * Token colours.
 *
 * Both grammar families feed this one table. The `@codemirror/lang-*` packages
 * are Lezer grammars that tag nodes precisely (`function(variableName)` is a
 * call, `definition(variableName)` is a binding); the `legacy-modes` tokenisers
 * run through StreamLanguage and emit a coarser set — mostly `keyword`,
 * `string`, `comment`, `variableName`, `typeName`, `atom`. Listing the coarse
 * tags alongside the precise ones is what makes a shell script and a TypeScript
 * file look like they came from the same editor.
 */
const highlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--code-comment)', fontStyle: 'italic' },

  {
    tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.self, t.modifier],
    color: 'var(--code-keyword)',
  },

  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: 'var(--code-string)' },
  // An escape inside a string has to be visible AGAINST the string colour, not
  // merely different from the background, so it borrows the type colour.
  { tag: [t.escape], color: 'var(--code-type)' },

  { tag: [t.number, t.bool, t.null, t.atom, t.integer, t.float, t.unit], color: 'var(--code-number)' },

  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName)), t.macroName],
    color: 'var(--code-function)',
  },

  {
    tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName), t.definition(t.typeName)],
    color: 'var(--code-type)',
  },

  {
    tag: [t.variableName, t.propertyName, t.definition(t.variableName), t.local(t.variableName), t.labelName],
    color: 'var(--code-variable)',
  },
  // Constants read as data, not as identifiers — SCREAMING_CASE and the
  // language's own `true`/`nil` should land in the same colour.
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: 'var(--code-number)' },

  { tag: [t.tagName, t.angleBracket, t.processingInstruction], color: 'var(--code-tag)' },
  { tag: [t.attributeName], color: 'var(--code-attribute)' },
  { tag: [t.attributeValue], color: 'var(--code-string)' },

  { tag: [t.meta, t.annotation, t.documentMeta], color: 'var(--code-meta)' },

  { tag: [t.punctuation, t.bracket, t.separator, t.operator, t.derefOperator], color: 'var(--code-punctuation)' },

  { tag: [t.link, t.url], color: 'var(--code-link)', textDecoration: 'underline' },
  { tag: [t.heading], color: 'var(--code-heading)', fontWeight: 'var(--fw-bold)' },
  { tag: [t.strong], fontWeight: 'var(--fw-bold)' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strikethrough], textDecoration: 'line-through' },
  { tag: [t.quote], color: 'var(--code-comment)' },
  { tag: [t.monospace], color: 'var(--code-string)' },

  // Diff and patch files, which are a first-class thing to open on a dev box.
  { tag: [t.inserted], color: 'var(--code-inserted)' },
  { tag: [t.deleted], color: 'var(--code-deleted)' },
  { tag: [t.changed], color: 'var(--code-string)' },

  { tag: [t.invalid], color: 'var(--code-invalid)' },
]);

/** Chrome + token colours, ready to drop into an EditorState's extensions. */
export const pocketshellCodeTheme: Extension = [chrome, syntaxHighlighting(highlight)];

/** Exported for tests, which assert the token table covers the common tags. */
export const pocketshellHighlightStyle = highlight;
