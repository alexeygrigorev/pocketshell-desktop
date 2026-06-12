/**
 * PocketShell UI theme barrel export.
 *
 * Re-exports the public API of the theme layer.
 */

// Theme definition
export {
  PALETTE,
  STATUS_DOT_COLORS,
  POCKETSHELL_DARK_THEME,
  DENSE_LAYOUT_CSS,
} from './pocketshell-dark';
export type { ConnectionState } from './pocketshell-dark';

// Theme manager
export { ThemeManager } from './theme-manager';
export type { ColorMap } from './theme-manager';

// Status dots
export { getDotColor, getDotClass, renderDot } from './status-dots';

// Branding
export {
  APP_NAME,
  APP_VERSION,
  LOGO_SVG_PATH,
  BRANDING_CSS,
  getLogoSvg,
} from './branding';
