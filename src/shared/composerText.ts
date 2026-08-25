/**
 * Pure text helpers for the prompt composer.
 *
 * Every function here is a behaviour-for-behaviour port of a piece of Kotlin
 * from the Android client, cited per function. They are the parts of the
 * composer with unit-test-grade contracts, so they live outside the component
 * and outside the store and are tested directly (tests/unit/composerText.test.ts).
 *
 * See docs/COMPOSER.md §14.
 */

/**
 * Android: `PromptComposerViewModel.appendAttachmentPaths` (:2645-2660).
 *
 * The staged remote paths are appended at the END of the draft — never
 * prepended — as an `Attached files:` header followed by one `- <path>` line
 * per attachment, separated from the user's text by exactly one blank line.
 *
 * A blank draft (whitespace-only counts, matching Kotlin's `isBlank()`) is
 * REPLACED by the block, which is what makes an attachment-only send legal.
 *
 * This runs once, at send time only. Attaching never mutates the draft.
 */
export function appendAttachmentPaths(draft: string, paths: readonly string[]): string {
  if (paths.length === 0) return draft;
  const block = 'Attached files:' + paths.map((p) => `\n- ${p}`).join('');
  if (draft.trim() === '') return block;
  if (draft.endsWith('\n\n')) return draft + block;
  if (draft.endsWith('\n')) return draft + '\n' + block;
  return draft + '\n\n' + block;
}

/**
 * Android: `SlashCommandAutocomplete.slashQueryFor` (:47-61).
 *
 * `null` means the dropdown is CLOSED. It opens only while the draft's leading
 * token starts with `/` AND the caret sits within that token — so typing a
 * space and moving on to the argument closes it. A bare `/` yields `''`, which
 * shows the whole catalog.
 */
export function slashQueryFor(text: string, caret: number): string | null {
  if (!text.startsWith('/')) return null;
  const ws = text.search(/\s/);
  const tokenEnd = ws < 0 ? text.length : ws;
  if (caret < 0 || caret > tokenEnd) return null;
  return text.slice(1, tokenEnd);
}

/**
 * Android: `SlashCommandAutocomplete.insertCommandText` (:94-105).
 *
 * Replaces the leading slash token if there is one, otherwise prepends;
 * preserves any trailing text. Returns `[newText, newCaret]`, the caret landing
 * at the end of the inserted command.
 */
export function insertCommandText(text: string, commandText: string): [string, number] {
  let tokenEnd = 0;
  if (text.startsWith('/')) {
    const ws = text.search(/\s/);
    tokenEnd = ws < 0 ? text.length : ws;
  }
  return [commandText + text.slice(tokenEnd), commandText.length];
}

/**
 * Android: `PromptComposerViewModel.attachmentDisplayName` (:2675-2679).
 * A tile shows the file name, never the full remote path.
 */
export function attachmentDisplayName(remotePath: string): string {
  const trimmed = remotePath.replace(/\/+$/, '');
  const seg = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return seg.trim() === '' ? remotePath : seg;
}

/**
 * Android: `PromptComposerViewModel.seedDraftPrompt` (:482-497) separator rule.
 * Appends `prompt` to `draft` on its own line, collapsing the separator when
 * the draft is empty or already ends in a newline.
 */
export function appendSeededPrompt(draft: string, prompt: string): string {
  if (draft.trim() === '') return prompt;
  if (draft.endsWith('\n')) return draft + prompt;
  return draft + '\n' + prompt;
}

/** User-facing strings, copied verbatim from the Android client (§15). */
export const COMPOSER_STRINGS = {
  placeholder: 'Compose prompt…',
  notSent: 'Not sent. Reconnect, then send again or discard the draft.',
  connectionLost: 'Connection lost — Send will retry once reconnected.',
  /** `PromptComposerViewModel.kt:2687` — `<detail>` is the stager's own text. */
  attachmentFailed: (detail: string): string =>
    `Attachment upload failed: ${detail}. Your draft was kept; reconnect or choose a smaller/readable file.`,
  /** `PromptComposerSheet.kt:1010` */
  uploading: (n: number): string => `Uploading ${n} attachment(s)...`,
} as const;

/**
 * The first line of a draft worth showing in the collapsed rail.
 *
 * A preserved draft has to stay discoverable (docs/COMPOSER.md §12), and the
 * rail used to signal one with a status pip beside the placeholder. Showing the
 * draft's own opening line instead answers the question the pip could only
 * raise — WHICH unsent prompt is waiting — in the same 32px of space.
 *
 * Leading blank lines are skipped rather than rendered as an empty preview: a
 * draft that begins with a newline still has something to say.
 */
export function draftSummary(draft: string): string {
  const line = draft.split('\n').find((l) => l.trim() !== '');
  return line === undefined ? '' : line.trim();
}

/**
 * The fixed open/close toggle, which is ONE control in two states rather than
 * two controls in two places (docs/COMPOSER.md §21.5).
 *
 * The chevron points the way the panel will travel — down to put it away, up to
 * bring it back — which is the whole of the affordance: the user aims at one
 * unmoving spot and it alternates. Keeping that mapping here rather than in the
 * template is what lets a test pin it.
 */
export function railToggle(open: boolean): {
  icon: 'chevron-up' | 'chevron-down';
  title: string;
  label: string;
} {
  return open
    ? {
        icon: 'chevron-down',
        title: 'Hide the prompt panel (Ctrl+`)',
        label: 'Hide the prompt panel',
      }
    : {
        icon: 'chevron-up',
        title: 'Open the prompt panel (Ctrl+`)',
        label: 'Open the prompt panel',
      };
}
