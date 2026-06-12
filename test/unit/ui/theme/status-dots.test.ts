/**
 * Unit tests for StatusDot utilities.
 *
 * Validates color mapping, CSS class naming, and HTML rendering for
 * each connection state.
 */
import { describe, it, expect } from 'vitest';
import { getDotColor, getDotClass, renderDot } from '../../../../src/ui/theme/status-dots';
import { STATUS_DOT_COLORS } from '../../../../src/ui/theme/pocketshell-dark';
import type { ConnectionState } from '../../../../src/ui/theme/pocketshell-dark';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StatusDot', () => {

  // -----------------------------------------------------------------------
  // getDotColor()
  // -----------------------------------------------------------------------

  describe('getDotColor', () => {
    it('returns green for connected', () => {
      expect(getDotColor('connected')).toBe('#00e676');
    });

    it('returns gray for disconnected', () => {
      expect(getDotColor('disconnected')).toBe('#9e9e9e');
    });

    it('returns amber for connecting', () => {
      expect(getDotColor('connecting')).toBe('#ffc107');
    });

    it('returns red for error', () => {
      expect(getDotColor('error')).toBe('#ff5252');
    });

    it('matches STATUS_DOT_COLORS for every state', () => {
      const states = Object.keys(STATUS_DOT_COLORS) as ConnectionState[];
      for (const state of states) {
        expect(getDotColor(state)).toBe(STATUS_DOT_COLORS[state]);
      }
    });
  });

  // -----------------------------------------------------------------------
  // getDotClass()
  // -----------------------------------------------------------------------

  describe('getDotClass', () => {
    it('returns status-connected for connected', () => {
      expect(getDotClass('connected')).toBe('status-connected');
    });

    it('returns status-disconnected for disconnected', () => {
      expect(getDotClass('disconnected')).toBe('status-disconnected');
    });

    it('returns status-connecting-pulse for connecting', () => {
      expect(getDotClass('connecting')).toBe('status-connecting-pulse');
    });

    it('returns status-error for error', () => {
      expect(getDotClass('error')).toBe('status-error');
    });

    it('never returns an empty string', () => {
      const states: ConnectionState[] = ['connected', 'disconnected', 'connecting', 'error'];
      for (const state of states) {
        expect(getDotClass(state).length).toBeGreaterThan(0);
      }
    });
  });

  // -----------------------------------------------------------------------
  // renderDot()
  // -----------------------------------------------------------------------

  describe('renderDot', () => {
    it('returns a span element with status-dot class', () => {
      const html = renderDot('connected');
      expect(html).toContain('class="status-dot');
    });

    it('includes the state-specific class', () => {
      expect(renderDot('connected')).toContain('status-connected');
      expect(renderDot('disconnected')).toContain('status-disconnected');
      expect(renderDot('connecting')).toContain('status-connecting-pulse');
      expect(renderDot('error')).toContain('status-error');
    });

    it('includes inline background color', () => {
      expect(renderDot('connected')).toContain('style="background:#00e676"');
      expect(renderDot('disconnected')).toContain('style="background:#9e9e9e"');
      expect(renderDot('connecting')).toContain('style="background:#ffc107"');
      expect(renderDot('error')).toContain('style="background:#ff5252"');
    });

    it('wraps content in a span element', () => {
      const html = renderDot('connected');
      expect(html).toMatch(/^<span .*><\/span>$/);
    });
  });
});
