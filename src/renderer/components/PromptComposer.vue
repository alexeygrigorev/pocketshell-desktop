<script setup lang="ts">
// PromptComposer: the app's primary interaction surface — compose a prompt,
// stage attachments, submit it into the session's tmux pane.
//
// CHROME: this is a FLOATING card, not a phone bottom sheet and no longer a
// docked bar. It hovers over the bottom-right of the session body — inset from
// the edges on every side, its own rounded corners, an elevation shadow all
// round, and only as wide as a prompt needs (~80 mono columns) so terminal
// output stays readable beside it. A sash on its top edge resizes it
// (row-resize cursor, min 190px, max 80% of the body), its height is remembered
// per session across hide/show, and a small toolbar row carries the panel title
// on the left with maximize/restore and close on the right. `Ctrl+\`` toggles
// it, matching VS Code muscle memory; when it is closed it shrinks to a rail
// PILL in the same corner, so the affordance never teleports and a preserved
// draft can always be found by eye.
//
// The card overlays the terminal instead of splitting the pane with it, and
// that is the point: see the block comment on `.composer-dock` in
// SessionWorkspaceView.vue. The pane permanently reserves the pill's height
// plus its inset, so the terminal's ROW COUNT never changes when the composer
// opens, closes or is dragged — no SSH window-change, no remote tmux reflow.
//
// It is mounted ONCE per session workspace, outside the tab body, so the draft,
// the caret and the staged tiles survive a Terminal/Conversation tab switch.
// The draft, its attachments and the dragged height live in stores/composer.ts
// keyed by session, so switching sessions swaps records rather than destroying
// a draft; open-vs-closed does NOT, because that is a preference about the tool
// rather than a fact about a session (§12).
//
// Three deliberate divergences from the Android original (docs/COMPOSER.md):
//
//  1. §12 — a third `hidden` mode that leaves a rail pill behind, instead of the
//     phone's "the sheet is simply gone". A preserved "Not sent" draft must stay
//     discoverable; the pill carries a draft dot and an attachment count.
//  2. §12.3 — a SUCCESSFUL send does NOT hide the composer. The phone dismisses
//     its sheet on delivery because a modal sheet occludes the terminal on a
//     phone screen; here the composer is where the user works, so it stays open
//     and focused, ready for the next prompt.
//  3. §16.2 — the payload is bracketed-paste framed by this renderer. Android
//     gets that for free from `tmux -CC` control mode; we write into a plain PTY
//     running `tmux attach`, and without the framing every line of an
//     `Attached files:` block becomes a separate agent prompt.
//
// What it does NOT do, and must not grow: it never mutates the draft when you
// attach something (the paths are folded in at send time only, §5.1), it never
// clears the draft optimistically on send (#745), and Escape never destroys
// work — only Discard does (§4.3).
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api } from '../ipc';
import { useComposerStore, type ComposerSessionState } from '../stores/composer';
import { useShellsStore } from '../stores/shells';
import ComposerAttachmentTiles from './ComposerAttachmentTiles.vue';
import SlashCommandDropdown from './SlashCommandDropdown.vue';
import AppIcon from './AppIcon.vue';
import OverlayPanel from './OverlayPanel.vue';
import DoodleCanvas from './DoodleCanvas.vue';
import RemoteImagePicker from './RemoteImagePicker.vue';
import { COMPOSER_STRINGS, slashQueryFor, insertCommandText } from '../../shared/composerText';
import {
  composerTiming,
  deliverPayload,
  sendRoute,
  type ComposerAgentKind,
} from '../../shared/composerSend';
import { filteredCommands, insertionTextFor, type AgentCommand } from '../../shared/agentCommands';
import type { AttachmentSource, ConnectionId } from '../../shared/types';

const props = defineProps<{
  connectionId: ConnectionId;
  /** Session name — the composer's identity, and the attachment scope key. */
  sessionName: string;
  /** True while the Conversation tab is selected (send routing, §16.3). */
  viewingConversation?: boolean;
  /** The engine running in this pane. Null until agent detection exists (§25.5). */
  agentKind?: ComposerAgentKind | null;
  /** False while the SSH connection is down — advisory only, never a block (§9). */
  connected?: boolean;
}>();

const emit = defineEmits<{ (e: 'focus-terminal'): void }>();

const composer = useComposerStore();
const shells = useShellsStore();

/** Panel height before the user has ever dragged it. */
const DEFAULT_HEIGHT = 240;
/**
 * Floor. Sized so that AT the floor the toolbar, two lines of draft, the tile
 * strip and the Send row all still fit — verified from
 * docs/screenshots/composer-03-min-height.png, where the previous 150px floor
 * squeezed the textarea into a clipped sliver.
 */
const MIN_HEIGHT = 190;
/**
 * VS Code caps its panel at ~80% of the editor area, and so do we: at 85% the
 * Conversation tab above it lost its empty state entirely
 * (docs/screenshots/composer-11-conversation-tab.png), which is the one thing a
 * split panel must never do.
 */
const MAX_HEIGHT_FRACTION = 0.8;

const rootEl = ref<HTMLDivElement | null>(null);
const draftEl = ref<HTMLTextAreaElement | null>(null);

