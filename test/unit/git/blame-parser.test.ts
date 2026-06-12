/**
 * Unit tests for git blame parser.
 *
 * Tests parseBlame with various git blame --porcelain outputs.
 */

import { describe, it, expect } from 'vitest';
import { parseBlame } from '../../../src/git/status-parser';

describe('parseBlame', () => {
  it('parses blame output', () => {
    const output = [
      'a1b2c3d4e5f6789012345678901234567890abcd 1 1 1',
      'author John Doe',
      'author-mail <john@example.com>',
      'author-time 1705312200',
      'author-tz +0000',
      'summary Initial commit',
      '\tHello, world!',
    ].join('\n');

    const lines = parseBlame(output);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      line: 1,
      hash: 'a1b2c3d4e5f6789012345678901234567890abcd',
      author: 'John Doe',
      date: new Date(1705312200 * 1000).toISOString(),
      content: 'Hello, world!',
    });
  });

  it('handles boundary commits', () => {
    // Boundary commits have a "^" prefix before the hash in some formats,
    // but in --porcelain output the hash is just the regular 40-char hex.
    // Boundary is indicated by a separate "boundary" line.
    const output = [
      'a1b2c3d4e5f6789012345678901234567890abcd 1 1 1',
      'boundary',
      'author Jane Smith',
      'author-mail <jane@example.com>',
      'author-time 1705312200',
      'author-tz +0000',
      'summary Initial commit',
      '\tFirst line of code',
    ].join('\n');

    const lines = parseBlame(output);

    expect(lines).toHaveLength(1);
    expect(lines[0].author).toBe('Jane Smith');
    expect(lines[0].content).toBe('First line of code');
  });

  it('parses multiple lines', () => {
    const output = [
      '1111111111111111111111111111111111111111 1 1 1',
      'author Alice',
      'author-time 1705312200',
      '\tLine 1',
      '2222222222222222222222222222222222222222 2 2 1',
      'author Bob',
      'author-time 1705398600',
      '\tLine 2',
    ].join('\n');

    const lines = parseBlame(output);

    expect(lines).toHaveLength(2);
    expect(lines[0].author).toBe('Alice');
    expect(lines[0].content).toBe('Line 1');
    expect(lines[1].author).toBe('Bob');
    expect(lines[1].content).toBe('Line 2');
  });

  it('handles empty output', () => {
    const lines = parseBlame('');
    expect(lines).toEqual([]);
  });

  it('parses lines with same commit for multiple lines', () => {
    const output = [
      'a1b2c3d4e5f6789012345678901234567890abcd 1 1 2',
      'author John Doe',
      'author-time 1705312200',
      'summary Add two lines',
      '\tFirst line',
      'a1b2c3d4e5f6789012345678901234567890abcd 2 2',
      '\tSecond line',
    ].join('\n');

    const lines = parseBlame(output);

    expect(lines).toHaveLength(2);
    expect(lines[0].hash).toBe(lines[1].hash);
    expect(lines[0].author).toBe('John Doe');
    expect(lines[1].author).toBe('John Doe');
  });
});
