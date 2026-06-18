<script setup lang="ts">
// TerminalView: an xterm.js terminal attached to an SSH shell channel.
//
// On mount, it opens a tracked shell (optionally running a command like
// `tmux attach -t <session>`) and wires xterm <-> the shell:
//   - shell stdout bytes -> xterm.write
//   - xterm user input   -> shell.input
//   - xterm resize       -> shell.resize
// On unmount it closes the shell.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
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

const containerEl = ref<HTMLDivElement | null>(null);
let term: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let shellId: ShellId | null = null;
let unsubscribeData: (() => void) | null = null;
let unsubscribeExit: (() => void) | null = null;

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
  // xterm -> shell
  term.onData((data) => {
    if (shellId) void api.shell.input(shellId, data);
  });
  term.onResize(({ cols, rows }) => {
    if (shellId) void api.shell.resize(shellId, cols, rows);
  });
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

onMounted(async () => {
  term = new Terminal({
    fontFamily: 'ui-monospace, "Cascadia Code", "Fira Code", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
    },
  });
  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());
  term.open(containerEl.value!);
  fitAddon.fit();
  await openShell();

  // Re-fit on window resize.
  window.addEventListener('resize', onWindowResize);
});

function onWindowResize(): void {
  fitAddon?.fit();
}

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize);
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