/** `${connectionId}/${sessionName}` — mirrors the phone's `"$hostId/$sessionName"`. */
const key = computed(() => composer.targetKey(props.connectionId, props.sessionName));

watch(key, (k) => composer.ensure(k), { immediate: true });

const FALLBACK: ComposerSessionState = {
  draft: '',
  attachments: [],
  error: null,
  sendInFlight: false,
  uploadingCount: 0,
  connectionDegraded: false,
  height: null,
  caret: 0,
};

const state = computed<ComposerSessionState>(() => composer.states[key.value] ?? FALLBACK);
/** App-level, not per session — see the store's header comment. */
const mode = computed(() => composer.mode);
const attachments = computed(() => state.value.attachments);

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

const caret = ref(0);
/** Escape closes the dropdown without touching the text, so it needs a latch. */
const slashDismissed = ref(false);
const activeCommand = ref(0);

const slashQuery = computed(() => slashQueryFor(state.value.draft, caret.value));
const slashCommands = computed<AgentCommand[]>(() =>
  slashQuery.value === null ? [] : filteredCommands(props.agentKind ?? null, slashQuery.value),
);
const slashOpen = computed(() => !slashDismissed.value && slashCommands.value.length > 0);

watch(slashQuery, () => {
  activeCommand.value = 0;
});

function acceptCommand(cmd: AgentCommand): void {
  const [text, newCaret] = insertCommandText(state.value.draft, insertionTextFor(cmd));
  composer.setDraft(key.value, text, newCaret);
  caret.value = newCaret;
  slashDismissed.value = true;
  void nextTick(() => {
    const el = draftEl.value;
    if (!el) return;
    el.focus();
    el.setSelectionRange(newCaret, newCaret);
  });
}

/** The `/` toolbar button is not a second palette: it seeds a leading `/`. */
function onSlashButton(): void {
  const [text, newCaret] = insertCommandText(state.value.draft, '/');
  composer.setDraft(key.value, text, newCaret);
  caret.value = newCaret;
  slashDismissed.value = false;
  focusDraft(newCaret);
}

// ---------------------------------------------------------------------------
// Draft editing
// ---------------------------------------------------------------------------

function syncCaret(): void {
  const el = draftEl.value;
  if (!el) return;
  caret.value = el.selectionStart;
  composer.setCaret(key.value, el.selectionStart);
}

function onInput(e: Event): void {
  const el = e.target as HTMLTextAreaElement;
  slashDismissed.value = false;
  composer.setDraft(key.value, el.value, el.selectionStart);
  caret.value = el.selectionStart;
}

function focusDraft(position?: number): void {
  void nextTick(() => {
    const el = draftEl.value;
    if (!el) return;
    el.focus();
    const at = position ?? state.value.caret;
    const clamped = Math.min(at, el.value.length);
    el.setSelectionRange(clamped, clamped);
  });
}

// Switching sessions swaps which record we render; restore that record's caret.
watch(
  () => props.sessionName,
  () => {
    caret.value = state.value.caret;
    slashDismissed.value = false;
    if (mode.value !== 'hidden') focusDraft();
  },
);

// Advisory "connection lost" row (§9): it never gates Send — a composed prompt
// is worth reconnecting for, which is why send is connect-on-action.
watch(
  () => props.connected,
  (connected) => composer.setConnectionDegraded(key.value, connected === false),
  { immediate: true },
);

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

const dragActive = ref(false);

async function stageSources(
  sources: AttachmentSource[],
  previews?: (string | undefined)[],
): Promise<void> {
  if (sources.length === 0) return;
  await composer.stage(key.value, {
    connectionId: props.connectionId,
    scopeKey: props.sessionName,
    sources,
    ...(previews ? { previews } : {}),
  });
}

/** A local preview URL for image tiles. Never persisted. */
function previewFor(file: File): string | undefined {
  if (!file.type.startsWith('image/')) return undefined;
  try {
    return URL.createObjectURL(file);
  } catch {
    return undefined;
  }
}

/** Read a File into a source. Prefers the path when Electron exposes one. */
async function sourceFor(file: File): Promise<AttachmentSource> {
  const path = (file as File & { path?: string }).path;
  if (typeof path === 'string' && path !== '') {
    return { kind: 'file', path, name: file.name || null, mimeType: file.type || null };
  }
  // Electron >= 32 dropped `File.path`; a dropped file is read here instead and
  // crosses the bridge as bytes. Same staging path either way.
  const data = new Uint8Array(await file.arrayBuffer());
  return { kind: 'bytes', data, name: file.name || null, mimeType: file.type || null };
}

async function stageFiles(files: File[]): Promise<void> {
  const sources: AttachmentSource[] = [];
  const previews: (string | undefined)[] = [];
  for (const file of files) {
    sources.push(await sourceFor(file));
    previews.push(previewFor(file));
  }
  await stageSources(sources, previews);
}

async function onAttachClick(): Promise<void> {
  const paths = await api.attachments.pickFiles({ title: 'Attach to prompt', multiple: true });
  if (paths.length === 0) return; // cancelled
  await stageSources(paths.map((path) => ({ kind: 'file', path })));
}

