/**
 * Unit tests for ThemeManager.
 *
 * Validates theme application, color queries, status-color mapping,
 * dark-mode flag, and change-listener lifecycle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThemeManager } from '../../../../src/ui/theme/theme-manager';
import { PALETTE, STATUS_DOT_COLORS } from '../../../../src/ui/theme/pocketshell-dark';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ThemeManager', () => {
  let manager: ThemeManager;

  beforeEach(() => {
    manager = new ThemeManager();
  });

  // -----------------------------------------------------------------------
  // apply()
  // -----------------------------------------------------------------------

  describe('apply', () => {
    it('marks the theme as applied', () => {
      expect(manager.isApplied()).toBe(false);
      manager.apply();
      expect(manager.isApplied()).toBe(true);
    });

    it('notifies registered change listeners', () => {
      const listener = vi.fn();
      manager.onChange(listener);
      manager.apply();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('notifies multiple listeners', () => {
      const a = vi.fn();
      const b = vi.fn();
      manager.onChange(a);
      manager.onChange(b);
      manager.apply();
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it('does not notify unregistered listeners', () => {
      const listener = vi.fn();
      const unsub = manager.onChange(listener);
      unsub();
      manager.apply();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // getColors()
  // -----------------------------------------------------------------------

  describe('getColors', () => {
    it('returns the full palette', () => {
      const colors = manager.getColors();
      expect(colors).toEqual(PALETTE);
    });

    it('includes the background color', () => {
      expect(manager.getColors().background).toBe('#1a1a2e');
    });

    it('includes the editor color', () => {
      expect(manager.getColors().editor).toBe('#0f0f23');
    });

    it('includes the accent color', () => {
      expect(manager.getColors().accent).toBe('#0f3460');
    });
  });

  // -----------------------------------------------------------------------
  // getStatusColor()
  // -----------------------------------------------------------------------

  describe('getStatusColor', () => {
    it('returns green for connected', () => {
      expect(manager.getStatusColor('connected')).toBe('#00e676');
    });

    it('returns gray for disconnected', () => {
      expect(manager.getStatusColor('disconnected')).toBe('#9e9e9e');
    });

    it('returns amber for connecting', () => {
      expect(manager.getStatusColor('connecting')).toBe('#ffc107');
    });

    it('returns red for error', () => {
      expect(manager.getStatusColor('error')).toBe('#ff5252');
    });

    it('matches STATUS_DOT_COLORS for every state', () => {
      const states = Object.keys(STATUS_DOT_COLORS) as Array<keyof typeof STATUS_DOT_COLORS>;
      for (const state of states) {
        expect(manager.getStatusColor(state)).toBe(STATUS_DOT_COLORS[state]);
      }
    });
  });

  // -----------------------------------------------------------------------
  // isDark()
  // -----------------------------------------------------------------------

  describe('isDark', () => {
    it('always returns true', () => {
      expect(manager.isDark()).toBe(true);
    });

    it('returns true even before apply', () => {
      expect(manager.isApplied()).toBe(false);
      expect(manager.isDark()).toBe(true);
    });

    it('returns true after apply', () => {
      manager.apply();
      expect(manager.isDark()).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // getThemeDefinition()
  // -----------------------------------------------------------------------

  describe('getThemeDefinition', () => {
    it('returns the theme definition with name PocketShell Dark', () => {
      const def = manager.getThemeDefinition();
      expect(def.name).toBe('PocketShell Dark');
    });

    it('declares type dark', () => {
      expect(manager.getThemeDefinition().type).toBe('dark');
    });

    it('includes workbench colors', () => {
      const colors = manager.getThemeDefinition().colors;
      expect(colors['editor.background']).toBe('#0f0f23');
      expect(colors['sideBar.background']).toBe('#16213e');
      expect(colors['activityBar.background']).toBe('#16213e');
    });

    it('includes token colors', () => {
      const tokenColors = manager.getThemeDefinition().tokenColors;
      expect(tokenColors.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // getDenseLayoutCSS()
  // -----------------------------------------------------------------------

  describe('getDenseLayoutCSS', () => {
    it('returns CSS custom properties', () => {
      const css = manager.getDenseLayoutCSS();
      expect(css['--pocketshell-list-row-height']).toBe('26px');
      expect(css['--pocketshell-statusbar-height']).toBe('24px');
    });
  });

  // -----------------------------------------------------------------------
  // onChange() unsubscribe
  // -----------------------------------------------------------------------

  describe('onChange unsubscribe', () => {
    it('returned function removes the listener', () => {
      const listener = vi.fn();
      const unsub = manager.onChange(listener);

      manager.apply();
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
      manager.apply();
      expect(listener).toHaveBeenCalledTimes(1); // not called again
    });

    it('does not break when unsubscribing an already-removed listener', () => {
      const listener = vi.fn();
      const unsub = manager.onChange(listener);
      unsub();
      unsub(); // second call is a no-op, should not throw
      manager.apply();
      expect(listener).toHaveBeenCalledTimes(0);
    });
  });
});
