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
// it, matching VS Code muscle memory — and so does ONE fixed toggle pinned to
// the pane's bottom-right corner, which is present whether the card is open or
// closed and is the only control that opens and closes it. That toggle is a
// small icon button; a pip on it says a draft is waiting.
//
// NOTHING here occupies terminal space. The composer is a pure overlay: the
// pane behind it is sized as if the composer did not exist, so the terminal
// gets every row of the window.
//
// The card overlays the terminal instead of splitting the pane with it, and
// that is the point: see the block comment on `.composer-dock` in
// SessionWorkspaceView.vue. The terminal's ROW COUNT never changes when the
// composer opens, closes, moves or is dragged — no SSH window-change, no
// remote tmux reflow — because the composer contributes NOTHING to the tab
// body's layout in any state.
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
//  1. §12 — a third `hidden` mode that leaves the toggle behind, instead of
//     the phone's "the sheet is simply gone". A preserved "Not sent" draft must
//     stay discoverable; the toggle wears a pip when one is waiting.
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
import { useSettingsStore } from '../stores/settings';
import { useShellsStore } from '../stores/shells';
import ComposerAttachmentTiles from './ComposerAttachmentTiles.vue';
import SlashCommandDropdown from './SlashCommandDropdown.vue';
import AppIcon from './AppIcon.vue';
import OverlayPanel from './OverlayPanel.vue';
import DoodleCanvas from './DoodleCanvas.vue';
import RemoteImagePicker from './RemoteImagePicker.vue';
import {
  COMPOSER_STRINGS,
  insertAtCaret,
  insertCommandText,
  railToggle,
  slashQueryFor,
} from '../../shared/composerText';
import {
  composerTiming,
  deliverPayload,
  sendRoute,
  type ComposerAgentKind,
} from '../../shared/composerSend';
import { filteredCommands, insertionTextFor, type AgentCommand } from '../../shared/agentCommands';
import {
  clampGeometry,
  maximizedGeometry,
  moveGeometry,
  resizeGeometry,
  snapGeometry,
  type ComposerGeometry,
  type PaneBox,
  type ResizeEdge,
} from '../../shared/composerGeometry';
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
// Read through the store on every use, never copied into a local: a switch
// flipped in Settings has to take effect on the next keystroke, not the next
// mount.
const settings = useSettingsStore();

/**
 * Every edge and every corner, so the card resizes the way a window does.
 *
 * Edges first, corners last: they are siblings at one z-index, so DOM order is
 * the hit-test tiebreak, and a corner has to come after the two edges it
 * overlaps or it would never be reachable.
 *
 * The sizes and floors these drags clamp against live in
 * src/shared/composerGeometry.ts, with the reasoning for each number.
 */
const RESIZE_EDGES: readonly ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

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
  caret: 0,
};

const state = computed<ComposerSessionState>(() => composer.states[key.value] ?? FALLBACK);
/** App-level, not per session — see the store's header comment. */
const mode = computed(() => composer.mode);
const attachments = computed(() => state.value.attachments);

/** Is there work in here the user would lose track of? Drives the toggle's pip. */
const hasUnsent = computed(() => state.value.draft.length > 0 || attachments.value.length > 0);

/** Chevron direction and copy for the fixed toggle — pure, so it can be pinned. */
const toggle = computed(() => railToggle(mode.value !== 'hidden', hasUnsent.value));

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

  const delivered = await composer.send(
    k,
    async (payload) => {
      if (!shellId) return false;
      // Only the 'raw'/'agent-payload' arms exist today: both write into the
      // pane's PTY. 'agent-conversation' additionally needs an optimistic
      // transcript echo and is deferred until the Conversation tab has a live
      // transcript (§16.3).
      return deliverPayload(payload, {
        write: (data) => api.shell.input(shellId, data),
        submitDelayMs,
      });
    },
    { closeOnDelivery: settings.closeComposerOnSend },
  );
  // The store has already closed it on a delivered send when the setting is on;
  // all that is left here is where the keyboard goes. Sent and shut means the
  // terminal — which is also what makes the next keystroke re-open the panel.
  // A failed send leaves the card up with its banner, so the caret goes back to
  // the draft the user still has to deal with.
  if (delivered && settings.closeComposerOnSend) emit('focus-terminal');
  else focusDraft();
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

/**
 * Put the card away, and hand the keyboard back to the terminal.
 *
 * The focus half is not a nicety: with `typingOpensComposer` on, the intercept
 * that re-opens the composer lives on the terminal's own textarea, so a close
 * that left focus on the rail button (or nowhere) would leave the next
 * keystroke going nowhere and the feature looking broken. Every path that
 * closes the panel goes through here for that reason.
 */