/**
 * Paste-to-attach (§23.4): a screenshot on the clipboard becomes a tile, plain
 * text pastes normally. This is the single biggest desktop ergonomics win over
 * the phone, which can only attach through the system file picker.
 */
async function onPaste(e: ClipboardEvent): Promise<void> {
  const files = Array.from(e.clipboardData?.files ?? []);
  if (files.length === 0) return;
  e.preventDefault();
  await stageFiles(files);
}

function onDragOver(e: DragEvent): void {
  if (!e.dataTransfer) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  dragActive.value = true;
}

function onDragLeave(e: DragEvent): void {
  if (rootEl.value?.contains(e.relatedTarget as Node | null)) return;
  dragActive.value = false;
}

async function onDrop(e: DragEvent): Promise<void> {
  e.preventDefault();
  dragActive.value = false;
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length === 0) return;
  await stageFiles(files);
}

// ---------------------------------------------------------------------------
// Doodle / annotate
//
// Four sources, one canvas. Whatever the origin, the image reaches
// DoodleCanvas as a `data:` URL and leaves it as PNG bytes, which drop
// straight into the `{kind:'bytes'}` staging path the clipboard already uses.
// No new upload code, no new remote-path logic — an annotated screenshot is
// an attachment like any other by the time it leaves this component.
// ---------------------------------------------------------------------------

type DoodleStep = 'closed' | 'source' | 'remote' | 'draw';

const doodleStep = ref<DoodleStep>('closed');
const doodleBackdrop = ref<string | null>(null);
const doodleName = ref<string | null>(null);
const doodleError = ref<string | null>(null);

const doodleTitle = computed(() =>
  doodleStep.value === 'remote'
    ? 'Choose an image on the host'
    : doodleStep.value === 'draw'
      ? doodleBackdrop.value
        ? 'Annotate'
        : 'Doodle'
      : 'Draw or annotate',
);

/**
 * Bytes to a `data:` URL.
 *
 * FileReader rather than btoa over a binary string: btoa needs the bytes
 * widened to a JS string first, which for a multi-megabyte screenshot means
 * building a string of a million-plus code units before any encoding starts.
 * The CSP is also the reason this is a data URL and not an object URL — see
 * index.html; blob: is granted for tile thumbnails, but data: keeps every
 * backdrop source on one path.
 */
function bytesToDataUrl(bytes: Uint8Array, mimeType: string): Promise<string> {
  return new Promise((done, fail) => {
    const reader = new FileReader();
    reader.onload = () => {
      // readAsDataURL always yields a string, but `result` is typed for every
      // read mode; narrow rather than coercing, so an ArrayBuffer could never
      // stringify to "[object ArrayBuffer]" and reach an <img> as a broken src.
      if (typeof reader.result === 'string') done(reader.result);
      else fail(new Error('Could not read the image.'));
    };
    reader.onerror = () => fail(new Error('Could not read the image.'));
    reader.readAsDataURL(new Blob([bytes], { type: mimeType }));
  });
}

/** Guess a mime type from an extension; the decoder sniffs the real one anyway. */
function mimeForName(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif' || ext === 'webp' || ext === 'avif' || ext === 'png') return `image/${ext}`;
  return 'application/octet-stream';
}

function openDoodle(): void {
  doodleBackdrop.value = null;
  doodleName.value = null;
  doodleError.value = null;
  doodleStep.value = 'source';
}

function closeDoodle(): void {
  doodleStep.value = 'closed';
  doodleBackdrop.value = null;
  doodleName.value = null;
  doodleError.value = null;
}

function startBlank(): void {
  doodleBackdrop.value = null;
  doodleName.value = null;
  doodleStep.value = 'draw';
}

/**
 * Pull an image straight off the system clipboard.
 *
 * Separate from `onPaste`: that path fires when the user pastes INTO the
 * textarea and stages the image as-is, which is still the right default. This
 * is the deliberate "take what I just copied and let me draw on it" route, so
 * it reads the clipboard on demand rather than waiting for a keystroke.
 */
async function startFromClipboard(): Promise<void> {
  doodleError.value = null;
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      doodleBackdrop.value = await bytesToDataUrl(
        new Uint8Array(await blob.arrayBuffer()),
        type,
      );
      doodleName.value = `clipboard.${type.slice('image/'.length)}`;
      doodleStep.value = 'draw';
      return;
    }
    doodleError.value = 'No image on the clipboard.';
  } catch {
    doodleError.value = 'Could not read the clipboard.';
  }
}

async function startFromLocalFile(): Promise<void> {
  doodleError.value = null;
  const paths = await api.attachments.pickFiles({ title: 'Pick an image', multiple: false });
  const path = paths[0];
  if (path === undefined) return; // cancelled
  try {
    const bytes = await api.attachments.readLocal(path);
    const name = path.split(/[\\/]/).pop() ?? 'image';
    doodleBackdrop.value = await bytesToDataUrl(bytes, mimeForName(name));
    doodleName.value = name;
    doodleStep.value = 'draw';
  } catch (e) {
    doodleError.value = e instanceof Error ? e.message : 'Could not open that file.';
  }
}

