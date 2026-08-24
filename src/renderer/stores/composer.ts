import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../ipc';
import type { AttachmentSource, ConnectionId } from '../../shared/types';
import {
  appendAttachmentPaths,
  appendSeededPrompt,
  attachmentDisplayName,
  COMPOSER_STRINGS,
  insertCommandText,
} from '../../shared/composerText';
import { composerTiming, withTimeout } from '../../shared/composerSend';

/**
 * Prompt-composer state, one record per session.
 *
 * The Android original keeps a SINGLE activity-scoped ViewModel shared by every
 * session on a host (PromptComposerViewModel.kt:813-820), which is why it needs
 * the #746 "owner stamp" that DISCARDS a draft when you switch sessions. That
 * mechanism is deliberately NOT ported (docs/COMPOSER.md §12.4): a keyed map
 * satisfies the same user-visible invariant — a draft never appears in a session
 * it was not authored in — while being strictly better, because switching away
 * and back restores your prompt instead of destroying it.
 *
 * Every action below maps one-for-one onto a Kotlin method so the port stays
 * auditable; the citations are in the doc comments.
 */

/** Three modes, per session, persisted (docs/COMPOSER.md §12). */
export type ComposerMode = 'hidden' | 'docked' | 'expanded';

export interface StagedAttachment {
  /** Stable identity — dedupe and removal both key off this. */
  remotePath: string;
  displayName: string;
  mimeType?: string;
  /** Images only, for the tile thumbnail. Never persisted (can be megabytes). */
  previewDataUrl?: string;
}

export interface ComposerSessionState {
  draft: string;
  attachments: StagedAttachment[];
  mode: ComposerMode;
  /** The mode to restore when the rail is re-opened. */
  lastOpenMode: 'docked' | 'expanded';
  error: string | null;
  sendInFlight: boolean;
  /** 0 = idle. Mirrors Android's AttachmentUploadState. */
  uploadingCount: number;
  connectionDegraded: boolean;
  /** User-dragged height in px; null = the default for the mode. */
  height: number | null;
  /** Caret offset, so a session switch restores where you were typing. */
  caret: number;
}

/** Fields worth surviving an app restart (§23.6). */
interface PersistedState {
  draft: string;
  attachments: Omit<StagedAttachment, 'previewDataUrl'>[];
  mode: ComposerMode;
  lastOpenMode: 'docked' | 'expanded';
  height: number | null;
  caret: number;
}

const STORAGE_KEY = 'pocketshell.composer.v1';

function blankState(): ComposerSessionState {
  return {
    draft: '',
    attachments: [],
    mode: 'docked',
    lastOpenMode: 'docked',
    error: null,
    sendInFlight: false,
    uploadingCount: 0,
    connectionDegraded: false,
    height: null,
    caret: 0,
  };
}

/**
 * A staging batch in flight. Android cancels the coroutine; we cannot un-send an
 * IPC call that is already on the wire, so we mark the batch instead and drop
 * its result when it lands. Two cancel reasons, both discarding:
 *   'send'    — the user hit Send mid-upload, so the send goes out with the
 *               tiles already staged (:684-688) and the late batch is abandoned
 *               rather than materialising tiles for a prompt that already left.
 *   'discard' — the user hit Discard (:783-800).
 * Note this is cancellation, NOT the #570 partial-failure path: a result that
 * arrives normally always keeps its survivors, even when `ok` is false.
 */
interface Batch {
  cancel: null | 'send' | 'discard';
}

