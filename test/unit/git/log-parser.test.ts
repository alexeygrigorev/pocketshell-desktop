/**
 * Unit tests for git log parser.
 *
 * Tests parseLog with various git log --format outputs.
 */

import { describe, it, expect } from 'vitest';
import { parseLog } from '../../../src/git/status-parser';

describe('parseLog', () => {
  it('parses a single commit', () => {
    const output = [
      'ENDCOMMIT\x00',
      'a1b2c3d4e5f6789012345678901234567890abcd\x00',
      'a1b2c3d\x00',
      'John Doe\x00',
      'john@example.com\x00',
      '2026-01-15T10:30:00+00:00\x00',
      'Initial commit\x00',
      '\x00',
    ].join('');

    const commits = parseLog(output);

    expect(commits).toHaveLength(1);
    expect(commits[0]).toEqual({
      hash: 'a1b2c3d4e5f6789012345678901234567890abcd',
      shortHash: 'a1b2c3d',
      author: 'John Doe',
      authorEmail: 'john@example.com',
      date: '2026-01-15T10:30:00+00:00',
      subject: 'Initial commit',
      body: undefined,
    });
  });

  it('parses multiple commits', () => {
    const output = [
      'ENDCOMMIT\x00hash1\x00sh1\x00Author One\x00a1@test.com\x002026-01-01T00:00:00Z\x00First\x00\x00',
      'ENDCOMMIT\x00hash2\x00sh2\x00Author Two\x00a2@test.com\x002026-01-02T00:00:00Z\x00Second\x00\x00',
    ].join('');

    const commits = parseLog(output);

    expect(commits).toHaveLength(2);
    expect(commits[0].subject).toBe('First');
    expect(commits[1].subject).toBe('Second');
  });

  it('parses commit with body', () => {
    const output = [
      'ENDCOMMIT\x00hash1\x00sh1\x00Author\x00a@test.com\x002026-01-01T00:00:00Z\x00Subject\x00This is the body\nWith multiple lines\n\x00',
    ].join('');

    const commits = parseLog(output);

    expect(commits).toHaveLength(1);
    expect(commits[0].body).toBe('This is the body\nWith multiple lines\n');
  });

  it('parses empty log', () => {
    const commits = parseLog('');
    expect(commits).toEqual([]);
  });

  it('parses whitespace-only output as empty', () => {
    const commits = parseLog('   \n  \n');
    expect(commits).toEqual([]);
  });

  it('handles subject with special characters', () => {
    const output = [
      'ENDCOMMIT\x00hash1\x00sh1\x00Author\x00a@test.com\x002026-01-01T00:00:00Z\x00Fix bug: handle "quotes" & <brackets>\x00\x00',
    ].join('');

    const commits = parseLog(output);

    expect(commits).toHaveLength(1);
    expect(commits[0].subject).toBe('Fix bug: handle "quotes" & <brackets>');
  });
});