async function onRemotePick(picked: { path: string; name: string }): Promise<void> {
  doodleError.value = null;
  try {
    const bytes = await api.sftp.readBinary(props.connectionId, picked.path);
    doodleBackdrop.value = await bytesToDataUrl(bytes, mimeForName(picked.name));
    doodleName.value = picked.name;
    doodleStep.value = 'draw';
  } catch (e) {
    doodleError.value = e instanceof Error ? e.message : 'Could not open that file.';
    doodleStep.value = 'source';
  }
}

/** The finished drawing joins the staged tiles as ordinary PNG bytes. */
async function onDoodleCommit(result: {
  data: Uint8Array;
  dataUrl: string;
  name: string;
}): Promise<void> {
  closeDoodle();
  await stageSources(
    [{ kind: 'bytes', data: result.data, name: result.name, mimeType: 'image/png' }],
    [result.dataUrl],
  );
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

const canSend = computed(
  () =>
    (state.value.draft.length > 0 || state.value.attachments.length > 0) &&
    !state.value.sendInFlight,
);

async function onSend(): Promise<void> {
  const k = key.value;
  const shellId = shells.shellIdFor(props.sessionName);
  const route = sendRoute({
    viewingConversation: props.viewingConversation === true && (props.agentKind ?? null) !== null,
    liveAgent: props.agentKind ?? null,
    presumedAgent: null,
    // Inside the composer there is exactly one Send verb and it submits (§5.3).
    withEnter: true,
  });
  // Codex's TUI needs a longer gap before Enter (TmuxSessionViewModel.kt:12135).
  const submitDelayMs =
    route === 'agent-payload'
      ? Math.max(250, composerTiming.submitDelayMs)
      : composerTiming.submitDelayMs;

  await composer.send(k, async (payload) => {
    if (!shellId) return false;
    // Only the 'raw'/'agent-payload' arms exist today: both write into the pane's
    // PTY. 'agent-conversation' additionally needs an optimistic transcript echo
    // and is deferred until the Conversation tab has a live transcript (§16.3).
    return deliverPayload(payload, {
      write: (data) => api.shell.input(shellId, data),
      submitDelayMs,
    });
  });
  focusDraft();
}

function onDiscard(): void {
  composer.discard(key.value);
  focusDraft(0);
}

// ---------------------------------------------------------------------------
// Visibility state machine + keyboard (docs/COMPOSER.md §12, §20)
// ---------------------------------------------------------------------------

function openComposer(): void {
  if (mode.value === 'hidden') composer.setMode(composer.lastOpenMode);
  focusDraft();
}

/** The panel's maximize/restore button. Restoring returns the dragged height. */
function toggleExpanded(): void {
  composer.setMode(mode.value === 'expanded' ? 'docked' : 'expanded');
  focusDraft();
}

/** The panel's close button. Closes to the rail; never discards (§12.2). */
function closePanel(): void {
  composer.setMode('hidden');
}

/**
 * The Escape ladder (§12.2), first match wins. Escape NEVER clears the draft —
 * that is Discard's job and Discard's alone.
 */
function escapeLadder(fromDraft: boolean): void {
  if (slashOpen.value) {
    slashDismissed.value = true;
    return;
  }
  if (mode.value === 'expanded') {
    composer.setMode('docked');
    return;
  }
  if (fromDraft) {
    // Rung 3: blur and hand focus back to the pane. The composer stays visible.
    draftEl.value?.blur();
    emit('focus-terminal');
    return;
  }
  // Rung 4: focused somewhere in the composer chrome but not the draft.
  composer.setMode('hidden');
}

function onDraftKeydown(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey;

  if (slashOpen.value) {
    const n = slashCommands.value.length;
    if (e.key === 'ArrowDown') {
      activeCommand.value = (activeCommand.value + 1) % n;
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowUp') {
      activeCommand.value = (activeCommand.value - 1 + n) % n;
      e.preventDefault();
      return;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.isComposing)) {
      const cmd = slashCommands.value[activeCommand.value];
      if (cmd) acceptCommand(cmd);
      e.preventDefault();
      return;
    }
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    escapeLadder(true);
    return;
  }

  // CJK IME composition commits with Enter; `isComposing` is the whole of the
  // guard a DOM textarea needs (§22 — there is no TextFieldValue equivalent).
  if (e.key === 'Enter' && !e.isComposing && (mod || !e.shiftKey)) {
    e.preventDefault();
    void onSend();
    return;
  }

  if (mod && e.shiftKey && e.key === 'Backspace') {
    e.preventDefault();
    onDiscard();
  }
}

function onRootKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  if (e.target === draftEl.value) return; // already handled, and it stopped here
  e.preventDefault();
  escapeLadder(false);
}

/**
 * Global chords. Every one is a Ctrl/Cmd+SHIFT chord on purpose: bare Ctrl+K/L/
 * A/E/R are real terminal keys and must keep reaching the pane. Ctrl/Cmd+Shift+C
 * and +V belong to TerminalView's clipboard bindings and are untouched here.
 *
 * Capture phase + stopPropagation so xterm's textarea never sees them.
 */
