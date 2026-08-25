<script setup lang="ts">
// TerminalView: an xterm.js terminal attached to an SSH shell channel.
//
// On mount, it opens a tracked shell (optionally running a command like
// `tmux attach -t <session>`) and wires xterm <-> the shell:
//   - shell stdout bytes -> xterm.write
//   - xterm user input   -> shell.input
//   - xterm resize       -> shell.resize
// On unmount it closes the shell.
//
// Clipboard: selecting with the mouse copies on mouse-up (see onDocumentMouseUp);
// Ctrl/Cmd-Shift-V and right-click paste.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Terminal, type IDisposable, type ITerminalOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { api } from '../ipc';
import { useShellsStore } from '../stores/shells';
import type { ConnectionId, ShellId } from '../../shared/types';
import '@xterm/xterm/css/xterm.css';

// The PTY this component owns is published to the shells store so other
// surfaces — the prompt composer, first of all — can write to the same pane.
// Ownership of the open/close lifecycle deliberately stays here; see the header
// comment of stores/shells.ts for why.
const shells = useShellsStore();

const props = defineProps<{
  connectionId: ConnectionId;
  /** Command to run inside the PTY (e.g. `tmux attach -t main`). Omit for a bare shell. */
  command?: string;
  /** A key that, when changed, re-opens the shell (used to switch sessions). */
  sessionKey?: string;
}>();

/**
 * Terminal look & feel, transcribed from the user's Windows Terminal config.
 * Kept as a standalone object so the font/theme can be swapped wholesale
 * without touching the wiring below. See docs/DESIGN.md §3.
 *
 * Source: %LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\
 *         LocalState\settings.json  (font face/size, bellStyle)
 *   plus  Windows Terminal 1.24 defaults.json  (everything the user's file
 *         leaves unset: the Campbell scheme, bar cursor, 8px padding,
 *         9001-line scrollback, grayscale AA, word delimiters).
 * The user's settings.json has "schemes": [] and no `colorScheme` key, so the
 * built-in default scheme — Campbell — is what they actually see.
 */
const TERMINAL_OPTIONS: ITerminalOptions = {
  // profiles.defaults.font.face = "Consolas"
  fontFamily: 'Consolas, "Cascadia Mono", ui-monospace, monospace',
  // profiles.defaults.font.size = 16. Windows Terminal reads that as points
  // (16pt = 21.33px at 96 DPI), but the user chose to take the number
  // literally as pixels here, so 16 it is. Mirrored by --term-font-size.
  fontSize: 16,
  fontWeight: 400,
  fontWeightBold: 700,
  // No `font.cellHeight` override, so Consolas' natural cell (~1.0em).
  lineHeight: 1.0,
  letterSpacing: 0,

  // defaults.json: cursorShape "bar". Windows Terminal blinks by default.
  cursorStyle: 'bar',
  cursorBlink: true,
  cursorInactiveStyle: 'outline',

  // defaults.json: historySize 9001, snapOnInput true.
  scrollback: 9001,
  scrollOnUserInput: true,

  // defaults.json: wordDelimiters — makes double-click word selection split
  // paths and punctuation exactly as it does in Windows Terminal.
  wordSeparator: ' /\\()"\'-.,:;<>~!@#$%^&*|+=[]{}~?│',

  drawBoldTextInBrightColors: true,
  // Campbell's dim blue (2.38:1) and magenta (2.44:1) are unreadable on its
  // own background; this lifts only those and leaves the rest untouched.
  minimumContrastRatio: 3,

  // Built-in "Campbell" scheme, verbatim. Windows Terminal names the
  // magenta slot "purple"; xterm calls it `magenta`.
  theme: {
    background: '#0C0C0C',
    foreground: '#CCCCCC',
    cursor: '#FFFFFF',
    cursorAccent: '#0C0C0C',
    // Campbell defines no selectionBackground; Windows Terminal falls back to
    // white drawn at ~50% alpha. Kept translucent so text stays readable.
    selectionBackground: 'rgba(255, 255, 255, 0.35)',
    selectionInactiveBackground: 'rgba(255, 255, 255, 0.18)',
    black: '#0C0C0C',
    red: '#C50F1F',
    green: '#13A10E',
    yellow: '#C19C00',
    blue: '#0037DA',
    magenta: '#881798',
    cyan: '#3A96DD',
    white: '#CCCCCC',
    brightBlack: '#767676',
    brightRed: '#E74856',
    brightGreen: '#16C60C',
    brightYellow: '#F9F1A5',
    brightBlue: '#3B78FF',
    brightMagenta: '#B4009E',
    brightCyan: '#61D6D6',
    brightWhite: '#F2F2F2',
  },
};

