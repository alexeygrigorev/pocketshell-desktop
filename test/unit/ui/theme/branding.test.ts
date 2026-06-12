/**
 * Unit tests for PocketShell branding constants.
 *
 * Validates that branding data, the logo SVG, and branding CSS are
 * well-formed and accessible.
 */
import { describe, it, expect } from 'vitest';
import {
  APP_NAME,
  APP_VERSION,
  LOGO_SVG_PATH,
  BRANDING_CSS,
  getLogoSvg,
} from '../../../../src/ui/theme/branding';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('branding', () => {

  // -----------------------------------------------------------------------
  // APP_NAME
  // -----------------------------------------------------------------------

  describe('APP_NAME', () => {
    it('is PocketShell', () => {
      expect(APP_NAME).toBe('PocketShell');
    });

    it('is a non-empty string', () => {
      expect(APP_NAME.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // APP_VERSION
  // -----------------------------------------------------------------------

  describe('APP_VERSION', () => {
    it('is a semver-like string', () => {
      expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('is 0.1.0 for the initial release', () => {
      expect(APP_VERSION).toBe('0.1.0');
    });
  });

  // -----------------------------------------------------------------------
  // LOGO_SVG_PATH
  // -----------------------------------------------------------------------

  describe('LOGO_SVG_PATH', () => {
    it('is a non-empty string', () => {
      expect(LOGO_SVG_PATH.length).toBeGreaterThan(0);
    });

    it('starts with M (SVG move-to)', () => {
      expect(LOGO_SVG_PATH.startsWith('M')).toBe(true);
    });

    it('contains only valid SVG path characters', () => {
      expect(LOGO_SVG_PATH).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9\s,.-]+$/);
    });
  });

  // -----------------------------------------------------------------------
  // BRANDING_CSS
  // -----------------------------------------------------------------------

  describe('BRANDING_CSS', () => {
    it('is a non-empty string', () => {
      expect(BRANDING_CSS.length).toBeGreaterThan(0);
    });

    it('contains the logo class', () => {
      expect(BRANDING_CSS).toContain('.pocketshell-logo');
    });

    it('contains the title class', () => {
      expect(BRANDING_CSS).toContain('.pocketshell-title');
    });

    it('contains the version badge class', () => {
      expect(BRANDING_CSS).toContain('.pocketshell-version-badge');
    });

    it('contains the branding container class', () => {
      expect(BRANDING_CSS).toContain('.pocketshell-branding');
    });
  });

  // -----------------------------------------------------------------------
  // getLogoSvg()
  // -----------------------------------------------------------------------

  describe('getLogoSvg', () => {
    it('returns an SVG element string', () => {
      const svg = getLogoSvg();
      expect(svg).toMatch(/^<svg .*><\/svg>$/);
    });

    it('includes the pocketshell-logo class', () => {
      expect(getLogoSvg()).toContain('class="pocketshell-logo"');
    });

    it('includes the path data', () => {
      expect(getLogoSvg()).toContain(LOGO_SVG_PATH);
    });

    it('includes the SVG namespace', () => {
      expect(getLogoSvg()).toContain('xmlns="http://www.w3.org/2000/svg"');
    });
  });
});