function onGlobalKey(e: KeyboardEvent): void {
  if (!(e.ctrlKey || e.metaKey)) return;

  // Ctrl+` — the VS Code panel chord, and the primary toggle here. Deliberately
  // NOT a Shift chord: it is the one users already have in their fingers, and
  // it collides with nothing the terminal needs.
  if (!e.shiftKey && e.key === '`') {
    composer.toggleHidden();
    if (mode.value !== 'hidden') focusDraft();
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  if (!e.shiftKey) return;
  const lower = e.key.toLowerCase();
  if (lower === 'k') {
    composer.toggleHidden();
    if (mode.value !== 'hidden') focusDraft();
  } else if (e.key === 'ArrowUp') {
    composer.grow();
    focusDraft();
  } else if (e.key === 'ArrowDown') {
    composer.shrink();
  } else if (lower === 'a') {
    void onAttachClick();
  } else {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
}

// ---------------------------------------------------------------------------
// Drag-to-resize (§23.7)
// ---------------------------------------------------------------------------

let dragStartY = 0;
let dragStartHeight = 0;

/**
 * The height `.composer`'s own `max-height: 80%` is a percentage OF — the dock's
 * content box, i.e. the session body minus the float inset at top and bottom.
 *
 * Measuring the padding rather than assuming it matters: the drag clamp and the
 * CSS cap have to agree, or dragging past the cap keeps growing the REMEMBERED
 * height while the card visibly stops, and the panel then restores to a size it
 * never had. (Before the dock spanned the body this read the card's own height
 * as the room available for the card, so dragging upward clamped against 80% of
 * the current height and walked the panel down to the floor instead.)
 */
function roomForCard(): number {
  const dock = rootEl.value?.parentElement;
  if (!dock) return window.innerHeight;
  const style = getComputedStyle(dock);
  const inset = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  return dock.clientHeight - (Number.isFinite(inset) ? inset : 0);
}

function onHandleDown(e: MouseEvent): void {
  if (!rootEl.value) return;
  e.preventDefault();
  dragStartY = e.clientY;
  dragStartHeight = rootEl.value.offsetHeight;
  window.addEventListener('mousemove', onHandleMove);
  window.addEventListener('mouseup', onHandleUp);
}

function onHandleMove(e: MouseEvent): void {
  const raw = dragStartHeight + (dragStartY - e.clientY);
  const max = Math.round(roomForCard() * MAX_HEIGHT_FRACTION);
  const height = Math.max(MIN_HEIGHT, Math.min(raw, max));
  composer.setHeight(key.value, height);
  // A drag always produces a concrete remembered size, so it leaves the
  // maximized state — exactly like dragging the VS Code panel's sash.
  if (mode.value !== 'docked') composer.setMode('docked');
}

function onHandleUp(): void {
  window.removeEventListener('mousemove', onHandleMove);
  window.removeEventListener('mouseup', onHandleUp);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * VS Code semantics: `expanded` is MAXIMIZED (a fraction of the body, ignoring
 * the remembered size), `docked` is the remembered size. Restoring from
 * maximized therefore lands back on exactly the height the user last dragged.
 */
const rootStyle = computed(() => {
  // `hidden` sizes itself from `.composer.hidden`, so it contributes no height.
  if (mode.value === 'hidden') return {};
  if (mode.value === 'expanded') return { height: `${MAX_HEIGHT_FRACTION * 100}%` };
  return { height: `${state.value.height ?? DEFAULT_HEIGHT}px` };
});

onMounted(() => {
  window.addEventListener('keydown', onGlobalKey, { capture: true });
  caret.value = state.value.caret;
  // The composer is the primary surface: land in it (§11).
  if (mode.value !== 'hidden') focusDraft();
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKey, { capture: true });
  onHandleUp();
});

defineExpose({ focusDraft, openComposer });
</script>

<template>
  <div
    ref="rootEl"
    :class="['composer', mode, { 'drag-over': dragActive }]"
    :style="rootStyle"
    @keydown="onRootKeydown"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- hidden: a 32px rail, so a preserved "Not sent" draft is discoverable. -->
    <button
      v-if="mode === 'hidden'"
      class="rail"
      type="button"
      title="Open the prompt panel (Ctrl+`)"
      @click="openComposer"
    >
      <AppIcon class="chevron" name="chevron-up" />
      <span class="rail-title">Prompt</span>
      <span class="ghost">{{ COMPOSER_STRINGS.placeholder }}</span>
      <AppIcon v-if="state.draft.length" class="draft-dot" name="dot" title="unsent draft" />
      <span v-if="attachments.length" class="rail-badge">
        <AppIcon name="paperclip" />
        {{ attachments.length }}
      </span>
      <span class="hint">Ctrl+`</span>
    </button>

    <template v-else>
      <!-- VS Code's sash: a thin row-resize strip on the panel's top edge. -->
      <div
        class="sash"
        role="separator"
        aria-orientation="horizontal"
        title="Drag to resize · double-click to maximize"
        @mousedown="onHandleDown"
        @dblclick="toggleExpanded"
      ></div>

      <!-- Panel toolbar: title left, window actions right. -->
      <div class="panel-header">
        <span class="panel-title">Prompt</span>
        <span class="panel-scope">{{ sessionName }}</span>
        <AppIcon
          v-if="state.draft.length || attachments.length"
          class="panel-dirty"
          name="dot"
          title="unsent draft"
        />
        <span class="spacer"></span>
        <button
          class="panel-action"
          type="button"
          :title="mode === 'expanded' ? 'Restore panel (Ctrl+Shift+↓)' : 'Maximize panel (Ctrl+Shift+↑)'"
          :aria-label="mode === 'expanded' ? 'Restore panel' : 'Maximize panel'"
          @click="toggleExpanded"
        >
          <AppIcon :name="mode === 'expanded' ? 'chevron-down' : 'chevron-up'" />
        </button>
        <button
          class="panel-action"
          type="button"
          title="Close panel (Ctrl+`)"
          aria-label="Close panel"
          @click="closePanel"
        >
          <AppIcon name="close" />
        </button>
      </div>

      <!-- Above the field, never below: the list must not be pushed off-screen. -->
      <SlashCommandDropdown
        v-if="slashOpen"
        class="slash-anchor"
        :commands="slashCommands"
        :active="activeCommand"
        @pick="acceptCommand"
        @hover="(i: number) => (activeCommand = i)"
      />

      <!-- Everything between the toolbar and the Send row lives in one
           scroller: the draft absorbs slack when the panel is tall, and when it
           is at the floor (or a banner appears) this scrolls instead of
           squeezing the Send row out of reach. -->
      <div class="panel-body">
        <div class="draft-wrap">
          <textarea
            ref="draftEl"
            class="draft"
            :value="state.draft"
            :placeholder="COMPOSER_STRINGS.placeholder"
            spellcheck="false"
            aria-label="Prompt draft"
            @input="onInput"
            @keyup="syncCaret"
            @click="syncCaret"
            @keydown="onDraftKeydown"
            @paste="onPaste"
          />
        </div>

        <div v-if="state.error" class="banner" role="alert">
          <span class="banner-text">{{ state.error }}</span>
          <button
            v-if="state.draft.length || attachments.length"
            class="discard"
            type="button"
            @click="onDiscard"
          >
            Discard
          </button>
        </div>

        <p v-if="state.uploadingCount > 0" class="uploading muted">
          {{ COMPOSER_STRINGS.uploading(state.uploadingCount) }}
        </p>

        <!-- Own scroller: 20 attachments must not cost Send its slot. -->
        <div v-if="attachments.length" class="tiles-wrap">
          <ComposerAttachmentTiles
            :attachments="attachments"
            :disabled="state.sendInFlight"
            @remove="(p: string) => composer.removeAttachment(key, p)"
          />
        </div>
      </div>

      <p v-if="state.connectionDegraded" class="conn-lost">
        {{ COMPOSER_STRINGS.connectionLost }}
      </p>

      <div class="controls">
        <div class="pill">
          <button
            class="tool"
            type="button"
            title="Attach files (Ctrl+Shift+A)"
            aria-label="Attach to prompt"
            :disabled="state.uploadingCount > 0"
            @click="onAttachClick"
          >
            <AppIcon name="paperclip" />
          </button>
          <button
            class="tool"
            type="button"
            title="Draw or annotate an image"
            aria-label="Draw or annotate an image"
            :disabled="state.uploadingCount > 0"
            @click="openDoodle"
          >
            <AppIcon name="edit-2" />
          </button>
          <button
            class="tool"
            type="button"
            :title="
              (agentKind ?? null) === null
                ? 'Slash commands need a detected agent'
                : 'Slash commands'
            "
            aria-label="Slash commands"
            :disabled="state.uploadingCount > 0 || (agentKind ?? null) === null"
            @click="onSlashButton"
          >
            /
          </button>
        </div>
        <span class="spacer"></span>
        <span class="kbd-hint muted">Enter send &middot; Shift+Enter newline</span>
        <button
          class="send"
          type="button"
          :disabled="!canSend"
          title="Send (Enter)"
          @click="onSend"
        >
          {{ state.sendInFlight ? 'Sending…' : 'Send' }}
        </button>
      </div>
    </template>

    <!-- The drawing surface is modal because it takes a pointer drag as its
         primary input: with the composer still live behind it, a stroke that
         left the canvas would land in the draft. -->
    <OverlayPanel
      v-if="doodleStep !== 'closed'"
      :title="doodleTitle"
      size="md"
      @close="closeDoodle"
    >
      <div v-if="doodleStep === 'source'" class="doodle-sources">
        <p v-if="doodleError" class="doodle-error">{{ doodleError }}</p>
        <button class="source" type="button" @click="startBlank">
          <AppIcon name="edit-2" />
          <span class="source-label">Blank sheet</span>
          <span class="source-hint">Sketch something from nothing</span>
        </button>
        <button class="source" type="button" @click="startFromClipboard">
          <AppIcon name="image" />
          <span class="source-label">From the clipboard</span>
          <span class="source-hint">Annotate the screenshot you just copied</span>
        </button>
        <button class="source" type="button" @click="startFromLocalFile">
          <AppIcon name="folder" />
          <span class="source-label">From this computer…</span>
          <span class="source-hint">Pick an image file to draw on</span>
        </button>
        <button class="source" type="button" @click="doodleStep = 'remote'">
          <AppIcon name="symlink" />
          <span class="source-label">From the host…</span>
          <span class="source-hint">Browse images already on the server</span>
        </button>
      </div>

      <RemoteImagePicker
        v-else-if="doodleStep === 'remote'"
        :connection-id="props.connectionId"
        @pick="onRemotePick"
        @close="doodleStep = 'source'"
      />

      <DoodleCanvas
        v-else
        :backdrop="doodleBackdrop"
        :backdrop-name="doodleName"
        @commit="onDoodleCommit"
        @close="closeDoodle"
      />
    </OverlayPanel>
  </div>
</template>

<style scoped>
/* ---- the floating card --------------------------------------------------
 * The card is a flex item of `.composer-dock`, which spans the whole session
 * body and pins it bottom-right (SessionWorkspaceView.vue). Everything that
 * makes it read as HOVERING rather than as a bar lives here: it is inset from
 * the pane's edges by the dock's padding, it closes its own corners, and its
 * shadow falls on all four sides instead of only upward.
 *
 * `flex: 0 1 auto` — the inline `height` (the remembered px size, or 80% when
 * maximized) is the basis; it may shrink to honour `max-height` and must never
 * grow to fill the dock, which is body-height now.
 */
.composer {
  position: relative;
  flex: 0 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  /* ~80 columns of the draft's 13px mono, which is the width a prompt is
     actually written at. Wider than that and the card stops being a card and
     starts being the old full-bleed bar with corners. */
  width: min(720px, 100%);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-xl);
  /* OverlayPanel's elevation, with the Y offset pulled in: that panel is
     centred and can afford to cast 16px downward, while this one sits a --sp-3
     gap off the bottom edge and would throw most of its shadow off the pane —
     leaving the TOP edge, the one that has terminal text behind it, with no
     separation at all. Same colour, same blur, so both read as one material. */
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}
/* Backstop for a short window: the remembered height is an absolute px value,
   so without this a 500px-tall body plus a 600px panel would cover the terminal
   whole. Resolves against the dock, which is why the dock spans the body. */
