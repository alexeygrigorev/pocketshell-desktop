/**
 * PocketShell Dark color theme definition.
 *
 * Always-dark palette for v0.1.0. Provides a VS Code color theme
 * structure (JSON-like object) with dense dark colors optimized for
 * long terminal sessions and SSH workflows.
 */

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/** Core palette hex values. */
export const PALETTE = {
  background: '#1a1a2e',
  sidebar: '#16213e',
  editor: '#0f0f23',
  accent: '#0f3460',
  highlight: '#533483',
  statusGreen: '#00e676',
  statusRed: '#ff5252',
  statusAmber: '#ffc107',
  text: '#e0e0e0',
  mutedText: '#9e9e9e',
  border: '#2a2a4a',
  inputBackground: '#12122a',
  selectionBackground: '#53348355',
  listHoverBackground: '#1e1e3a',
  scrollbarSlider: '#3a3a5a',
  tabActiveBackground: '#0f3460',
  tabInactiveBackground: '#16213e',
  badgeBackground: '#533483',
  badgeForeground: '#e0e0e0',
} as const;

/** Status dot colors keyed by connection state. */
export const STATUS_DOT_COLORS: Record<ConnectionState, string> = {
  connected: PALETTE.statusGreen,
  disconnected: PALETTE.mutedText,
  connecting: PALETTE.statusAmber,
  error: PALETTE.statusRed,
};

/** Connection state values accepted by status-dot utilities. */
export type ConnectionState =
  | 'connected'
  | 'disconnected'
  | 'connecting'
  | 'error';

// ---------------------------------------------------------------------------
// VS Code Color Theme Structure
// ---------------------------------------------------------------------------

/**
 * Full VS Code color theme definition.
 *
 * Colors follow the VS Code color identifier convention so they can
 * be applied to a workbench via the theme API or serialized to JSON.
 */
