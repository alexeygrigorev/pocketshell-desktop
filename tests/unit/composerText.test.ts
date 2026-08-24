import { describe, expect, it } from 'vitest';
import {
  appendAttachmentPaths,
  appendSeededPrompt,
  attachmentDisplayName,
  insertCommandText,
  slashQueryFor,
} from '../../src/shared/composerText';
import { commandsFor, filteredCommands, insertionTextFor } from '../../src/shared/agentCommands';

/**
 * Ports of the Android client's own contracts for the composer's pure logic.
 * The case lists come from docs/COMPOSER.md §24 (which in turn comes from
 * PromptComposerViewModelTest / SlashCommandAutocompleteTest).
 */

describe('appendAttachmentPaths — the composition rule (PromptComposerViewModel.kt:2645)', () => {
  const A = '~/.pocketshell/attachments/main/20260824-101500-01-shot.png';
  const B = '~/.pocketshell/attachments/main/20260824-101500-02-log.txt';

  it('returns the draft untouched when there are no paths', () => {
    expect(appendAttachmentPaths('hello', [])).toBe('hello');
    expect(appendAttachmentPaths('', [])).toBe('');
  });

  it('REPLACES an empty draft, so an attachment-only send is legal', () => {
    expect(appendAttachmentPaths('', [A])).toBe(`Attached files:\n- ${A}`);
  });

  it('replaces a whitespace-only draft too (Kotlin isBlank(), not isEmpty())', () => {
    expect(appendAttachmentPaths('   \n\t ', [A])).toBe(`Attached files:\n- ${A}`);
  });

  it('separates a normal draft by exactly one blank line', () => {
    expect(appendAttachmentPaths('what is wrong here', [A])).toBe(
      `what is wrong here\n\nAttached files:\n- ${A}`,
    );
  });

  it('adds only the missing newline when the draft already ends in one', () => {
    expect(appendAttachmentPaths('line\n', [A])).toBe(`line\n\nAttached files:\n- ${A}`);
  });

  it('adds nothing when the draft already ends in a blank line', () => {
    expect(appendAttachmentPaths('line\n\n', [A])).toBe(`line\n\nAttached files:\n- ${A}`);
  });

  it('appends at the END, one bullet per path, in order', () => {
    expect(appendAttachmentPaths('why?', [A, B])).toBe(
      `why?\n\nAttached files:\n- ${A}\n- ${B}`,
    );
  });

  it('never prepends — the user text always comes first', () => {
    const out = appendAttachmentPaths('user text', [A]);
    expect(out.indexOf('user text')).toBeLessThan(out.indexOf('Attached files:'));
  });
});

describe('slashQueryFor (SlashCommandAutocomplete.kt:47)', () => {
  it('opens on a bare slash with an empty query (full catalog)', () => {
    expect(slashQueryFor('/', 1)).toBe('');
  });

  it('returns the token after the slash', () => {
    expect(slashQueryFor('/comp', 5)).toBe('comp');
  });

  it('closes once the caret moves past the leading token', () => {
    expect(slashQueryFor('/comp arg', 9)).toBeNull();
  });

  it('stays open while the caret is still inside the token', () => {
    expect(slashQueryFor('/comp arg', 5)).toBe('comp');
    expect(slashQueryFor('/comp arg', 0)).toBe('comp');
  });

  it('is closed when the text does not start with a slash', () => {
    expect(slashQueryFor('hello /comp', 11)).toBeNull();
    expect(slashQueryFor('', 0)).toBeNull();
  });

  it('treats any whitespace as the token terminator', () => {
    expect(slashQueryFor('/comp\nmore', 5)).toBe('comp');
    expect(slashQueryFor('/comp\nmore', 7)).toBeNull();
  });
});

describe('insertCommandText (SlashCommandAutocomplete.kt:94)', () => {
  it('replaces an existing leading token and preserves the trailing text', () => {
    expect(insertCommandText('/cle rest of it', '/clear')).toEqual(['/clear rest of it', 6]);
  });

  it('prepends when there is no leading slash token', () => {
    expect(insertCommandText('hello', '/clear')).toEqual(['/clearhello', 6]);
  });

  it('replaces the whole text when the token is the whole text', () => {
    expect(insertCommandText('/comp', '/compact ')).toEqual(['/compact ', 9]);
  });

  it('puts the caret at the end of the inserted command', () => {
    const [, caret] = insertCommandText('/x', '/rewind');
    expect(caret).toBe('/rewind'.length);
  });
});

describe('attachmentDisplayName (PromptComposerViewModel.kt:2675)', () => {
  it('shows the last path segment, never the full remote path', () => {
    expect(attachmentDisplayName('~/.pocketshell/attachments/main/shot.png')).toBe('shot.png');
  });

  it('tolerates trailing slashes and degenerate input', () => {
    expect(attachmentDisplayName('~/a/b/')).toBe('b');
    expect(attachmentDisplayName('shot.png')).toBe('shot.png');
    expect(attachmentDisplayName('/')).toBe('/');
  });
});

describe('appendSeededPrompt (PromptComposerViewModel.kt:482)', () => {
  it('replaces a blank draft', () => {
    expect(appendSeededPrompt('  ', 'review this')).toBe('review this');
  });

  it('adds a newline separator only when one is missing', () => {
    expect(appendSeededPrompt('hi', 'review this')).toBe('hi\nreview this');
    expect(appendSeededPrompt('hi\n', 'review this')).toBe('hi\nreview this');
  });
});

describe('agent command catalog (AgentCommandCatalog.kt)', () => {
  it('offers nothing when no agent is detected — a shell pane has no commands', () => {
    expect(filteredCommands(null, '')).toEqual([]);
    expect(filteredCommands(null, 'comp')).toEqual([]);
  });

  it('returns the full catalog for a blank query', () => {
    expect(filteredCommands('claude', '')).toEqual(commandsFor('claude'));
    expect(commandsFor('claude').length).toBeGreaterThan(0);
  });

  it('filters by substring over command, label and description', () => {
    const hits = filteredCommands('claude', 'comp').map((c) => c.command);
    expect(hits).toContain('/compact');
    expect(hits).not.toContain('/clear');
  });

  it('omits commands an engine does not have (OpenCode has no /goal)', () => {
    expect(commandsFor('opencode').map((c) => c.command)).not.toContain('/goal');
    expect(commandsFor('claude').map((c) => c.command)).toContain('/goal');
  });

  it('adds one trailing space only for argument-taking commands', () => {
    const compact = commandsFor('claude').find((c) => c.command === '/compact');
    const clear = commandsFor('claude').find((c) => c.command === '/clear');
    expect(insertionTextFor(compact!)).toBe('/compact ');
    expect(insertionTextFor(clear!)).toBe('/clear');
  });
});