.composer.docked,
.composer.expanded {
  max-height: 80%;
}
/* Chromium follows the element's own corners here, so the dashed accent traces
   the card's radius rather than boxing it. */
.composer.drag-over {
  outline: 2px dashed var(--accent);
  outline-offset: -2px;
}

/* ---- closed: the rail pill, so the panel can always be found by eye ------
 * It keeps the card's corner and its elevation and simply shrinks to its
 * content, so closing the panel is the card contracting in place rather than
 * the affordance jumping to a different edge of the window. Its height is the
 * one the pane reserves permanently, so — unlike the open card — the pill
 * never covers a terminal row.
 */
.composer.hidden {
  width: auto;
  max-width: min(720px, 100%);
  height: var(--composer-rail-h, 32px);
  border-radius: 999px;
}
.rail {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  height: 100%;
  padding: 0 var(--sp-3);
  background: transparent;
  border: none;
  border-radius: inherit;
  color: var(--fg-muted);
  font-family: var(--font-ui);
  font-size: var(--fs-200);
  cursor: pointer;
  text-align: left;
}
.rail:hover {
  background: var(--state-hover);
  color: var(--fg-secondary);
}
.chevron {
  color: var(--fg-secondary);
}
.rail-title {
  font-size: var(--fs-100);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--fg-secondary);
  flex: 0 0 auto;
}
.ghost {
  font-style: italic;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 8px, not the icon's default 16 — this is a status pip, not an affordance. */
.draft-dot {
  color: var(--accent);
  width: 8px;
  height: 8px;
}
.rail-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  color: var(--fg-secondary);
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
}
.rail-badge :deep(.app-icon) {
  width: 13px;
  height: 13px;
}
.hint {
  margin-left: auto;
  padding-left: var(--sp-2);
  font-family: var(--font-mono);
  font-size: var(--fs-100);
  color: var(--fg-muted);
  flex: 0 0 auto;
}

