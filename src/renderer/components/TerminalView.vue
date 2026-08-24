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
import type { ConnectionId, ShellId } from '../../shared/types';
import '@xterm/xterm/css/xterm.css';

const props = defineProps<{
  connectionId: ConnectionId;
  /** Command to run inside the PTY (e.g. `tmux attach -t main`). Omit for a bare shell. */
  command?: string;
  /** A key that, when changed, re-opens the shell (used to switch sessions). */
  sessionKey?: string;
}>();

/**
 * Terminal look & feel. Kept as a standalone object so the font/theme can be
 * swapped wholesale without touching the wiring below.
 */
const TERMINAL_OPTIONS: ITerminalOptions = {
  fontFamily: 'ui-monospace, "Cascadia Code", "Fira Code", monospace',
  fontSize: 13,
  cursorBlink: true,
  scrollback: 5000,
  theme: {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
  },
};

const containerEl = ref<HTMLDivElement | null>(null);
let term: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let shellId: ShellId | null = null;
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
/** True between mousedown inside the terminal and the mouse-up that ends it. */
let selecting = false;

async function openShell(): Promise<void> {
  if (!term || !containerEl.value) return;
  fitAddon?.fit();
  const cols = term.cols;
  const rows = term.rows;
  shellId = await api.shell.open({
    connectionId: props.connectionId,
    command: props.command,
    cols,
    rows,
  });
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
  // Push the current geometry at the freshly-opened shell: the bound onResize
  // only fires when xterm's own dimensions change, which a re-open does not do.
  void api.shell.resize(shellId, cols, rows);
  term.focus();
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
  if (shellId) {
    void api.shell.close(shellId);
    shellId = null;
  }
}

async function reopen(): Promise<void> {
  closeShell();
  term?.clear();
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
});

function onWindowResize(): void {
  fitAddon?.fit();
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
</script>

<template>
  <div ref="containerEl" class="terminal" />
</template>

<style scoped>
.terminal {
  width: 100%;
  height: 100%;
  padding: 6px;
  background: #1e1e2e;
  overflow: hidden;
}
.terminal :deep(.xterm) {
  height: 100%;
}
</style>
