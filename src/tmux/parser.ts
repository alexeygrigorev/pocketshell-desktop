/**
 * tmux -CC Control Mode Parser
 *
 * Ported from PocketShell Android: ControlModeParser.kt
 * Reference: docs/tmux-protocol-reference.md sections 3, 4, 6
 *
 * Stateless line-oriented parser. Each call to parseLine() is independent.
 */

import type {
  ControlEvent,
  OutputEvent,
  SessionChangedEvent,
  SessionsChangedEvent,
  WindowAddEvent,
  WindowCloseEvent,
  WindowRenamedEvent,
  LayoutChangeEvent,
  PaneModeChangedEvent,
  BeginEvent,
  EndEvent,
  ErrorEvent,
  ClientDetachedEvent,
  ExitEvent,
} from './events';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PERCENT = 0x25;  // '%'
const ESC = 0x1B;      // ESC
const P = 0x50;        // 'P'
const BACKSLASH = 0x5C; // '\'
const LF = 0x0A;
const CR = 0x0D;

// Pre-encoded ASCII byte sequences
const OUTPUT_PREFIX = Buffer.from('%output ');
const PERCENT_BYTE = Buffer.from('%');

// ---------------------------------------------------------------------------
// DCS normalization
// ---------------------------------------------------------------------------

/**
 * Strip DCS passthrough wrapping from a raw byte line.
 * Reference: section 4
 *
 * ESC P ... %event ... ESC \
 * becomes just the %event part.
 */
function normalizeControlLineBytes(line: Buffer): Buffer {
  let start = 0;
  let end = line.length;

  // Strip leading ESC P, skip to first '%'
  if (end >= 2 && line[0] === ESC && line[1] === P) {
    for (let i = 2; i < end; i++) {
      if (line[i] === PERCENT) {
        start = i;
        break;
      }
    }
  }

  // Strip trailing ESC \
  if (end - start >= 2 && line[end - 2] === ESC && line[end - 1] === 0x5C) {
    end -= 2;
  }

  return start === 0 && end === line.length ? line : line.subarray(start, end);
}

// ---------------------------------------------------------------------------
// Escape decoder
// ---------------------------------------------------------------------------

function isOctalDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x37; // '0'..'7'
}

function octalValue(b: number): number {
  return b - 0x30; // '0' -> 0
}

function isHexDigit(b: number): number | null {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;       // '0'..'9'
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;   // 'A'..'F'
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;   // 'a'..'f'
  return null;
}

/**
 * Decode tmux's escape encoding in %output data.
 * Reference: section 3
 *
 * Handles: \NNN (octal), \xNN (hex), \\, \n, \r, \t
 * High bytes (>= 0x80) pass through verbatim.
 * Unknown \X passes backslash through, processes X next.
 */