export const POCKETSHELL_DARK_THEME = {
  name: 'PocketShell Dark',
  type: 'dark' as const,

  colors: {
    // --- Workbench chrome ---
    'activityBar.background': PALETTE.sidebar,
    'activityBar.foreground': PALETTE.text,
    'activityBarBadge.background': PALETTE.badgeBackground,
    'activityBarBadge.foreground': PALETTE.badgeForeground,
    'activityBar.inactiveForeground': PALETTE.mutedText,

    'sideBar.background': PALETTE.sidebar,
    'sideBar.foreground': PALETTE.text,
    'sideBarTitle.foreground': PALETTE.text,
    'sideBarSectionHeader.background': PALETTE.accent,
    'sideBarSectionHeader.foreground': PALETTE.text,

    'editor.background': PALETTE.editor,
    'editor.foreground': PALETTE.text,
    'editor.lineHighlightBackground': '#1a1a35',
    'editor.selectionBackground': PALETTE.selectionBackground,
    'editorLineNumber.foreground': PALETTE.mutedText,
    'editorLineNumber.activeForeground': PALETTE.text,
    'editorCursor.foreground': PALETTE.statusGreen,
    'editorWidget.background': PALETTE.sidebar,
    'editorWidget.foreground': PALETTE.text,

    'titleBar.activeBackground': PALETTE.background,
    'titleBar.activeForeground': PALETTE.text,
    'titleBar.inactiveBackground': PALETTE.background,
    'titleBar.inactiveForeground': PALETTE.mutedText,

    'statusBar.background': PALETTE.background,
    'statusBar.foreground': PALETTE.text,
    'statusBar.noFolderBackground': PALETTE.background,

    'panel.background': PALETTE.editor,
    'panel.border': PALETTE.border,
    'panelTitle.activeForeground': PALETTE.text,
    'panelTitle.inactiveForeground': PALETTE.mutedText,

    'terminal.background': PALETTE.editor,
    'terminal.foreground': PALETTE.text,
    'terminalCursor.foreground': PALETTE.statusGreen,

    'tab.activeBackground': PALETTE.tabActiveBackground,
    'tab.inactiveBackground': PALETTE.tabInactiveBackground,
    'tab.activeForeground': PALETTE.text,
    'tab.inactiveForeground': PALETTE.mutedText,
    'tab.border': PALETTE.border,

    'input.background': PALETTE.inputBackground,
    'input.foreground': PALETTE.text,
    'input.border': PALETTE.border,
    'input.placeholderForeground': PALETTE.mutedText,

    'list.hoverBackground': PALETTE.listHoverBackground,
    'list.activeSelectionBackground': PALETTE.accent,
    'list.activeSelectionForeground': PALETTE.text,
    'list.inactiveSelectionBackground': PALETTE.accent,
    'list.focusBackground': PALETTE.listHoverBackground,
    'list.highlightForeground': PALETTE.statusGreen,

    'scrollbarSlider.background': PALETTE.scrollbarSlider,
    'scrollbarSlider.hoverBackground': PALETTE.highlight,
    'scrollbarSlider.activeBackground': PALETTE.highlight,

    'badge.background': PALETTE.badgeBackground,
    'badge.foreground': PALETTE.badgeForeground,

    'focusBorder': PALETTE.highlight,
    'foreground': PALETTE.text,
    'descriptionForeground': PALETTE.mutedText,
    'errorForeground': PALETTE.statusRed,
    'widget.shadow': '#00000066',

    'dropdown.background': PALETTE.inputBackground,
    'dropdown.foreground': PALETTE.text,
    'dropdown.border': PALETTE.border,
  },

  tokenColors: [
    {
      scope: ['comment', 'punctuation.definition.comment'],
      settings: { foreground: PALETTE.mutedText, fontStyle: 'italic' },
    },
    {
      scope: ['string', 'string.quoted'],
      settings: { foreground: '#c3e88d' },
    },
    {
      scope: ['keyword', 'storage.type', 'storage.modifier'],
      settings: { foreground: '#c792ea' },
    },
    {
      scope: ['variable', 'variable.other'],
      settings: { foreground: PALETTE.text },
    },
    {
      scope: ['constant', 'variable.other.constant'],
      settings: { foreground: '#f78c6c' },
    },
    {
      scope: ['entity.name.function', 'support.function'],
      settings: { foreground: '#82aaff' },
    },
    {
      scope: ['entity.name.type', 'support.class'],
      settings: { foreground: '#ffcb6b' },
    },
    {
      scope: ['punctuation'],
      settings: { foreground: PALETTE.mutedText },
    },
    {
      scope: ['markup.heading'],
      settings: { foreground: PALETTE.statusGreen, fontStyle: 'bold' },
    },
    {
      scope: ['markup.bold'],
      settings: { fontStyle: 'bold' },
    },
    {
      scope: ['terminal.ansiGreen'],
      settings: { foreground: PALETTE.statusGreen },
    },
    {
      scope: ['terminal.ansiRed'],
      settings: { foreground: PALETTE.statusRed },
    },
    {
      scope: ['terminal.ansiYellow'],
      settings: { foreground: PALETTE.statusAmber },
    },
  ],
} as const;

// ---------------------------------------------------------------------------
// Dense / compact layout overrides
// ---------------------------------------------------------------------------

/**
 * CSS custom-property overrides that make list rows, tree items, and
 * panels more compact (dense layout). These can be injected into the
 * workbench style root.
 */
export const DENSE_LAYOUT_CSS: Record<string, string> = {
  '--pocketshell-list-row-height': '26px',
  '--pocketshell-tree-indent': '12px',
  '--pocketshell-panel-padding': '4px 8px',
  '--pocketshell-sidebar-padding': '4px',
  '--pocketshell-statusbar-height': '24px',
  '--pocketshell-tab-height': '30px',
  '--pocketshell-editor-padding-top': '2px',
  '--pocketshell-activitybar-width': '40px',
};