export const useComposerStore = defineStore('composer', () => {
  const states = ref<Record<string, ComposerSessionState>>(loadPersisted());
  const batches = new Map<string, Batch>();
  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  // -------------------------------------------------------------------------
  // Persistence — the desktop replacement for SavedStateHandle (:2544, :2558).
  // -------------------------------------------------------------------------

  function loadPersisted(): Record<string, ComposerSessionState> {
    if (typeof localStorage === 'undefined') return {};
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, PersistedState>;
      const out: Record<string, ComposerSessionState> = {};
      for (const [key, value] of Object.entries(parsed)) {
        out[key] = {
          ...blankState(),
          draft: value.draft ?? '',
          attachments: (value.attachments ?? []).map((a) => ({ ...a })),
          mode: value.mode ?? 'docked',
          lastOpenMode: value.lastOpenMode ?? 'docked',
          height: value.height ?? null,
          caret: value.caret ?? 0,
        };
      }
      return out;
    } catch {
      // A corrupt blob must never stop the app booting.
      return {};
    }
  }

  function schedulePersist(): void {
    if (typeof localStorage === 'undefined') return;
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = setTimeout(persistNow, 250);
  }

  function persistNow(): void {
    persistTimer = null;
    if (typeof localStorage === 'undefined') return;
    const out: Record<string, PersistedState> = {};
    for (const [key, s] of Object.entries(states.value)) {
      if (s.draft === '' && s.attachments.length === 0 && s.mode === 'docked') continue;
      out[key] = {
        draft: s.draft,
        attachments: s.attachments.map(({ remotePath, displayName, mimeType }) => ({
          remotePath,
          displayName,
          ...(mimeType === undefined ? {} : { mimeType }),
        })),
        mode: s.mode,
        lastOpenMode: s.lastOpenMode,
        height: s.height,
        caret: s.caret,
      };
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch {
      // Quota or a locked profile — losing a draft on restart beats throwing.
    }
  }

  // -------------------------------------------------------------------------
  // Access
  // -------------------------------------------------------------------------

  /** The key a composer record lives under. Mirrors `"$hostId/$sessionName"`. */
  function targetKey(connectionId: string | null, sessionName: string): string {
    return `${connectionId ?? 'none'}/${sessionName}`;
  }

  /**
   * The record for `key`, creating a blank one on first touch. Always returns
   * the value read back OUT of the ref, so callers mutate the reactive proxy
   * rather than the raw object they just put in.
   */
  function ensure(key: string): ComposerSessionState {
    const existing = states.value[key];
    if (existing) return existing;
    states.value = { ...states.value, [key]: blankState() };
    return states.value[key] as ComposerSessionState;
  }

  // -------------------------------------------------------------------------
  // Draft
  // -------------------------------------------------------------------------

  /** Android: `onDraftChange` (:286-300). Any keystroke also CLEARS the error. */
  function setDraft(key: string, text: string, caret?: number): void {
    const s = ensure(key);
    s.draft = text;
    s.error = null;
    if (caret !== undefined) s.caret = caret;
    schedulePersist();
  }

  function setCaret(key: string, caret: number): void {
    ensure(key).caret = caret;
  }

  /** Android: `seedDraftPrompt` (:482-497) — Files' "attach to composer". */
  function seedPrompt(key: string, prompt: string): void {
    const s = ensure(key);
    s.draft = appendSeededPrompt(s.draft, prompt);
    s.caret = s.draft.length;
    s.error = null;
    schedulePersist();
  }

  /** Android: `prefillEngineCommand` (:508) — tapping a rendered `/clear`. */
  function prefillCommand(key: string, commandText: string): void {
    const s = ensure(key);
    const [text, caret] = insertCommandText(s.draft, commandText);
    s.draft = text;
    s.caret = caret;
    s.error = null;
    schedulePersist();
  }

  /**
   * Android: `discardDraft` (:783-800). The ONLY user control that throws work
   * away — the `×` / Escape / a session switch never do. Cancels an in-flight
   * upload first, then clears draft, tiles and banner. The composer stays open.
   */
  function discard(key: string): void {
    const batch = batches.get(key);
    if (batch) batch.cancel = 'discard';
    const s = ensure(key);
    s.draft = '';
    s.attachments = [];
    s.error = null;
    s.uploadingCount = 0;
    s.caret = 0;
    schedulePersist();
  }

  // -------------------------------------------------------------------------
  // Attachments
  // -------------------------------------------------------------------------

  /** Android: `mergeStagedPaths` (:403-427) — de-dupe by remotePath, append. */
  function mergePaths(
    s: ComposerSessionState,
    paths: readonly string[],
    previews?: ReadonlyMap<string, string>,
  ): void {
    const seen = new Set(s.attachments.map((a) => a.remotePath));
    const added: StagedAttachment[] = [];
    for (const path of paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      const preview = previews?.get(path);
      added.push({
        remotePath: path,
        displayName: attachmentDisplayName(path),
        ...(preview === undefined ? {} : { previewDataUrl: preview }),
      });
    }
    if (added.length) s.attachments = [...s.attachments, ...added];
  }

  /**
   * Android: `attachFiles` (:311-390).
   *
   * Single-flight: a second call while a batch is in flight is a no-op (:315).
   * Partial failure (#570) keeps the survivors AND shows the error (:355-373) —
   * `StageAttachmentsResult` already encodes that contract, so never discard a
   * non-empty `paths` just because `ok` is false.
   *
   * Attaching NEVER mutates the draft (:301-309). The paths are folded in at
   * send time and only at send time.
   */
  async function stage(
    key: string,
    payload: {
      connectionId: ConnectionId;
      scopeKey: string;
      sources: AttachmentSource[];
      /** Local object/data URLs, by source index, for image tile thumbnails. */
      previews?: (string | undefined)[];
    },
  ): Promise<void> {
    const s = ensure(key);
    if (s.uploadingCount > 0) return; // single-flight
    if (payload.sources.length === 0) return;

    const batch: Batch = { cancel: null };
    batches.set(key, batch);
    s.uploadingCount = payload.sources.length;
    s.error = null;

    const result = await withTimeout(
      api.attachments.stage({
        connectionId: payload.connectionId,
        scopeKey: payload.scopeKey,
        sources: payload.sources,
      }),
      composerTiming.uploadTimeoutMs,
    );

    if (batches.get(key) === batch) batches.delete(key);
    // Cancelled batches land silently: no tiles, no banner. See `Batch`.
    if (batch.cancel !== null) return;
    s.uploadingCount = 0;

    if (result === null) {
      s.error = COMPOSER_STRINGS.attachmentFailed('upload timed out');
      return;
    }

    // The stager returns paths in source order, so previews line up by index.
    const previews = new Map<string, string>();
    if (payload.previews) {
      result.paths.forEach((path, i) => {
        const preview = payload.previews?.[i];
        if (preview) previews.set(path, preview);
      });
    }
    // #570: a partial batch keeps every survivor AND shows the error.
    mergePaths(s, result.paths, previews);

    if (!result.ok) {
      s.error = COMPOSER_STRINGS.attachmentFailed(result.error ?? `${result.failedCount} failed`);
    }
    schedulePersist();
  }

  /** Android: `seedAttachment` (:443-473) — attach an already-uploaded path. */
  function seedAttachment(key: string, remotePath: string): void {
    mergePaths(ensure(key), [remotePath]);
    schedulePersist();
  }

  /** Android: `removeAttachment` (:528-546). Never touches the draft (:520-527). */
  function removeAttachment(key: string, remotePath: string): void {
    const s = ensure(key);
    s.attachments = s.attachments.filter((a) => a.remotePath !== remotePath);
    schedulePersist();
  }

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------

  /** Android: the Send button's enabled predicate (PromptComposerSheet.kt:1202). */
  function canSend(key: string): boolean {
    const s = states.value[key];
    if (!s) return false;
    return (s.draft.length > 0 || s.attachments.length > 0) && !s.sendInFlight;
  }

  /** The exact text that Send will deliver, for previews and for tests. */
  function composedPayload(key: string): string {
    const s = states.value[key];
    if (!s) return '';
    return appendAttachmentPaths(
      s.draft,
      s.attachments.map((a) => a.remotePath),
    );
  }

  /**
   * Android: `dispatchSendNow` (:661-712) + `markSendDelivered` (:725) +
   * `restoreFailedSend` (:746).
   *
   * The single most user-visible rule here is #745: the draft and the tiles STAY
   * ON SCREEN while the send is in flight. Clearing optimistically is what made
   * the phone "first lose the message, then keep the sheet open".
   *
   * `deliver` is injected so the transport (bracketed paste into a PTY) stays in
   * the component and this store stays unit-testable.
   */
  async function send(
    key: string,
    deliver: (payload: string) => Promise<boolean>,
  ): Promise<boolean> {
    const s = ensure(key);
    if (s.sendInFlight) return false; // :662
    const payload = composedPayload(key);
    if (payload.trim() === '') return false; // :672

    // :684-688 — sending mid-upload abandons the batch and sends what is staged.
    const batch = batches.get(key);
    if (batch) {
      batch.cancel = 'send';
      s.uploadingCount = 0;
    }

    s.sendInFlight = true;
    s.error = null;

    let ok = false;
    try {
      ok = (await withTimeout(deliver(payload), composerTiming.sendTimeoutMs)) === true;
    } catch {
      ok = false;
    }
    s.sendInFlight = false;

    if (ok) {
      markDelivered(key);
      return true;
    }
    restoreFailedSend(key, payload);
    return false;
  }

  /**
   * Android: `markSendDelivered` (:725-737), minus the dismissal.
   *
   * DELIBERATE DIVERGENCE (docs/COMPOSER.md §12.3): the phone closes the sheet
   * on delivery because a modal sheet occludes the terminal on a phone screen.
   * The desktop composer is docked and is the primary interaction surface, so it
   * stays open and focused, ready for the next prompt.
   */
  function markDelivered(key: string): void {
    const s = ensure(key);
    s.draft = '';
    s.attachments = [];
    s.error = null;
    s.uploadingCount = 0;
    s.caret = 0;
    if (s.mode === 'hidden') setMode(key, s.lastOpenMode);
    schedulePersist();
  }

  /**
   * Android: `restoreFailedSend` (:746-774).
   *
   * The COMPOSED payload — attachment paths already folded in — goes back into
   * the draft and the tiles are DROPPED, precisely so a resend does not
   * double-append the paths (:768-770).
   */
  function restoreFailedSend(key: string, payload: string, message?: string): void {
    const s = ensure(key);
    s.draft = payload;
    s.caret = payload.length;
    s.attachments = [];
    s.error = message ?? COMPOSER_STRINGS.notSent;
    s.sendInFlight = false;
    schedulePersist();
  }

  /** Android: `setConnectionDegraded` (:850-853). Advisory only — never a block. */
  function setConnectionDegraded(key: string, degraded: boolean): void {
    ensure(key).connectionDegraded = degraded;
  }

  // -------------------------------------------------------------------------
  // Visibility state machine (desktop only — docs/COMPOSER.md §12.1)
  // -------------------------------------------------------------------------

  function setMode(key: string, mode: ComposerMode): void {
    const s = ensure(key);
    if (mode !== 'hidden') s.lastOpenMode = mode;
    s.mode = mode;
    schedulePersist();
  }

  /** `hidden` -> the last non-hidden mode; anything else -> `hidden`. */
  function toggleHidden(key: string): void {
    const s = ensure(key);
    setMode(key, s.mode === 'hidden' ? s.lastOpenMode : 'hidden');
  }

  /** `hidden -> docked -> expanded`. */
  function grow(key: string): void {
    const s = ensure(key);
    if (s.mode === 'hidden') setMode(key, 'docked');
    else if (s.mode === 'docked') setMode(key, 'expanded');
  }

  /** `expanded -> docked -> hidden`. */
  function shrink(key: string): void {
    const s = ensure(key);
    if (s.mode === 'expanded') setMode(key, 'docked');
    else if (s.mode === 'docked') setMode(key, 'hidden');
  }

  function setHeight(key: string, height: number | null): void {
    ensure(key).height = height;
    schedulePersist();
  }

  return {
    states,
    targetKey,
    ensure,
    setDraft,
    setCaret,
    seedPrompt,
    prefillCommand,
    discard,
    stage,
    seedAttachment,
    removeAttachment,
    canSend,
    composedPayload,
    send,
    markDelivered,
    restoreFailedSend,
    setConnectionDegraded,
    setMode,
    toggleHidden,
    grow,
    shrink,
    setHeight,
    persistNow,
  };
});
