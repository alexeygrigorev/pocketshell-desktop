/**
 * Unit tests for the fuzzy matcher.
 */

import { describe, it, expect } from 'vitest';
import { fuzzyMatch } from '../../../../src/agents/palette/fuzzy-matcher';

describe('fuzzyMatch', () => {
  it('returns null when no characters match', () => {
    const result = fuzzyMatch('xyz', 'abc');
    expect(result).toBeNull();
  });

  it('returns null when only some characters match', () => {
    const result = fuzzyMatch('abcdef', 'abc');
    expect(result).toBeNull();
  });

  it('returns a match for empty query', () => {
    const result = fuzzyMatch('', 'anything');
    expect(result).not.toBeNull();
    expect(result!.score).toBe(1);
    expect(result!.highlights).toEqual([]);
  });

  it('scores exact match highest', () => {
    const exact = fuzzyMatch('hello', 'hello')!;
    const prefix = fuzzyMatch('hel', 'hello')!;
    const partial = fuzzyMatch('hlo', 'hello')!;

    expect(exact.score).toBeGreaterThan(prefix.score);
    expect(prefix.score).toBeGreaterThan(partial.score);
  });

  it('scores prefix match higher than non-prefix match', () => {
    const prefix = fuzzyMatch('ses', 'session list')!;
    const nonPrefix = fuzzyMatch('lst', 'session list')!;

    expect(prefix.score).toBeGreaterThan(nonPrefix.score);
  });

  it('scores partial match lower than prefix match', () => {
    const prefix = fuzzyMatch('ses', 'session new')!;
    // 'ion' does not start with 's', so it cannot get the prefix bonus
    const partial = fuzzyMatch('ion', 'session new')!;

    expect(prefix.score).toBeGreaterThan(partial.score);
  });

  it('is case insensitive', () => {
    const lower = fuzzyMatch('session', 'Session List')!;
    const upper = fuzzyMatch('SESSION', 'Session List')!;
    const mixed = fuzzyMatch('SeSsIoN', 'Session List')!;

    expect(lower).not.toBeNull();
    expect(upper).not.toBeNull();
    expect(mixed).not.toBeNull();
    expect(lower.score).toBe(upper.score);
    expect(lower.score).toBe(mixed.score);
  });

  it('returns correct highlight ranges for prefix match', () => {
    const result = fuzzyMatch('ses', 'session')!;
    expect(result).not.toBeNull();
    expect(result.highlights.length).toBeGreaterThan(0);
    // Should highlight from index 0
    expect(result.highlights[0][0]).toBe(0);
    // The highlight should cover 'ses' characters
    expect(result.highlights[0][1]).toBeGreaterThanOrEqual(3);
  });

  it('returns correct highlight ranges for scattered match', () => {
    const result = fuzzyMatch('slt', 'session list')!;
    expect(result).not.toBeNull();
    // Should have highlight ranges
    expect(result.highlights.length).toBeGreaterThan(0);
  });

  it('matches characters across word boundaries', () => {
    const result = fuzzyMatch('sl', 'session list')!;
    expect(result).not.toBeNull();
    // The 'l' in 'list' starts at a word boundary
    expect(result.score).toBeGreaterThan(0);
  });

  it('handles slash prefix matching', () => {
    const result = fuzzyMatch('/ses', '/session list')!;
    expect(result).not.toBeNull();
    // '/' is the first character, should get prefix bonus
    expect(result.score).toBeGreaterThan(0);
  });

  it('returns null when query is longer than text', () => {
    const result = fuzzyMatch('a very long query string', 'ab');
    expect(result).toBeNull();
  });
});