function hideComposer(): void {
  composer.setMode('hidden');
  emit('focus-terminal');
}

/**
 * THE open/close control. One handler, one screen position, both directions:
 * clicking the fixed toggle puts the card away, clicking the same pixel brings
 * it back. `toggleHidden` is what preserves docked-vs-maximized across the
 * round trip, so re-opening restores the mode the user left.
 */
function onToggleRail(): void {
  if (mode.value === 'hidden') {
    composer.setMode(composer.lastOpenMode);
    focusDraft();
  } else {
    hideComposer();
  }
}

/**
 * A keystroke the terminal withheld because the composer was shut
 * (`typingOpensComposer`, docs/COMPOSER.md §26). Open on the session's
 * remembered mode and plant the character where the caret was left, so the
 * letter that opened the panel is the panel's first letter and nothing has to
 * be retyped.
 */
function typeInto(text: string): void {
  const k = key.value;
  const [next, caretAt] = insertAtCaret(state.value.draft, state.value.caret, text);
  composer.setDraft(k, next, caretAt);
  caret.value = caretAt;
  if (mode.value === 'hidden') composer.setMode(composer.lastOpenMode);
  focusDraft(caretAt);
}

/** The panel's maximize/restore button. Restoring returns the dragged height. */
function toggleExpanded(): void {
  composer.setMode(mode.value === 'expanded' ? 'docked' : 'expanded');
  focusDraft();
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
  hideComposer();
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
    onToggleRail();
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  if (!e.shiftKey) return;
  const lower = e.key.toLowerCase();
  if (lower === 'k') {
    onToggleRail();
  } else if (e.key === 'ArrowUp') {
    composer.grow();
    focusDraft();
  } else if (e.key === 'ArrowDown') {
    const wasOpen = mode.value !== 'hidden';
    composer.shrink();
    // Shrinking past `docked` closes it, and a close hands focus back. Read the
    // store directly: `mode.value` was narrowed by the line above and TS cannot
    // see that `shrink()` changed it.
    if (wasOpen && composer.mode === 'hidden') emit('focus-terminal');
  } else if (lower === 'a') {
    void onAttachClick();
  } else {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
}

// ---------------------------------------------------------------------------
// Moving and resizing the card (§21.1, §23.7)
//
// One drag loop serves both: a press on the header MOVES the card, a press on
// an edge grip RESIZES it. The arithmetic for each lives in
// shared/composerGeometry.ts, so the rules that keep the card on-screen and
// usable are unit-tested rather than re-derived from mouse events here.
// ---------------------------------------------------------------------------

/**
 * The card's world: the whole dock, plus the one corner it may not have.
 *
 * The card used to be confined to the dock MINUS a full-width strip along the
 * bottom, because that strip was reserved out of the terminal and the toggle
 * lived in it. The strip is gone — the composer takes no terminal space at
 * all now — so the card gets the whole pane, and the only thing it must still
 * clear is the toggle's own small box (§21.4).
 *
 * That box is MEASURED from the live element rather than declared as a
 * constant: its size is a CSS decision, and measuring is what keeps the two
 * from drifting apart the next time the toggle is restyled.
 */
const paneBox = ref<PaneBox | null>(null);
const railEl = ref<HTMLElement | null>(null);
let paneObserver: ResizeObserver | null = null;

function measurePane(): void {
  const el = rootEl.value;
  if (!el) return;
  const root = el.getBoundingClientRect();
  const rail = railEl.value?.getBoundingClientRect();
  paneBox.value = {
    width: el.clientWidth,
    height: el.clientHeight,
    ...(rail
      ? { keepOut: { width: root.right - rail.left, height: root.bottom - rail.top } }
      : {}),
  };
}

type DragIntent = { kind: 'move' } | { kind: 'resize'; edge: ResizeEdge };
let drag: (DragIntent & { x: number; y: number; from: ComposerGeometry }) | null = null;

/**
 * The box to PAINT, which is not always the box that is stored: `expanded`
 * ignores the remembered geometry entirely (that is what restore returns to),
 * and every other mode is clamped to the current pane for display only. The
 * store keeps the raw numbers, so shrinking the window and restoring it puts
 * the card back where the user left it.
 */
const card = computed<ComposerGeometry>(() => {
  const pane = paneBox.value;
  // One frame, before the first measurement lands: the stored box is the best
  // guess available, and it was legal for the last pane this window had.
  if (!pane) return composer.geometry;
  if (mode.value === 'expanded') return maximizedGeometry(pane);
  return clampGeometry(composer.geometry, pane);
});

function beginDrag(e: MouseEvent, intent: DragIntent): void {
  if (mode.value === 'hidden' || e.button !== 0) return;
  // Also stops the press from moving focus, so dragging the card by its header
  // never costs the caret its place in the draft.
  e.preventDefault();
  measurePane();
  drag = { ...intent, x: e.clientX, y: e.clientY, from: card.value };
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', onDragEnd);
}

function onDragMove(e: MouseEvent): void {
  const pane = paneBox.value;
  if (!drag || !pane) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  composer.setGeometry(
    drag.kind === 'move'
      ? moveGeometry(drag.from, dx, dy, pane)
      : resizeGeometry(drag.from, dx, dy, drag.edge, pane),
  );
  // A drag always produces a concrete remembered box, so it leaves the
  // maximized state — exactly like dragging a maximized OS window restores it
  // under the cursor. `drag.from` IS the maximized box, so nothing jumps.
  if (mode.value !== 'docked') composer.setMode('docked');
}

function onDragEnd(): void {
  window.removeEventListener('mousemove', onDragMove);
  window.removeEventListener('mouseup', onDragEnd);
  const pane = paneBox.value;
  // Snap on release only, and only after a MOVE. During the drag the card
  // follows the pointer 1:1 (DESIGN.md §5.9), and snapping a RESIZE would
  // silently change the size the user had just chosen.
  if (drag?.kind === 'move' && pane) {
    composer.setGeometry(snapGeometry(composer.geometry, pane));
  }
  drag = null;
}

/**
 * The header strip is the card's title bar: press it and the card follows the
 * pointer. Presses that land on a button are left alone — maximize and close
 * are the two things in this strip that are not the handle.
 */
function onHeaderDown(e: MouseEvent): void {
  if ((e.target as HTMLElement).closest('button')) return;
  beginDrag(e, { kind: 'move' });
}

/** Double-clicking a title bar maximizes the window, everywhere. Same here. */
function onHeaderDoubleClick(e: MouseEvent): void {
  if ((e.target as HTMLElement).closest('button')) return;
  toggleExpanded();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Where the card is painted. Only ever read while the card exists: `hidden`
 * removes it from the tree entirely, because the rail is now a separate element
 * that stays put rather than the same box collapsed (§21.5).
 */
const rootStyle = computed(() => {
  const g = card.value;
  return {
    right: `${g.right}px`,
    bottom: `${g.bottom}px`,
    width: `${g.width}px`,
    height: `${g.height}px`,
  };
});

onMounted(() => {
  window.addEventListener('keydown', onGlobalKey, { capture: true });
  measurePane();
  if (rootEl.value && typeof ResizeObserver !== 'undefined') {
    // The pane changes without a window resize too — the session panel's
    // splitter moves it — and a card clamped to a stale pane would hang off
    // the edge. Nothing in here resizes the root, so this cannot feed back.
    // The root and the toggle are rendered in every mode, so the measurement
    // stays live while the card is closed and re-opening lands clamped.
    paneObserver = new ResizeObserver(measurePane);
    paneObserver.observe(rootEl.value);
  }
  caret.value = state.value.caret;
  // The composer is the primary surface: land in it (§11).
  if (mode.value !== 'hidden') focusDraft();
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKey, { capture: true });
  paneObserver?.disconnect();
  paneObserver = null;
  onDragEnd();
});

defineExpose({ focusDraft, openComposer, typeInto });
</script>

<template>
  <div
    ref="rootEl"
    :class="['composer-root', { 'drag-over': dragActive }]"
    @keydown="onRootKeydown"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div v-if="mode !== 'hidden'" :class="['composer', mode]" :style="rootStyle">
      <!-- Every edge and corner is a resize grip. The top one keeps the sash's
           look and its double-click, so that affordance is where it always was. -->
      <div
        v-for="edge in RESIZE_EDGES"
        :key="edge"
        :class="['grip', `grip-${edge}`, { sash: edge === 'n' }]"
        :title="edge === 'n' ? 'Drag to resize · double-click to maximize' : undefined"
        aria-hidden="true"
        @mousedown="beginDrag($event, { kind: 'resize', edge })"
        @dblclick="edge === 'n' && toggleExpanded()"
      ></div>

      <!-- Panel toolbar, and the card's title bar: press it to move the card.
           Maximize/restore, then close, in that order — the conventional
           window arrangement, with the dismissing one last so it is not what
           the cursor lands on by accident.
           On that close button: an earlier pass REMOVED it, on the grounds that
           a second closer riding on a draggable card was the "the control
           moved" complaint all over again. docs/COMPOSER.md §21.4 records why
           that no longer holds — in short, dismissing the surface you are
           looking at and re-opening from a pinned icon are different acts, and
           only the second one needs a fixed address. -->
      <div class="panel-header" @mousedown="onHeaderDown" @dblclick="onHeaderDoubleClick">
        <span class="panel-title">Prompt</span>
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
          title="Close the prompt panel (Ctrl+`)"
          aria-label="Close the prompt panel"
          @click="hideComposer"
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
    </div>

    <!-- THE open/close control.
         Anchored to the PANE, not to the card: the card moves, so a control on
         it could not be the fixed point the user asked for. It is the same
         element, the same size and the same pixel whether the card is open,
         closed, dragged elsewhere or maximized — `keepOut` is what stops the
         card ever landing on top of it.
         It is a bare icon now. Everything the collapsed rail used to spell out
         — the PROMPT label, the draft's first line, the attachment count, the
         Ctrl+` hint — sat on top of terminal output at rest, which made the
         quietest state the most intrusive one. The hint moved into the tooltip
         and the draft moved into the pip. -->
    <button
      ref="railEl"
      :class="['rail', { unsent: toggle.unsent }]"
      type="button"
      :title="toggle.title"
      :aria-label="toggle.label"
      :aria-expanded="mode !== 'hidden'"
      @click="onToggleRail"
    >
      <AppIcon :name="toggle.icon" :size="14" />
      <span v-if="toggle.unsent" class="unsent-pip" aria-hidden="true"></span>
    </button>

    <!-- The drawing surface is modal because it takes a pointer drag as its
         primary input: with the composer still live behind it, a stroke that
         left the canvas would land in the draft. The wrapper takes pointer
         events back: everything in this component is transparent to the mouse
         by default so the terminal underneath stays clickable. -->
    <div v-if="doodleStep !== 'closed'" class="modal-layer">
      <OverlayPanel
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
  </div>
</template>

<style scoped>
/* ---- the two layers -----------------------------------------------------
 * root    fills `.composer-dock`, i.e. the session body inset on all sides.
 *         It IS the card's world: with the reserved strip gone, the card may
 *         be dragged anywhere in the pane except the toggle's own corner,
 *         which `keepOut` handles in JS rather than by walling off a band.
 * rail    the fixed toggle, pinned to that corner.
 *
 * Both are `pointer-events: none` at the top and the two real controls take
 * their own events back, because this layer covers the whole pane and would
 * otherwise swallow every click meant for the terminal. Drag-and-drop still
 * works: pointer-events governs hit-testing, not the propagation of an event
 * that started on a descendant which does accept them.
 */
.composer-root {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.composer,
.rail,
.modal-layer {
  pointer-events: auto;
}

/* ---- the floating card --------------------------------------------------
 * The card is absolutely positioned inside `.composer-dock`, which is the
 * session body inset on all four sides (SessionWorkspaceView.vue). Its box —
 * right, bottom, width, height — is computed in JS and arrives as an inline
 * style, because the user can now drag all four of those numbers and they have
 * to be clamped against the pane by rules a unit test can check
 * (src/shared/composerGeometry.ts).
 *
 * What is left here is only what makes it read as HOVERING rather than as a
 * bar: its own corners, an opaque surface, and a shadow on every side.
 */
.composer {
  position: absolute;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-xl);
  /* OverlayPanel's elevation, with the Y offset pulled in: that panel is
     centred and can afford to cast 16px downward, while this one can sit right
     against the bottom of its dock and would throw most of its shadow off the
     pane — leaving the TOP edge, the one that has terminal text behind it,
     with no separation at all. Same colour, same blur, so both read as one
     material. */
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}
/* Chromium follows the element's own corners here, so the dashed accent traces
   the card's radius (or the rail's pill) rather than boxing it. The flag is on
   the root because a file may be dropped on either, and when the card is closed
   the rail is the only target there is. */
.composer-root.drag-over .composer,
.composer-root.drag-over .rail {
  outline: 2px dashed var(--accent);
  outline-offset: -2px;
}

/* ---- the fixed toggle ---------------------------------------------------
 * ONE control, two states, ONE position. Pinned to the pane's bottom-right
 * corner and the only thing that opens and closes the panel, so the user aims
 * at a single unmoving pixel and it alternates — which a control living on
 * the card could never do, because the card moves.
 *
 * It is deliberately SMALL. The composer is an overlay now: it takes no
 * terminal rows, but whatever it draws at rest sits on top of tmux's status
 * line. The rail used to spell out a label, the draft's first line, an
 * attachment count and a keyboard hint — the most intrusive possible resting
 * state. An icon is the least that still offers the affordance; the hint is in
 * the tooltip and the draft is in the pip.
 *
 * 24px box, 14px mark: both are on docs/POLISH.md §2.7's scale (§2.7 allows
 * 16/14/12, and this is the app's densest chrome, so 14). Nothing smaller stays
 * a comfortable pointer target.
 *
 * It is pinned, so it is never dragged: a click here is unambiguously a click.
 */
.rail {
  position: absolute;
  right: 0;
  bottom: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--control-h-sm);
  height: var(--control-h-sm);
  padding: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 50%;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
  color: var(--fg-secondary);
  cursor: pointer;
  /* Quiet at rest so the status line reads through it, solid the moment it is
     aimed at. The status text underneath is the one line the user watches
     constantly; this is chrome, and chrome should defer to it until wanted. */
  opacity: 0.55;
  transition:
    opacity var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.rail:hover,
.rail:focus-visible {
  opacity: 1;
  background: var(--surface-2);
  color: var(--fg);
}
/* A draft waiting is exactly when this should stop deferring. */
.rail.unsent {
  opacity: 1;
}
/* docs/POLISH.md §2.4: a status mark is a CSS circle, not a glyph, so it stops
   scaling with font metrics. The ring is the panel surface, so the pip reads
   against whatever terminal output happens to be behind the button. */
.unsent-pip {
  position: absolute;
  top: -1px;
  right: -1px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 2px var(--surface);
}
.rail:hover {
  background: var(--surface-2);
  color: var(--fg-secondary);
}

/* ---- resize grips -------------------------------------------------------
 * Overlays on the card's edges, NOT rows in its flex column: an edge strip that
 * took part in the layout would steal 6px from the draft on every side it
 * touched, and the corners could not exist at all. Each sits over the card's
 * own padding, so none of them covers the textarea.
 *
 * Corners are declared after edges here as well as in the template, so they win
 * the hit test at the four points where both would answer.
 */
.grip {
  position: absolute;
  z-index: 2;
}
.grip-n,
.grip-s {
  left: 0;
  right: 0;
  height: 6px;
  cursor: ns-resize;
}
.grip-n {
  top: 0;
}
.grip-s {
  bottom: 0;
}
.grip-e,
.grip-w {
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: ew-resize;
}
.grip-w {
  left: 0;
}
.grip-e {
  right: 0;
}
.grip-nw,
.grip-ne,
.grip-sw,
.grip-se {
  width: 14px;
  height: 14px;
}
.grip-nw {
  top: 0;
  left: 0;
  cursor: nwse-resize;
}
.grip-ne {
  top: 0;
  right: 0;
  cursor: nesw-resize;
}
.grip-sw {
  bottom: 0;
  left: 0;
  cursor: nesw-resize;
}
.grip-se {
  bottom: 0;
  right: 0;
  cursor: nwse-resize;
}
/* The top edge keeps the sash's look: transparent until the cursor rests on it,
   then VS Code's accent bar. The card is not `overflow: hidden` — the slash
   dropdown deliberately escapes above it — so this closes its own corners. */
.grip.sash {
  background: transparent;
  border-radius: var(--r-xl) var(--r-xl) 0 0;
  transition: background var(--dur-fast) var(--ease);
}
.grip.sash:hover {
  background: var(--accent-dim);
}
/* Anything clickable that reaches into the 6px edge band has to sit above the
   grips, or the grip swallows a click that was aimed at the button. */
.panel-action,
.send {
  position: relative;
  z-index: 3;
}
.sash:hover {
  background: var(--accent-dim);
}

/* ---- panel toolbar, and the card's title bar ---------------------------- */
.panel-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: var(--tabbar-h);
  padding: 0 var(--sp-2) 0 var(--sp-3);
  border-bottom: 1px solid var(--border-soft);
  /* It is the move handle. `user-select` matters as much as the cursor: without
     it a drag that starts on the title paints a text selection across the strip
     while the card moves. */
  cursor: move;
  user-select: none;
}
.panel-title {
  font-size: var(--fs-100);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--fg);
  flex: 0 0 auto;
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
