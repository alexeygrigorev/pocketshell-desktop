/**
 * PocketShell branding constants.
 *
 * Central place for the app name, version placeholder, logo SVG, and
 * branding CSS. Pure data — no DOM dependency.
 */

// ---------------------------------------------------------------------------
// Branding data
// ---------------------------------------------------------------------------

/** Application display name. */
export const APP_NAME = 'PocketShell';

/** Version placeholder — replaced at build time. */
export const APP_VERSION = '0.1.0';

/**
 * Simple terminal-icon SVG path data.
 *
 * A 24x24 viewBox terminal icon with a prompt character and a
 * horizontal line representing the terminal body.
 */
export const LOGO_SVG_PATH =
  'M4 4h16v16H4V4zm1 3l4 3-4 3M11 14h6';

/**
 * Inline CSS for branding elements (logo, title, version badge).
 *
 * Intended to be injected into the workbench style root alongside
 * the theme colors.
 */
export const BRANDING_CSS = `
.pocketshell-logo {
  width: 24px;
  height: 24px;
  fill: #e0e0e0;
}

.pocketshell-title {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
  font-weight: 600;
  color: #e0e0e0;
  letter-spacing: 0.3px;
}

.pocketshell-version-badge {
  font-size: 10px;
  color: #9e9e9e;
  padding: 1px 4px;
  border: 1px solid #2a2a4a;
  border-radius: 3px;
}

.pocketshell-branding {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
}
`;

/**
 * Returns the full SVG markup for the PocketShell logo.
 *
 * @returns SVG element string.
 */
export function getLogoSvg(): string {
  return `<svg class="pocketshell-logo" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="${LOGO_SVG_PATH}"/></svg>`;
}
