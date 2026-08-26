import { describe, expect, it } from 'vitest';
import { execLogPreview } from '@main/ssh/SshService';
import { pathAwareCommand } from '@main/helper/bootstrap';

/**
 * The exec log exists to turn "it takes too long" into a count and a duration,
 * which only works if the lines can be told apart. Every remote command goes
 * out through `pathAwareCommand`, so the first ~60 characters of the raw string
 * are an identical `/bin/sh -lc 'export PATH=…'` wrapper — a preview that kept
 * it would print the same prefix for every line in the trace.
 */
describe('execLogPreview', () => {
  it('strips the path-aware wrapper and shows the real command', () => {
    expect(execLogPreview(pathAwareCommand('pocketshell sessions list --by activity'))).toBe(
      'pocketshell sessions list --by activity',
    );
  });

  it('tells the two commands of a create apart', () => {
    const list = execLogPreview(pathAwareCommand('pocketshell sessions list'));
    const create = execLogPreview(pathAwareCommand('pocketshell sessions create -n a -c /srv'));
    expect(list).not.toBe(create);
  });

  it('passes an unwrapped command through unchanged', () => {
    expect(execLogPreview('tmux list-sessions')).toBe('tmux list-sessions');
  });

  it('collapses the newlines a multi-line probe is built from', () => {
    expect(execLogPreview(pathAwareCommand('set -e\nfoo\nbar'))).toBe('set -e foo bar');
  });

  it('truncates a long command instead of filling the log with one line', () => {
    const long = execLogPreview(pathAwareCommand('x'.repeat(500)));
    expect(long.length).toBeLessThanOrEqual(121);
    expect(long.endsWith('…')).toBe(true);
  });

  it('keeps a command that is exactly at the limit whole', () => {
    expect(execLogPreview('y'.repeat(120))).toBe('y'.repeat(120));
  });
});