const containerEl = ref<HTMLDivElement | null>(null);
let term: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let shellId: ShellId | null = null;
/** The key `shellId` is currently published under, so a re-open can retract it. */
let registeredKey: string | null = null;
let unsubscribeData: (() => void) | null = null;
let unsubscribeExit: (() => void) | null = null;
/**
 * xterm-side handlers. These are bound ONCE against the stable `term` and read
 * the current `shellId` from the closure. Binding them per-shell (as an earlier
 * version did) stacked a new onData/onResize on every session switch, so each
 * keystroke — and each reply to tmux's `ESC[>c` device-attributes probe — was
 * sent to the PTY N times, which is what leaked `0;276;0c` into the output.
 */
let termDisposables: IDisposable[] = [];
/**
 * Refits when the CONTAINER changes size, not only when the window does. The
 * prompt composer docks below this pane and grows/shrinks/hides underneath it,
 * which resizes the terminal without any window resize event — without this the
 * xterm canvas keeps its old row count and either clips the tmux status bar or
 * leaves dead black space below it.
 */
let resizeObserver: ResizeObserver | null = null;
/** Coalesces a burst of resize callbacks into one fit per frame. */
let fitFrame = 0;
/** True between mousedown inside the terminal and the mouse-up that ends it. */
let selecting = false;

async function openShell(): Promise<void> {
  if (!term || !containerEl.value) return;
  fitAddon?.fit();
  const cols = term.cols;
  const rows = term.rows;
  try {
    shellId = await api.shell.open({
      connectionId: props.connectionId,
      command: props.command,
      cols,
      rows,
    });
  } catch (e) {
    // A rejection here used to escape into `onMounted`'s promise, where
    // nothing was waiting for it: the pane stayed blank and the user was told
    // nothing at all — indistinguishable from a session that opened and simply
    // had no output yet. The PTY is the only surface this component owns, so
    // the failure is written INTO it. Nothing else is torn down: no shellId was
    // registered, and the retry path (`reopen`) is still armed.
    shellId = null;
    term.write(`\r\n\u001b[31mCould not open a shell: ${describe(e)}\u001b[0m\r\n`);
    return;
  }
  // shell -> xterm
  unsubscribeData = api.shell.onData(({ shellId: id, data }) => {
    if (id === shellId && term) {
      term.write(data);
    }
  });
  unsubscribeExit = api.shell.onExited(({ shellId: id }) => {
    if (id === shellId && term) {
      term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
    }
  });
  // Publish it before the first byte can be typed at it.
  registeredKey = props.sessionKey ?? '';
  shells.register(registeredKey, shellId);
  // Push the current geometry at the freshly-opened shell: the bound onResize
  // only fires when xterm's own dimensions change, which a re-open does not do.
  void api.shell.resize(shellId, cols, rows);
  term.focus();
}

/** Message text for a thrown value, however it was thrown. */
function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

function closeShell(): void {
  if (unsubscribeData) {
    unsubscribeData();
    unsubscribeData = null;
  }
  if (unsubscribeExit) {
    unsubscribeExit();
    unsubscribeExit = null;
  }
  if (registeredKey !== null) {
    shells.unregister(registeredKey, shellId ?? undefined);
    registeredKey = null;
  }
  if (shellId) {
    void api.shell.close(shellId);
    shellId = null;
  }
}

async function reopen(): Promise<void> {
  closeShell();
  // `reset()`, not `clear()`. clear() only empties the scrollback — it leaves
  // every DEC private mode set, and mouse tracking (1000/1002/1003 + SGR 1006)
  // is the one that matters. tmux turns mouse reporting ON when it attaches and
  // OFF when it exits cleanly; a session that dies, is killed, or whose attach
  // fails never sends the OFF. The mode then survives into the next shell this
  // component opens, where nothing is consuming mouse reports — so the wheel
  // and click-drag get encoded as `\x1b[<0;2;1M` and typed at the prompt, which
  // the shell echoes as literal `0;2;1M`, and drag-select stops working because
  // xterm is claiming the drag for reporting. reset() clears modes with it.
  term?.reset();
  await openShell();
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

/** Copy `text` to the system clipboard. Silent on failure — never throws. */
async function copyToClipboard(text: string): Promise<void> {
  if (!text) return; // a bare click clears the selection; don't blank the clipboard
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard permission denied / API unavailable. Nothing useful to do
    // from the renderer; the selection is still there for a manual Ctrl-C.
  }
}

