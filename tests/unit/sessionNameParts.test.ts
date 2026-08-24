import { describe, expect, it } from 'vitest';
import { sanitisePart } from '../../src/shared/sessionNameParts';

/**
 * These cases pin the ORDER of the replacements, not just their result: main
 * derives session names with this function and the renderer decides whether a
 * name is redundant with its folder using the same one, so a change here
 * silently changes both.
 */
describe('sanitisePart', () => {
  it('collapses `.`/`:` runs to a single `_` before anything else', () => {
    expect(sanitisePart('a..b')).toBe('a_b');
    expect(sanitisePart('a::b')).toBe('a_b');
    expect(sanitisePart('v1.2.3')).toBe('v1_2_3');
  });

  it('collapses any other disallowed run to a single `-` and trims it', () => {
    expect(sanitisePart('a  b')).toBe('a-b');
    expect(sanitisePart('!!a!!')).toBe('a');
    expect(sanitisePart('...')).toBe('_');
    expect(sanitisePart('!!!')).toBe('');
  });

  it('leaves already-safe characters alone', () => {
    expect(sanitisePart('Abc_123-x')).toBe('Abc_123-x');
  });
});