function decodeOutputData(escaped: Buffer, start: number, end: number): Uint8Array {
  // Fast path: no backslash means no escapes
  let scanIdx = start;
  while (scanIdx < end) {
    if (escaped[scanIdx] === BACKSLASH) break;
    scanIdx++;
  }
  if (scanIdx === end) {
    return new Uint8Array(escaped.buffer, escaped.byteOffset + start, end - start);
  }

  // Slow path: decode escapes
  const out: number[] = [];
  let outIdx = 0;
  let i = start;

  while (i < end) {
    const c = escaped[i];
    if (c !== BACKSLASH || i + 1 >= end) {
      out[outIdx++] = c;
      i++;
      continue;
    }

    const next = escaped[i + 1];

    // \NNN — 3-digit octal
    if (isOctalDigit(next) && i + 3 < end
      && isOctalDigit(escaped[i + 2]) && isOctalDigit(escaped[i + 3])) {
      const value = (octalValue(next) << 6)
        | (octalValue(escaped[i + 2]) << 3)
        | octalValue(escaped[i + 3]);
      out[outIdx++] = value & 0xFF;
      i += 4;
      continue;
    }

    // \xNN — 2-digit hex
    if (next === 0x78 /* 'x' */ && i + 3 < end) {
      const hi = isHexDigit(escaped[i + 2]);
      const lo = isHexDigit(escaped[i + 3]);
      if (hi !== null && lo !== null) {
        out[outIdx++] = (hi << 4) | lo;
        i += 4;
        continue;
      }
    }

    // Named escapes
    if (next === 0x6E /* 'n' */) { out[outIdx++] = LF; i += 2; continue; }
    if (next === 0x72 /* 'r' */) { out[outIdx++] = CR; i += 2; continue; }
    if (next === 0x74 /* 't' */) { out[outIdx++] = 0x09; i += 2; continue; }
    if (next === BACKSLASH) { out[outIdx++] = BACKSLASH; i += 2; continue; }

    // Unknown \X — pass backslash through, process X next
    out[outIdx++] = BACKSLASH;
    i++;
  }

  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// Output parser (byte-oriented)
// ---------------------------------------------------------------------------

/**
 * Parse a %output line as raw bytes.
 * Reference: section 2.1, section 6.2
 *
 * Wire format: %output %<paneId> <data>
 */
function parseOutput(line: Buffer): OutputEvent | null {
  // We already know line starts with "%output " (8 bytes, indices 0-7)
  // Next must be '%' (pane ID prefix) at index 8
  if (line.length <= 8 || line[8] !== PERCENT) return null;

  // Find the space after paneId (start looking from index 9)
  let spaceIdx = -1;
  for (let i = 9; i < line.length; i++) {
    if (line[i] === 0x20) {
      spaceIdx = i;
      break;
    }
  }

  let paneId: string;
  let dataStart: number;
  let dataEnd: number;

  if (spaceIdx === -1) {
    // No space after paneId: "%output %0" with no trailing space/data
    // paneId extends from index 8 to end of line
    paneId = line.subarray(8, line.length).toString('ascii');
    return { type: 'output', paneId, data: new Uint8Array(0) };
  }

  paneId = line.subarray(8, spaceIdx).toString('ascii');
  dataStart = spaceIdx + 1;
  dataEnd = line.length;

  // Data can be empty (trailing space only)
  const data = decodeOutputData(line, dataStart, dataEnd);
  return { type: 'output', paneId, data };
}

// ---------------------------------------------------------------------------
// Structured event parser (string-based)
// ---------------------------------------------------------------------------

/**
 * Parse non-%output events from a decoded string line.
 * Reference: section 6.3
 */
function parseStructured(line: string): ControlEvent | null {
  // Must start with %
  if (line.length < 2 || line[0] !== '%') return null;

  const spaceIdx = line.indexOf(' ');
  const opcode = spaceIdx === -1 ? line : line.substring(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : line.substring(spaceIdx + 1);

  switch (opcode) {
    case '%session-changed': {
      // %session-changed $<sessionId> <name>
      const parts = args.split(' ');
      if (parts.length < 2 || !parts[0].startsWith('$')) return null;
      const sessionId = parts[0];
      const name = parts.slice(1).join(' ');
      return { type: 'session-changed', sessionId, name } as SessionChangedEvent;
    }

    case '%sessions-changed': {
      return { type: 'sessions-changed' } as SessionsChangedEvent;
    }

    case '%window-add': {
      // %window-add @<windowId>
      const trimmed = args.trim();
      if (!trimmed.startsWith('@')) return null;
      return {
        type: 'window-add',
        sessionId: '',
        windowId: trimmed,
        name: '',
      } as WindowAddEvent;
    }

    case '%window-close': {
      // %window-close @<windowId>
      const trimmed = args.trim();
      if (!trimmed.startsWith('@')) return null;
      return {
        type: 'window-close',
        sessionId: '',
        windowId: trimmed,
      } as WindowCloseEvent;
    }

    case '%window-renamed': {
      // %window-renamed @<windowId> <name>
      const parts = args.split(' ');
      if (parts.length < 2 || !parts[0].startsWith('@')) return null;
      return {
        type: 'window-renamed',
        sessionId: '',
        windowId: parts[0],
        name: parts.slice(1).join(' '),
      } as WindowRenamedEvent;
    }

    case '%layout-change': {
      // %layout-change @<windowId> <layout> [visible-layout] [flags]
      const firstSpace = args.indexOf(' ');
      if (firstSpace === -1) return null;
      const windowId = args.substring(0, firstSpace);
      if (!windowId.startsWith('@')) return null;

      const rest = args.substring(firstSpace + 1);
      // Only take the first layout token (space-separated)
      const layoutSpace = rest.indexOf(' ');
      const layout = layoutSpace === -1 ? rest : rest.substring(0, layoutSpace);

      return {
        type: 'layout-change',
        sessionId: '',
        windowId,
        layout,
      } as LayoutChangeEvent;
    }

    case '%pane-mode-changed': {
      // %pane-mode-changed %<paneId>
      const trimmed = args.trim();
      if (!trimmed.startsWith('%')) return null;
      return { type: 'pane-mode-changed', paneId: trimmed } as PaneModeChangedEvent;
    }

    case '%begin':
    case '%end':
    case '%error': {
      // %begin <time> <number> <flags>
      const parts = args.split(' ');
      if (parts.length < 3) return null;
      const time = Number(parts[0]);
      const number = Number(parts[1]);
      const flags = Number(parts[2]);
      if (isNaN(time) || isNaN(number) || isNaN(flags)) return null;

      const eventType = opcode === '%begin' ? 'begin'
        : opcode === '%end' ? 'end' : 'error';
      return { type: eventType, time, number, flags } as BeginEvent | EndEvent | ErrorEvent;
    }

    case '%client-detached': {
      return { type: 'client-detached' } as ClientDetachedEvent;
    }

    case '%exit': {
      // %exit [reason]
      const trimmed = args.trim();
      return { type: 'exit', reason: trimmed || null } as ExitEvent;
    }

    default:
      // Unknown opcode
      return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a single raw line from the tmux -CC control stream.
 *
 * @param line - Raw byte line (without trailing LF/CR)
 * @returns Parsed ControlEvent, or null for unknown/malformed lines
 *
 * Reference: section 6.1
 */
export function parseLine(line: Buffer): ControlEvent | null {
  if (line.length === 0) return null;

  // Strip DCS passthrough wrapper
  const normalized = normalizeControlLineBytes(line);

  // Must start with %
  if (normalized.length === 0 || normalized[0] !== PERCENT) return null;

  // Fast path for %output (byte-oriented)
  if (normalized.length >= OUTPUT_PREFIX.length) {
    let matches = true;
    for (let i = 0; i < OUTPUT_PREFIX.length; i++) {
      if (normalized[i] !== OUTPUT_PREFIX[i]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return parseOutput(normalized);
    }
  }

  // String-based path for all other events
  const decoded = normalized.toString('utf-8');
  return parseStructured(decoded);
}

// Export helpers for testing
export { normalizeControlLineBytes, decodeOutputData };