/* ---- the sash: VS Code's row-resize strip on the panel's top edge -------
   The card is not `overflow: hidden` — the slash dropdown deliberately escapes
   above it — so the one child that paints to a corner has to close it itself. */
.sash {
  flex: 0 0 auto;
  height: 6px;
  cursor: row-resize;
  background: transparent;
  border-radius: var(--r-xl) var(--r-xl) 0 0;
  transition: background var(--dur-fast) var(--ease);
}
.sash:hover {
  background: var(--accent-dim);
}

/* ---- panel toolbar ----------------------------------------------------- */
.panel-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: var(--tabbar-h);
  padding: 0 var(--sp-2) 0 var(--sp-3);
  border-bottom: 1px solid var(--border-soft);
}
.panel-title {
  font-size: var(--fs-100);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--fg);
  flex: 0 0 auto;
}
.panel-scope {
  font-family: var(--font-mono);
  font-size: var(--fs-100);
  color: var(--fg-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.panel-dirty {
  color: var(--accent);
  width: 8px;
  height: 8px;
}
.panel-action {
  flex: 0 0 auto;
  width: var(--control-h-sm);
  height: var(--control-h-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: var(--r-sm);
  color: var(--fg-secondary);
  font-family: var(--font-ui);
  font-size: var(--fs-200);
  line-height: 1;
  cursor: pointer;
}
.panel-action:hover {
  background: var(--state-active);
  color: var(--fg);
}

/* ---- floating dropdown ------------------------------------------------- */
.slash-anchor {
  position: absolute;
  left: var(--sp-3);
  right: var(--sp-3);
  bottom: calc(100% - 4px);
  z-index: 20;
}

/* ---- the flexible middle ----------------------------------------------- */
.panel-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.draft-wrap {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  padding: var(--sp-2) var(--sp-3);
}
.draft {
  flex: 1 1 auto;
  width: 100%;
  /* Two lines is the floor. Below that the caret line gets clipped in half —
     see the 150px capture this replaced. Past the floor .panel-body scrolls
     instead, so the toolbar and the Send row never move. */
  min-height: 46px;
  resize: none;
  overflow-y: auto;
  padding: var(--sp-2) var(--sp-3);
  background: var(--bg);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-300);
  line-height: var(--lh-300);
}
.draft::placeholder {
  color: var(--fg-muted);
}

/* ---- banners ----------------------------------------------------------- */
.banner {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0 var(--sp-3) var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  background: var(--error-soft);
  border: 1px solid var(--error);
  border-radius: var(--r-md);
  color: var(--fg);
  font-size: var(--fs-200);
}
.banner-text {
  flex: 1;
  min-width: 0;
}
.discard {
  flex: 0 0 auto;
  height: var(--control-h-sm);
  padding: 0 var(--sp-2);
  background: transparent;
  border: 1px solid var(--error);
  border-radius: var(--r-sm);
  color: var(--error);
  font-family: var(--font-ui);
  font-size: var(--fs-200);
  font-weight: var(--fw-medium);
  cursor: pointer;
}
.discard:hover {
  background: var(--error);
  color: var(--on-accent);
}
.uploading {
  flex: 0 0 auto;
  margin: 0 0 var(--sp-2);
  padding: 0 var(--sp-3);
  font-size: var(--fs-200);
}

/* Exactly two rows of tiles (28px each + an 8px gap), then it scrolls. An
   uncapped wrapping list would push the Send row off the bottom; a fractional
   cap sliced the third row in half. */
.tiles-wrap {
  flex: 0 0 auto;
  max-height: 72px;
  overflow-y: auto;
  padding: 0 var(--sp-3) var(--sp-2);
}
.conn-lost {
  flex: 0 0 auto;
  margin: 0;
  padding: var(--sp-1) var(--sp-3);
  background: var(--warning-soft);
  border-top: 1px solid var(--border-soft);
  color: var(--warning);
  font-size: var(--fs-200);
}

/* ---- control row ------------------------------------------------------- */
.controls {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-top: 1px solid var(--border-soft);
}
.pill {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 2px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 22px;
  flex: 0 0 auto;
}
/* The slash button keeps a TEXT `/`: it is the literal character the button
   inserts into the draft, a keycap rather than a pictogram. Everything else in
   this panel is a drawn icon. */
.tool {
  width: var(--control-h-sm);
  height: var(--control-h-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 50%;
  color: var(--fg-secondary);
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  line-height: 1;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
.tool:hover:not(:disabled) {
  background: var(--state-active);
  color: var(--fg);
}
.tool:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
.spacer {
  flex: 1 1 auto;
  min-width: 0;
}
/* First thing to give when the panel is narrow — it is a reminder, not a
   control, so it truncates instead of pushing Send off the edge. */
.kbd-hint {
  flex: 0 1 auto;
  font-size: var(--fs-100);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.send {
  flex: 0 0 auto;
  height: var(--control-h);
  padding: 0 var(--sp-4);
  background: var(--accent);
  border: 1px solid var(--accent);
  border-radius: var(--r-md);
  color: var(--on-accent);
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
.send:hover:not(:disabled) {
  background: var(--accent-dim);
  color: var(--fg);
}
.send:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}

/* ---- Doodle source chooser --------------------------------------------- */
.doodle-sources {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
/* A row per source rather than a row of icon buttons: three of the four need a
   sentence to distinguish them ("from this computer" vs "from the host" is the
   whole distinction), and a tooltip is the wrong place for the only thing that
   tells them apart. */
.source {
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-areas: 'icon label' 'icon hint';
  align-items: center;
  gap: 0 var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  color: var(--fg);
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}
.source:hover {
  background: var(--state-hover);
  border-color: var(--border-strong);
}
.source:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.source > :first-child {
  grid-area: icon;
  color: var(--fg-secondary);
}
.source-label {
  grid-area: label;
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
}
.source-hint {
  grid-area: hint;
  font-size: var(--fs-100);
  color: var(--fg-secondary);
}
.doodle-error {
  margin: 0 0 var(--sp-1);
  font-size: var(--fs-200);
  color: var(--error);
}
</style>
