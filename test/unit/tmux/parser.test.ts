/**
 * Parser unit tests
 *
 * Tests ALL event types with fixture data from the reference spec.
 */

import { describe, it, expect } from 'vitest';
import { parseLine, decodeOutputData, normalizeControlLineBytes } from '../../../src/tmux/parser';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buf(input: string | number[]): Buffer {
  if (typeof input === 'string') return Buffer.from(input, 'utf-8');
  return Buffer.from(input);
}

/**
 * Create a Buffer from a tmux wire-format string where:
 * - `\\` in the template becomes a single literal backslash (0x5C) in the buffer
 * - All other chars are literal
 *
 * This is needed because JS interprets `\033` as an octal escape (ESC byte),
 * but tmux wire format has literal backslash followed by ASCII digits.
 */
function wire(template: string): Buffer {
  return Buffer.from(template, 'latin1');
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join(' ');
}

function toUtf8(data: Uint8Array): string {
  return Buffer.from(data).toString('utf-8');
}

// ---------------------------------------------------------------------------
// %output
// ---------------------------------------------------------------------------

describe('parseLine — %output', () => {
  it('parses simple ASCII output', () => {
    const event = parseLine(buf('%output %0 hello'));
    expect(event).not.toBeNull();
    expect(event!.type).toBe('output');
    if (event!.type !== 'output') return;
    expect(event.paneId).toBe('%0');
    expect(toUtf8(event.data)).toBe('hello');
  });

  it('parses output with multi-digit pane ID', () => {
    const event = parseLine(buf('%output %123 x'));
    expect(event).not.toBeNull();
    expect(event!.type).toBe('output');
    if (event!.type !== 'output') return;
    expect(event.paneId).toBe('%123');
    expect(toUtf8(event.data)).toBe('x');
  });

  it('decodes octal escapes (ESC sequences)', () => {
    // Wire format: %output %1 \033[31mred\033[0m
    // Where \033 is 4 ASCII chars (backslash, 0, 3, 3)
    const line = Buffer.concat([
      Buffer.from('%output %1 ', 'ascii'),
      Buffer.from([0x5C, 0x30, 0x33, 0x33]), // \033
      Buffer.from('[31mred', 'ascii'),
      Buffer.from([0x5C, 0x30, 0x33, 0x33]), // \033
      Buffer.from('[0m', 'ascii'),
    ]);
    const event = parseLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe('output');
    if (event!.type !== 'output') return;
    // Should be: ESC [ 3 1 m r e d ESC [ 0 m
    const expected = Buffer.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x72, 0x65, 0x64, 0x1b, 0x5b, 0x30, 0x6d]);
    expect(hex(event.data)).toBe(hex(expected));
  });

  it('decodes doubled backslash', () => {
    // Wire: %output %0 a\\b  (where \\ is two chars: backslash backslash)
    const line = Buffer.concat([
      Buffer.from('%output %0 a', 'ascii'),
      Buffer.from([0x5C, 0x5C]), // \\
      Buffer.from('b', 'ascii'),
    ]);
    const event = parseLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe('output');
    if (event!.type !== 'output') return;
    expect(toUtf8(event.data)).toBe('a\\b');
  });

  it('handles empty output data', () => {
    const event = parseLine(buf('%output %0 '));
    expect(event).not.toBeNull();
    expect(event!.type).toBe('output');
    if (event!.type !== 'output') return;
    expect(event.data.length).toBe(0);
  });

  it('handles empty output with no trailing data', () => {
    // "%output %0" — pane ID at end, no space for data
    const event = parseLine(buf('%output %0'));
    expect(event).not.toBeNull();
    expect(event!.type).toBe('output');
    if (event!.type !== 'output') return;
    expect(event.data.length).toBe(0);
  });

  it('preserves high UTF-8 bytes verbatim', () => {
    // Raw bytes: %output %0 <0xD1 0x8C 0xE2 0x94 0x80>
    const line = Buffer.concat([
      Buffer.from('%output %0 ', 'ascii'),
      Buffer.from([0xD1, 0x8C, 0xE2, 0x94, 0x80]),
    ]);
    const event = parseLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe('output');
    if (event!.type !== 'output') return;
    expect(hex(event.data)).toBe('d1 8c e2 94 80');
  });

  it('returns null for %output without % pane prefix', () => {
    const event = parseLine(buf('%output 1 data'));
    expect(event).toBeNull();
  });

  it('decodes hex escapes', () => {
    // Wire: %output %0 \x1b  (backslash x 1 b)
    const line = Buffer.concat([
      Buffer.from('%output %0 ', 'ascii'),
      Buffer.from([0x5C, 0x78, 0x31, 0x62]), // \x1b
    ]);
    const event = parseLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe('output');
    if (event!.type !== 'output') return;
    expect(event.data[0]).toBe(0x1B);
  });

  it('decodes \\n escape', () => {
    // Wire: %output %0 \n  (backslash n)
    const line = Buffer.concat([
      Buffer.from('%output %0 ', 'ascii'),
      Buffer.from([0x5C, 0x6E]), // \n
    ]);
    const event = parseLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe('output');
    if (event!.type !== 'output') return;
    expect(event.data[0]).toBe(0x0A);
  });

  it('decodes \\r escape', () => {
    const line = Buffer.concat([
      Buffer.from('%output %0 ', 'ascii'),
      Buffer.from([0x5C, 0x72]), // \r
    ]);
    const event = parseLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe('output');
    if (event!.type !== 'output') return;
    expect(event.data[0]).toBe(0x0D);
  });

  it('decodes \\t escape', () => {
    const line = Buffer.concat([
      Buffer.from('%output %0 ', 'ascii'),
      Buffer.from([0x5C, 0x74]), // \t
    ]);
    const event = parseLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe('output');
    if (event!.type !== 'output') return;
    expect(event.data[0]).toBe(0x09);
  });

  it('passes unknown escapes through with literal backslash', () => {
    // Wire: %output %0 \q  (backslash q — unknown escape)
    const line = Buffer.concat([
      Buffer.from('%output %0 ', 'ascii'),
      Buffer.from([0x5C, 0x71]), // \q
    ]);
    const event = parseLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe('output');
    if (event!.type !== 'output') return;
    // Unknown escape: backslash passed through, q processed next
    // So output is: \q = 0x5C 0x71
    expect(hex(event.data)).toBe('5c 71');
  });
});