/** Read the system clipboard and feed it to the shell as pasted input. */
async function pasteFromClipboard(): Promise<void> {
  if (!term) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text) term.paste(text);
  } catch {
    // Same as above: degrade quietly. Ctrl-V still works via xterm's own
    // handling of the browser `paste` event.
  }
}

function onTerminalMouseDown(e: MouseEvent): void {
  if (e.button === 0) selecting = true;
}

/**
 * Copy on selection *settle*. Listening on the document (gated by `selecting`)
 * means a drag that ends outside the terminal still copies, while unrelated
 * clicks elsewhere in the app do not re-copy a stale selection. Using mouse-up
 * rather than xterm's onSelectionChange avoids hammering the clipboard on every
 * tick of the drag.
 */
function onDocumentMouseUp(): void {
  if (!selecting) return;
  selecting = false;
  if (!term || !term.hasSelection()) return;
  void copyToClipboard(term.getSelection());
}

function onTerminalContextMenu(e: MouseEvent): void {
  e.preventDefault();
  void pasteFromClipboard();
}

/**
 * Intercept the clipboard chords before xterm turns them into input bytes.
 * Returning false tells xterm to leave the event alone.
 */
function onCustomKey(e: KeyboardEvent): boolean {
  if (e.type !== 'keydown') return true;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
    void pasteFromClipboard();
    return false;
  }
  if (mod && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
    if (term?.hasSelection()) {
      void copyToClipboard(term.getSelection());
      return false;
    }
  }
  return true;
}

onMounted(async () => {
  term = new Terminal(TERMINAL_OPTIONS);
  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());
  term.open(containerEl.value!);
  fitAddon.fit();

  // xterm -> shell. Bound once, against the terminal's whole lifetime.
  termDisposables = [
    term.onData((data) => {
      if (shellId) void api.shell.input(shellId, data);
    }),
    term.onResize(({ cols, rows }) => {
      if (shellId) void api.shell.resize(shellId, cols, rows);
    }),
  ];
  term.attachCustomKeyEventHandler(onCustomKey);
  containerEl.value?.addEventListener('mousedown', onTerminalMouseDown);
  containerEl.value?.addEventListener('contextmenu', onTerminalContextMenu);
  document.addEventListener('mouseup', onDocumentMouseUp);

  await openShell();

  // Re-fit on window resize.
  window.addEventListener('resize', onWindowResize);
  if (typeof ResizeObserver !== 'undefined' && containerEl.value) {
    resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(containerEl.value);
  }
});

function onWindowResize(): void {
  scheduleFit();
}

/**
 * Fit once per animation frame. `fit()` writes to xterm's dimensions, which the
 * ResizeObserver can observe again — coalescing keeps that from looping and
 * keeps a drag-resize of the composer cheap.
 */
function scheduleFit(): void {
  if (fitFrame) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    // Skip degenerate geometry: a v-show'd pane measures 0 and fit() would
    // then push a 1x1 PTY at the remote.
    if (!containerEl.value?.clientHeight || !containerEl.value.clientWidth) return;
    fitAddon?.fit();
  });
}

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize);
  document.removeEventListener('mouseup', onDocumentMouseUp);
  containerEl.value?.removeEventListener('mousedown', onTerminalMouseDown);
  containerEl.value?.removeEventListener('contextmenu', onTerminalContextMenu);
  for (const d of termDisposables) d.dispose();
  termDisposables = [];
  closeShell();
  term?.dispose();
  term = null;
});

// Re-open the shell when the session key changes (switching attached session).
watch(
  () => props.sessionKey,
  () => {
    void reopen();
  },
);

/**
 * Lets the workspace hand focus back to the pane — the Escape ladder's third
 * rung blurs the composer draft and returns the user to the terminal
 * (docs/COMPOSER.md §12.2).
 */
defineExpose({ focus: (): void => term?.focus() });
</script>

<template>
  <div ref="containerEl" class="terminal" />
</template>

<style scoped>
.terminal {
  width: 100%;
  height: 100%;
  /* Windows Terminal defaults.json: padding "8, 8, 8, 8" */
  padding: var(--term-padding);
  background: var(--term-bg);
  overflow: hidden;
  /* Windows Terminal defaults.json: antialiasingMode "grayscale" */
  -webkit-font-smoothing: antialiased;
}
.terminal :deep(.xterm) {
  height: 100%;
}
</style>