// ---------------------------------------------------------------------------
// %session-changed
// ---------------------------------------------------------------------------

describe('parseLine — %session-changed', () => {
  it('parses session with simple name', () => {
    const event = parseLine(buf('%session-changed $0 main'));
    expect(event).not.toBeNull();
    expect(event!.type).toBe('session-changed');
    if (event!.type !== 'session-changed') return;
    expect(event.sessionId).toBe('$0');
    expect(event.name).toBe('main');
  });

  it('parses session name with spaces', () => {
    const event = parseLine(buf('%session-changed $2 my session'));
    expect(event).not.toBeNull();
    expect(event!.type).toBe('session-changed');
    if (event!.type !== 'session-changed') return;
    expect(event.sessionId).toBe('$2');
    expect(event.name).toBe('my session');
  });

  it('returns null for missing session ID prefix', () => {
    const event = parseLine(buf('%session-changed 0 main'));
    expect(event).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// %sessions-changed
// ---------------------------------------------------------------------------

describe('parseLine — %sessions-changed', () => {
  it('parses sessions-changed event', () => {
    const event = parseLine(buf('%sessions-changed'));
    expect(event).not.toBeNull();
    expect(event!.type).toBe('sessions-changed');
  });
});

// ---------------------------------------------------------------------------
// %window-add
// ---------------------------------------------------------------------------

describe('parseLine — %window-add', () => {
  it('parses window-add event', () => {
    const event = parseLine(buf('%window-add @3'));
    expect(event).not.toBeNull();
    expect(event!.type).toBe('window-add');
    if (event!.type !== 'window-add') return;
    expect(event.windowId).toBe('@3');
  });

  it('returns null for missing window ID', () => {
    const event = parseLine(buf('%window-add '));
    expect(event).toBeNull();
  });

  it('returns null for wrong prefix', () => {
    const event = parseLine(buf('%window-add 3'));
    expect(event).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// %window-close
// ---------------------------------------------------------------------------

describe('parseLine — %window-close', () => {
  it('parses window-close event', () => {
    const event = parseLine(buf('%window-close @3'));
    expect(event).not.toBeNull();
    expect(event!.type).toBe('window-close');
    if (event!.type !== 'window-close') return;
    expect(event.windowId).toBe('@3');
  });
});

// ---------------------------------------------------------------------------
// %window-renamed
// ---------------------------------------------------------------------------

describe('parseLine — %window-renamed', () => {
  it('parses window-renamed event', () => {
    const event = parseLine(buf('%window-renamed @3 build'));
    expect(event).not.toBeNull();
    expect(event!.type).toBe('window-renamed');
    if (event!.type !== 'window-renamed') return;
    expect(event.windowId).toBe('@3');
    expect(event.name).toBe('build');
  });

  it('returns null with missing name', () => {
    const event = parseLine(buf('%window-renamed @3'));
    expect(event).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// %layout-change
// ---------------------------------------------------------------------------

describe('parseLine — %layout-change', () => {
  it('parses older tmux format (layout only)', () => {
    const event = parseLine(buf('%layout-change @0 b25d,80x24,0,0,0'));
    expect(event).not.toBeNull();
    expect(event!.type).toBe('layout-change');
    if (event!.type !== 'layout-change') return;
    expect(event.windowId).toBe('@0');
    expect(event.layout).toBe('b25d,80x24,0,0,0');
  });

  it('parses tmux 2.2+ format (with visible-layout and flags)', () => {
    const event = parseLine(buf('%layout-change @0 b25d,80x24,0,0,0 b25d,80x24,0,0,0 *'));
    expect(event).not.toBeNull();
    expect(event!.type).toBe('layout-change');
    if (event!.type !== 'layout-change') return;
    expect(event.windowId).toBe('@0');
    expect(event.layout).toBe('b25d,80x24,0,0,0');
  });
});

// ---------------------------------------------------------------------------
// %pane-mode-changed
// ---------------------------------------------------------------------------

describe('parseLine — %pane-mode-changed', () => {
  it('parses pane-mode-changed event', () => {
    const event = parseLine(buf('%pane-mode-changed %12'));
    expect(event).not.toBeNull();
    expect(event!.type).toBe('pane-mode-changed');
    if (event!.type !== 'pane-mode-changed') return;
    expect(event.paneId).toBe('%12');
  });
});

// ---------------------------------------------------------------------------
// %begin / %end / %error
// ---------------------------------------------------------------------------

describe('parseLine — %begin/%end/%error', () => {
  it('parses %begin', () => {
    const event = parseLine(buf('%begin 1700000000 5 0'));
    expect(event).not.toBeNull();
    expect(event!.type).toBe('begin');
    if (event!.type !== 'begin') return;
    expect(event.time).toBe(1700000000);
    expect(event.number).toBe(5);
    expect(event.flags).toBe(0);
  });

  it('parses %end', () => {
    const event = parseLine(buf('%end 1700000000 5 0'));
    expect(event).not.toBeNull();
    expect(event!.type).toBe('end');
    if (event!.type !== 'end') return;
    expect(event.time).toBe(1700000000);
    expect(event.number).toBe(5);
    expect(event.flags).toBe(0);
  });

  it('parses %error', () => {
    const event = parseLine(buf('%error 1700000000 5 0'));
    expect(event).not.toBeNull();
    expect(event!.type).toBe('error');
    if (event!.type !== 'error') return;
    expect(event.time).toBe(1700000000);
    expect(event.number).toBe(5);
    expect(event.flags).toBe(0);
  });

  it('returns null for malformed %begin (insufficient fields)', () => {
    const event = parseLine(buf('%begin 12345'));
    expect(event).toBeNull();
  });

  it('returns null for non-numeric fields', () => {
    const event = parseLine(buf('%begin abc 5 0'));
    expect(event).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// %client-detached
// ---------------------------------------------------------------------------

describe('parseLine — %client-detached', () => {
  it('parses %client-detached without name', () => {
    const event = parseLine(buf('%client-detached'));
    expect(event).not.toBeNull();
    expect(event!.type).toBe('client-detached');
  });

  it('parses %client-detached with name (tmux >= 3.2)', () => {
    const event = parseLine(buf('%client-detached /dev/ttyp0'));
    expect(event).not.toBeNull();
    expect(event!.type).toBe('client-detached');
  });
});

// ---------------------------------------------------------------------------
// %exit
// ---------------------------------------------------------------------------

describe('parseLine — %exit', () => {
  it('parses %exit without reason', () => {
    const event = parseLine(buf('%exit'));
    expect(event).not.toBeNull();
    expect(event!.type).toBe('exit');
    if (event!.type !== 'exit') return;
    expect(event.reason).toBeNull();
  });

  it('parses %exit with reason', () => {
    const event = parseLine(buf('%exit server exited'));
    expect(event).not.toBeNull();
    expect(event!.type).toBe('exit');
    if (event!.type !== 'exit') return;
    expect(event.reason).toBe('server exited');
  });

  it('parses %exit with trailing space as null reason', () => {
    const event = parseLine(buf('%exit '));
    expect(event).not.toBeNull();
    expect(event!.type).toBe('exit');
    if (event!.type !== 'exit') return;
    expect(event.reason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('parseLine — edge cases', () => {
  it('returns null for empty line', () => {
    expect(parseLine(buf(''))).toBeNull();
  });

  it('returns null for non-%-prefixed line', () => {
    expect(parseLine(buf('garbage'))).toBeNull();
  });

  it('returns null for unknown opcode', () => {
    expect(parseLine(buf('%unknown-event data'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DCS passthrough stripping
// ---------------------------------------------------------------------------

describe('normalizeControlLineBytes', () => {
  it('strips DCS passthrough wrapper', () => {
    // ESC P + "1000p" + event + ESC \
    const wrapped = Buffer.concat([
      Buffer.from([0x1B, 0x50]),  // ESC P
      Buffer.from('1000p'),
      Buffer.from('%begin 1234567890 1 0'),
      Buffer.from([0x1B, 0x5C]),  // ESC \
    ]);
    const normalized = normalizeControlLineBytes(wrapped);
    expect(normalized.toString('utf-8')).toBe('%begin 1234567890 1 0');
  });

  it('strips DCS from %output line', () => {
    const wrapped = Buffer.concat([
      Buffer.from([0x1B, 0x50]),
      Buffer.from('1000p'),
      Buffer.from('%output %0 hello'),
      Buffer.from([0x1B, 0x5C]),
    ]);
    const normalized = normalizeControlLineBytes(wrapped);
    expect(normalized.toString('utf-8')).toBe('%output %0 hello');
  });

  it('passes through non-wrapped lines unchanged', () => {
    const line = buf('%output %0 hello');
    const normalized = normalizeControlLineBytes(line);
    expect(normalized).toBe(line);  // same reference (identity)
  });
});

// ---------------------------------------------------------------------------
// decodeOutputData
// ---------------------------------------------------------------------------

describe('decodeOutputData', () => {
  it('returns identity data when no backslash present (fast path)', () => {
    const data = Buffer.from('hello world');
    const result = decodeOutputData(data, 0, data.length);
    expect(Buffer.from(result).toString('utf-8')).toBe('hello world');
  });

  it('decodes multiple escapes in one data block', () => {
    // Wire data: \033[31m\x1b[0m
    const data = Buffer.concat([
      Buffer.from([0x5C, 0x30, 0x33, 0x33]), // \033
      Buffer.from('[31m', 'ascii'),
      Buffer.from([0x5C, 0x78, 0x31, 0x62]), // \x1b
      Buffer.from('[0m', 'ascii'),
    ]);
    const result = decodeOutputData(data, 0, data.length);
    // \033 -> ESC (0x1B), [31m -> [ 3 1 m, \x1b -> ESC, [0m -> [ 0 m
    // Indices: 0=ESC, 1=[, 2=3, 3=1, 4=m, 5=ESC, 6=[, 7=0, 8=m
    expect(result[0]).toBe(0x1B);  // \033 -> ESC
    expect(result[1]).toBe(0x5B);  // [
    expect(result[4]).toBe(0x6D);  // m
    expect(result[5]).toBe(0x1B);  // \x1b -> ESC
    expect(result[6]).toBe(0x5B);  // [
  });
});
