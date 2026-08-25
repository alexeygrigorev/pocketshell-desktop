# Prompt Composer — Desktop Implementation Spec

Status: **built.** `src/renderer/components/PromptComposer.vue` +
`src/renderer/stores/composer.ts` implement Part II. Where the code and this
document have since diverged, the code won; the sections that were revised
against it say so inline (§12 and §21 are the two that changed shape).

**Citation convention.** Paths starting `app/` or `core/` are in the Android
repo at `C:\Users\alexey\git\pocketshell`. Paths starting `src/` or `docs/` are
in this repo, `C:\Users\alexey\git\pocketshell-electron`. Every behavioural
claim in Part I carries a `file:line`.

Part I documents the phone app as built, so the desktop can be implemented
without re-reading Kotlin. Part II is the desktop spec.

---

# Part I — The Android composer, as built

## 1. Where it lives, who owns it, how it opens

The composer is a **Material 3 modal bottom sheet** hosted by the *session*
screen, not by a tab.

- Entry point composable: `PromptComposerSheet` — `app/src/main/java/com/pocketshell/app/composer/PromptComposerSheet.kt:179`.
- Body renderer (pure, previewable, and what every instrumented test drives):
  `SheetContent` — `PromptComposerSheet.kt:516`.
- State owner: `PromptComposerViewModel` — `app/src/main/java/com/pocketshell/app/composer/PromptComposerViewModel.kt`.
- Host wiring: `app/src/main/java/com/pocketshell/app/tmux/TmuxSessionScreen.kt:2194-2281`.

**Scope of the ViewModel: activity-scoped, shared across every session on a
host.** This is stated at `PromptComposerViewModel.kt:813-820` and is the direct
cause of issue #746 (drafts bleeding between sessions), which the app then works
around with an owner stamp (§4.4). The composer is *not* per-tab: the Terminal /
Conversation tab choice only selects the **send route**
(`TmuxSessionScreen.kt:2184-2186`, `:3163-3179`), never a different composer.
The draft is scoped by session, via `composerTargetKey = "$hostId/$sessionName"`
(`TmuxSessionScreen.kt:2207`).

Open triggers (all set the host's `showMicSheet` flag):

| Trigger | Site |
| --- | --- |
| Composer launcher chip in the bottom control row (unconditional — needs no live pane) | `TmuxSessionScreen.kt:1873` |
| Tapping a rendered engine command in the terminal (`/clear` etc.) — pre-fills the draft, then opens | `TmuxSessionScreen.kt:722-727` |
| Share-into-session intent — seeds attachment tiles, then opens | `TmuxSessionScreen.kt:616-620` |
| File viewer's "Attach to current session" — seeds a review prompt into the draft, then opens | `TmuxSessionScreen.kt:629-633` |

Close triggers: header `×` (`PromptComposerSheet.kt:820-836`), scrim tap,
swipe-down, system Back (`TmuxSessionScreen.kt:5559` routes Back to
`onDismissMicSheet` before any other handler), and a **successful** send
(`PromptComposerSheet.kt:322-323`). All of them run `dismissComposer`
(`PromptComposerSheet.kt:361-364`), which releases the mic and calls the host's
`onDismiss` — **and deliberately preserves the draft** (stated at
`PromptComposerViewModel.kt:779-782`).

## 2. Anatomy

`SheetContent` renders, top to bottom (`PromptComposerSheet.kt:770-1280`):

1. **Slash-command dropdown** (`:780-786`) — floats at the *top* of the column,
   above the field, so the IME can never occlude it. Only when the leading token
   is a `/` and the filtered catalog is non-empty.
2. **Header** — "Prompt Composer" title + a 32dp circular `×` chip (`:802-841`).
   Hidden entirely when the soft keyboard is up (§3).
3. **Scroll region** (`:862-877`, `weight(1f, fill = false)` + `verticalScroll`)
   containing, in order:
   - **Draft field** (`ComposerDraftField`, `:918-937`): multi-line, placeholder
     `"Compose prompt…"` (`:2829`), `minHeight` 96dp keyboard-down / 56dp
     keyboard-up, `maxHeight` 220dp, self-scrolling to keep the caret visible.
     Test tag `prompt-composer-draft`.
   - **Error / status banner** (`:944-990`) with an inline **Discard** button
     whenever there is something to clear
     (`canDiscard = draft.isNotEmpty() || attachments.isNotEmpty()`, `:951`).
   - **Attachment upload progress** — `"Uploading N attachment(s)..."` (`:992-1015`).
   - Saved-audio confirmation, pending-transcription queue banner (voice only —
     not ported).
   - **Staged attachment tiles** — `AttachmentTileGrid` (`:1068-1073`, renderer
     at `:1893`): compact square tiles, image thumbnail or file-type tile, each
     with an `×` remove control. Tag `prompt-composer-attachment-chips`.
4. **Connection-lost row** (`:1088-1110`) — deliberately *outside* the scroll
   region so it is sticky above the Send row. Copy:
   `"Connection lost — Send will retry once reconnected."`
5. **Control row** (`:1130-1280`), sticky:
   - Left: one rounded pill grouping **📎 attach** (`:1157`), **`{}` snippets**
     (`:1162`), **`/` slash** (`:1170`). All three disable while transcribing or
     while an attachment batch is uploading; `/` additionally disables when no
     agent is detected.
   - Spacer.
   - Right: a single primary **Send** button (`:1208`), then the mic disc.

There is **no** separate "Insert" button and **no** keyboard-raise button — both
were removed (`:2761-2769`, `:1181-1188`).

## 3. Visibility / expand state machine — the important part

`ComposerPartialExpandE2eTest` is where the current truth is written, and it is
*not* what its own name suggests. Read
`app/src/androidTest/java/com/pocketshell/app/composer/ComposerPartialExpandE2eTest.kt:146-179`:
the test **no longer asserts the `PartiallyExpanded` enum**. It asserts two
user-facing invariants instead, because forcing the partial anchor by
over-sizing the content is exactly what shipped the #615 regression.

The as-built machine has **three sheet values × two IME states**, and the app
treats the IME dimension as chrome, not as a state:

### 3.1 Sheet values (Material 3 `SheetValue`)

| Value | How reached | Notes |
| --- | --- | --- |
| `Hidden` | Not composed (`showMicSheet == false`), or dismissed | Draft survives (§4) |
| `PartiallyExpanded` | Default landing state — `rememberModalBottomSheetState(skipPartiallyExpanded = false)` (`PromptComposerSheet.kt:216`) | The compact resting state |
| `Expanded` | User drags the sheet upward | **Unreachable while the keyboard is up** — the `Expanded` anchor *is* the IME-resized `maxHeight`, so `expand()` is a no-op (`PromptComposerSheet.kt:721-724`) |

The sheet is **content-height (wrap-content)**, not a height fraction
(`PromptComposerSheet.kt:370-392`). #615 made it a fully-expanded sheet plus a
manual IME inset and produced a keyboard-height void, a jump-to-top and a
cut-off; #682 reverted to wrap-content.

### 3.2 The invariant that actually matters

From `ComposerPartialExpandE2eTest.kt:154-179`, asserted with real geometry:

1. The sheet is **open** (non-`Hidden`).
2. The **terminal text above it stays readable** — the marker text is
   `assertIsDisplayed()` *while* the composer is composed.
3. The draft field's `boundsInRoot.top > rootHeight * 0.25` — the composer is
   confined to the lower portion of the screen.

That is the whole "modal inversion" goal (#191/#234): never occlude the agent
output you are composing against.

### 3.3 The keyboard-up chrome variant (#801)

When `WindowInsets.ime` is non-zero (`PromptComposerSheet.kt:735-741`):

- The body is capped to `maxHeight - (ime - navBars)` — measured at ~175dp on a
  Pixel 7 (`:702-733`).
- The **header is dropped entirely** (`:802`), reclaiming ~58dp.
- Draft `minHeight` drops 96dp → 56dp (`:932`).
- Keyboard-down only, the scroll region additionally caps at 360dp
  (`:868-876`, constant at `:2910`).

Everything in this subsection is a soft-keyboard artifact. **None of it ports.**

### 3.4 What persists across visibility transitions

Everything the user authored. Dismissal (`×`, scrim, Back, swipe) calls only
`cancelRecording()` + `onDismiss()` (`PromptComposerSheet.kt:361-364`); it never
touches the draft, the attachment tiles, or the error banner. Only three things
clear state: a confirmed delivery, an explicit Discard, and a session switch
(§4).

## 4. Draft lifecycle

### 4.1 Every edit is mirrored and persisted

`onDraftChange` (`PromptComposerViewModel.kt:286-300`) writes the text to
`SavedStateHandle[KEY_DRAFT]`, stamps `KEY_DRAFT_OWNER` with the current target
(null when the text is empty), updates `uiState.draft`, and **clears
`uiState.error`**. Keys at `:2544` and `:2558`. Restored on construction at
`:117`.

### 4.2 Send does not clear optimistically (#745)

`dispatchSendNow` (`:661-712`) flips `sendInFlight = true`, clears the error,
emits a `SendRequest` on a buffered `Channel` — and **leaves the draft and the
tiles on screen**. `PromptComposerSendDismissE2eTest.kt:48-55` states the bug
this fixed: "first the message disappears from the Composer and then sometimes
the Composer stays on the screen."

- **Delivered** → `markSendDelivered()` (`:725-737`) clears attachments, resets
  upload state, `onDraftChange("")`, then the host dismisses the sheet
  (`PromptComposerSheet.kt:322-323`).
- **Failed or timed out** → `restoreFailedSend()` (`:746-774`). The composer
  **stays open**. It puts the *composed* payload (text **with** the attachment
  paths already folded in) back in the draft, sets
  `"Not sent. Reconnect, then send again or discard the draft."`, and **drops
  the attachment tiles** — explicitly so the resend does not double-append the
  paths (`:768-770`). Proven end-to-end at
  `PromptComposerSendDismissE2eTest.kt:271-298`: the restored draft still
  contains both the attachment path and the typed text, and a later successful
  resend still carries the path.
- Timeout: the host `onSend` is wrapped in
  `withTimeoutOrNull(SEND_TIMEOUT_MS)` where `SEND_TIMEOUT_MS = 12_000`
  (`PromptComposerSheet.kt:314`, constant at `PromptComposerViewModel.kt:2535`).
  A timeout is treated exactly like a `false`.

### 4.3 Discard is the only user control that throws work away

`discardDraft()` (`:783-800`): cancels any in-flight attachment upload, clears
the draft, the tiles, the error, and both `SavedStateHandle` keys. Surfaced
*only* as the `Discard` button inside the error banner
(`PromptComposerSheet.kt:970-985`, tag `prompt-composer-discard`).
`PromptComposerDiscardE2eTest.kt:160-226` pins it: after Discard the draft is
`""`, `error` is `null`, the banner is gone, and **the composer is still open**.

The header `×` explicitly does **not** discard (`PromptComposerViewModel.kt:781`).

### 4.4 Session switch discards a foreign draft

`onComposerTargetChanged(targetKey)` (`:813-840`), called from
`LaunchedEffect(composerTargetKey)` (`PromptComposerSheet.kt:343-345`):

- no draft and no attachments → no-op;
- `draftOwner == null` (restored from process death before a target was known) →
  **adopt** the new target;
- `draftOwner != targetKey` → `discardDraft()`.

`PromptComposerDiscardE2eTest.kt:231-276` proves a "Not sent" draft authored in
session A is gone (draft `""`, error `null`, banner absent) after retargeting to
session B.

**This whole mechanism only exists because the ViewModel is a single
activity-scoped instance.** See §12.4 for why the desktop must not port it.

### 4.5 Summary table

| Event | Draft | Attachment tiles | Error banner | Composer open? |
| --- | --- | --- | --- | --- |
| Dismiss (`×`, scrim, Back, swipe) | kept | kept | kept | closed |
| Send tapped (in flight) | kept, visible | kept, visible | cleared | open, Send disabled + spinner |
| Send delivered | cleared | cleared | cleared | **closed** |
| Send failed / 12s timeout | replaced by composed payload | **dropped** (folded into text) | "Not sent…" + Discard | **open** |
| Discard tapped | cleared | cleared | cleared | open |
| Switch to another session | discarded if owned elsewhere | discarded with it | cleared | — |
| Process death / rotation | restored from `SavedStateHandle` | **lost** (not persisted) | lost | — |
| Any keystroke | — | — | **cleared** (`:299`) | — |

## 5. Send — composition, routing, delivery

### 5.1 The composition rule (load-bearing)

`appendAttachmentPaths` — `PromptComposerViewModel.kt:2645-2660`:

```kotlin
internal fun appendAttachmentPaths(draft: String, paths: List<String>): String {
    if (paths.isEmpty()) return draft
    val block = buildString {
        append("Attached files:")
        paths.forEach { path -> append('\n'); append("- "); append(path) }
    }
    return when {
        draft.isBlank()            -> block
        draft.endsWith("\n\n")     -> draft + block
        draft.endsWith("\n")       -> draft + "\n" + block
        else                       -> draft + "\n\n" + block
    }
}
```

In words: the staged remote paths are **appended at the end**, never prepended,
as a `Attached files:` header followed by one `- <remote path>` line per
attachment, separated from the user's text by **exactly one blank line**. A
blank draft (whitespace-only counts) is *replaced* by the block, so an
attachment-only send is legal. Example:

```
what is wrong here

Attached files:
- ~/.pocketshell/attachments/main/20260824-101500-01-shot.png
- ~/.pocketshell/attachments/main/20260824-101500-02-log.txt
```

Called once, at send time only, from `dispatchSendNow` (`:670`). The draft text
is **never** mutated by attaching — stated at `:301-309`, `:2176-2179`,
`:407-410`.

### 5.2 Send gating

- Button enabled predicate (`PromptComposerSheet.kt:1202-1207`):
  `(liveEditorText.isNotEmpty() || attachments.isNotEmpty()) && !sendInFlight`.
  It reads the **live editor value**, not the ViewModel draft — issue #491, so
  an uncommitted IME composing region still enables Send.
- ViewModel guards (`:662`, `:672`): no-op if a send is already in flight; no-op
  if the *composed* text is empty.
- Sending while an attachment batch is still uploading **cancels the upload**
  and sends what has already been staged (`:684-688`).

### 5.3 "Send" vs "Send + Enter"

`SendRequest` carries `withEnter` (`PromptComposerViewModel.kt:2298-2301`) — but
**inside the composer it is always `true`**. Every send affordance calls
`onSend(true)`: `commitAndSend` (`PromptComposerSheet.kt:678`), the recording
`StopSendButton` (`:1250`), the transcribing `StopSendButton` (`:1270`). Issue
#453 collapsed the old Insert/Send pair into one button whose tag is still
`prompt-composer-send-enter` (`:2761-2769`).

The `withEnter = false` half survives **only outside the composer**, in the
snippet picker's explicit `Send` / `Send + ↵` chips
(`app/src/main/java/com/pocketshell/app/snippets/SnippetPickerSheet.kt:414-440`).
That is issue #187: the fix was to replace a smart-default tap surface with two
explicitly-labelled actions, and per **D22** (`docs/decisions.md:30`,
hard-cuts-only) the legacy row-body smart-default was deleted rather than kept
behind a flag (`TmuxSessionScreen.kt:2286-2291`).

**Desktop consequence:** the composer has exactly one Send verb, and it submits.
Do not build an Insert/Send pair.

### 5.4 Routing

`TmuxComposerSendRoute` — `TmuxSessionScreen.kt:3159`, decision function at
`:3163-3179`:

```kotlin
when {
    viewingConversation                    -> AgentConversation
    withEnter && liveAgent == Codex        -> AgentPayload
    liveAgent != null                      -> RawBytes
    presumedAgentKind != null              -> AgentPayload
    else                                   -> RawBytes
}
```

where `viewingConversation = detection != null && selectedTab == Conversation`
(`:2184-2186`).

| Route | Transport | Extra |
| --- | --- | --- |
| `AgentConversation` | `sendToAgentPaneResult(paneId, text)` | Also echoes an optimistic user turn into the transcript |
| `AgentPayload` | `sendAgentPayloadToPaneResult(paneId, text, agentKind)` | Bracketed paste + a submit-delay before Enter |
| `RawBytes` | `writeInputToPaneResult(paneId, (withEnter ? text + "\r" : text).toByteArray())` (`:2258-2262`) | — |

### 5.5 Multi-line delivery — bracketed paste (#209). Do not skip this.

Because §5.1 *always* introduces newlines when attachments are staged, and
because the user can type newlines, the payload is routinely multi-line. Naïve
delivery would make an agent REPL submit each line as a separate prompt — the
bug found in daily use on 2026-05-27
(`app/src/main/java/com/pocketshell/app/tmux/TmuxSessionViewModel.kt:9775-9795`).

Both agent routes and the raw route converge on `sendInputBytesToPane`
(`TmuxSessionViewModel.kt:9758`), which wraps any input containing a line break
(or exceeding a chunk size) in **bracketed-paste markers `\e[200~` … `\e[201~`**
before the submit key (`:9860-9870`,
`sendAgentPayloadToPaneResult` at `:8760-8781`).

The agent path additionally waits before pressing Enter (issue #526,
`:8786-8812`): default 150ms (`app/src/main/java/com/pocketshell/app/settings/SettingsModels.kt:271`),
with a 250ms floor for Codex (`TmuxSessionViewModel.kt:12135`), so Enter cannot
race the TUI's paste ingestion.

## 6. Attachments in the composer

Staged attachments are **structured state, never folded into the draft while
composing** — `StagedAttachment(remotePath, displayName, previewUri, mimeType)`
at `PromptComposerViewModel.kt:2183-2189`, list at `:2245`.

- **Staging**: `attachFiles(count, previews, stage)` (`:311-390`). Single-flight
  — a second call while a batch is in flight is a no-op (`:315`). Bounded by
  `ATTACHMENT_UPLOAD_TIMEOUT_MS = 90_000` (`:326`, `:2521`).
- **Merge**: `mergeStagedPaths` (`:403-427`) de-duplicates by `remotePath` and
  appends in order.
- **Partial failure (#570)**: a `PartialAttachmentUploadException` carries the
  paths that *did* upload; those are attached **and** the error is shown
  (`:355-373`). Never discard survivors.
- **Display name**: last path segment only, never the full remote path —
  `attachmentDisplayName` (`:2675-2679`).
- **Removal**: `removeAttachment(remotePath)` (`:528-546`) — identity is the
  remote path; the draft is untouched.
- **Seeding**: `seedAttachment(remotePath)` (`:443-473`) attaches an
  already-uploaded path without re-uploading (the share-into-session flow),
  de-duplicating.
- **Remote location**: `~/.pocketshell/attachments/<scope>/`
  (`app/src/main/java/com/pocketshell/app/composer/PromptAttachmentStager.kt:212`).
- **Failure copy**: `"Attachment upload failed: <detail>. Your draft was kept;
  reconnect or choose a smaller/readable file."` (`:2681-2689`).

Behavioural proof that attach and typing coexist:
`PromptComposerSendDismissE2eTest.kt:227-268` — attach first, then type; both the
tile and the typed text must be visible, and the draft must still be `""`
immediately after attaching.

## 7. Slash commands

Per issue #787 / D22 the standalone `AgentCommandSheet` palette and the bottom
`/ commands` chip were **deleted**; slash entry now lives *only* in the composer
(`TmuxSessionScreen.kt:2324-2330`).

Pure logic in `app/src/main/java/com/pocketshell/app/composer/SlashCommandAutocomplete.kt`:

- **`slashQueryFor(value)`** (`:47-61`) — dropdown open iff the text starts with
  `/` **and** the caret (selection start) is within the leading token (token =
  up to the first whitespace). Returns the substring after `/` up to that
  whitespace. A bare `/` yields `""` → the full catalog. Typing a space and
  moving on to the argument **closes** the dropdown.
- **`filteredCommands(agent, query)`** (`:68-71`) — empty list when `agent` is
  null. A shell pane never gets a dropdown.
- **`insertCommand`/`insertCommandText`** (`:81-105`) — replaces the leading
  slash token if one exists, otherwise prepends; preserves any trailing text;
  adds one trailing space for argument-taking commands; caret lands at the end
  of the inserted command.

Catalog source: `app/src/main/java/com/pocketshell/app/agentcommands/AgentCommandCatalog.kt:83`
— an **app-shipped, per-agent curated list** (30 `AgentCommand` entries across
Claude Code / Codex / OpenCode), deliberately *not* user CRUD. `commandsFor` at
`:257`, substring `filter` over command + label + description at `:268-277`.

Renderer: `SlashCommandDropdown` (`PromptComposerSheet.kt:1297-1370`) — one
command per row, mono accent token leading, inline `<arg>` hint, ≤2-line wrapping
description, height-capped at 196dp (`:2915`) and self-scrolling. The duplicate
right-side badge was a D22 hard-cut (`:1306-1310`).

The `/` **button** (`:1170-1174`, handler `:650-656`) is not a second picker: it
seeds a leading `/` into the field and focuses it, which makes `slashQueryFor`
non-null with a blank query — the same dropdown.
`PromptComposerSlashButtonTest.kt:111-157` proves the button opens the full
catalog and picking a row inserts it; `:158-170` proves the button is *disabled*
on a shell pane. `PromptComposerSlashDropdownImeContainmentProofTest.kt:44-62`
proves the dropdown filters (`/comp` shows `/compact`, hides `/clear`) and stays
fully inside the window.

## 8. Snippets

The `{}` button opens `SnippetPickerSheet` over the composer with
`kindFilter = Prompt` (`PromptComposerSheet.kt:455-481`).

**Composer-specific invariant** (`:456-472`): a pick **appends to the draft and
never sends**. The picker's `withEnter` signal is deliberately ignored — inside
the composer the compose-then-send safety rule wins. Separator: `""` if the draft
is empty or already ends with `\n` or a space, else `" "`.

Outside the composer the same picker *does* send directly, gated on liveness
(`TmuxSessionScreen.kt:2295-2320`).

## 9. Liveness guards

`sessionLive = status is ConnectionStatus.Connected` (`TmuxSessionScreen.kt:399`)
is the single source of truth.

- **Send is not gated.** Issue #548: send is *connect-on-action* — if the control
  channel dropped while the composer was open, the ViewModel kicks/reuses a
  reconnect and awaits the live client before returning failure
  (`TmuxSessionScreen.kt:2214-2218`). The 12s timeout (§4.2) converts a truly
  dead link into the "Not sent" banner.
- **Attach is not gated.** Issue #451: the file picker backgrounds the app, so on
  return the session may be briefly absent; `stagePromptAttachments` lazily
  reconnects and awaits (`TmuxSessionScreen.kt:2273-2280`).
- **Advisory indicator, not a block.** `connectionLost = !sessionLive` is pushed
  in (`:2212`) → `setConnectionDegraded` (`PromptComposerViewModel.kt:850-853`,
  documented as advisory at `:841-849`) → the sticky "Connection lost" row.
- **The snippet picker outside the composer *is* hard-gated** on `sessionLive`
  (issue #249, `TmuxSessionScreen.kt:2302-2308`), as are terminal hotkeys. The
  asymmetry is intentional: a composed prompt is worth reconnecting for; a
  keystroke is not.

## 10. Voice (documented for completeness — not ported)

Roughly two thirds of `PromptComposerViewModel.kt` is dictation: a three-state
FSM `Idle / Recording / Transcribing` (`:2150`), Whisper and Android-speech
providers (`:856-1060`), an amplitude sampler and silence watchdog
(`:1062-1130`), a swipe-up mic lock (`:621-639`), a pending-transcription retry
queue (`:1780-1960`), an API-key vault dialog, keep-screen-on, and a
`Send`-while-recording queue (`requestSend`, `:605-618`). None of it has a
desktop analogue. See §22.

---

# Part II — Desktop specification

## 11. Where the composer lives in the new navigation

**Position: the composer is per-session, owned by the session workspace shell,
and shared by the Terminal and Conversation tabs. It is not rendered on Files,
Ports, or Usage.**

Justification, grounded in the phone:

1. The phone hosts the composer on the **session screen**, above the tab body —
   `TmuxSessionScreen.kt:2194`. One instance spans both tabs.
2. The Terminal/Conversation choice changes only the **send route**, never the
   composer (`:2184-2186`, `:3163-3179`). If the composer were per-tab, that
   branch would not need to exist.
3. The draft's identity is the **session**: `"$hostId/$sessionName"` (`:2207`).
   Not the tab, not the host.
4. The phone's Files surface does **not** host a composer. It offers "Attach to
   current session", which seeds the session's composer draft and navigates back
   (`PromptComposerViewModel.seedDraftPrompt`, `:482-497`, wired at
   `TmuxSessionScreen.kt:629-633`). Desktop Files should mirror this with a
   "Send to composer" / "Attach to composer" action per file, not a second
   composer.

The navigation restructure has already landed and left the slot open. The mount
point is `.session-body` in `src/renderer/views/SessionWorkspaceView.vue`, a
column whose tab content flexes. **Revised (§21.1):** the composer does not dock
*below* that content as originally specified — it floats *over* it, out of a
`.composer-dock` positioned against `.session-body`, and the column reserves a
constant strip at the bottom instead of giving up a flex row. Route:
`/host/:name/session/:session`
(`src/renderer/router.ts:23-27`); session identity is
`route.params['session']` (`SessionWorkspaceView.vue:28`).

```
SessionWorkspaceView                      (src/renderer/views/SessionWorkspaceView.vue)
├── header (session name, close)
├── tabs  [Terminal] [Conversation] [Files]
├── .tab-body                     ← flex: 1, min-height: 0
│     ├── TerminalView            v-show (stays mounted — :76-84)
│     ├── ConversationView        v-if   (:86-90)
│     └── FilesView               v-if   (:92)
└── <PromptComposer/>             ← flex: none; NEW, at the :94 slot
```

The composer must be **mounted once** at the workspace level, outside
`.tab-body`, and kept alive across tab switches (never `v-if` on the tab) so the
draft, caret, and scroll position survive a tab change. Render it only when
`tab !== 'files'`; use `v-show` for that toggle, not `v-if`.

Note that vue-router reuses the `SessionWorkspaceView` instance when only the
`:session` param changes, so the composer component is **not** remounted on a
session switch. That is fine and in fact desirable — the store is keyed by
session (§15), so a `watch` on `sessionName` is all that is needed to swap which
record the component reads.

Because the user wants the composer to be the primary surface, the workspace
should **focus the composer draft on mount** when the session's persisted mode is
`docked` or `expanded`.

## 12. Visibility state machine (desktop)

Three states, **app-level** (not per session), persisted.

```ts
type ComposerMode = 'hidden' | 'docked' | 'expanded';
```

| State | Rendering | Geometry |
| --- | --- | --- |
| `hidden` | A **rail pill**: chevron, `PROMPT` label, the waiting draft's first line (or the `Compose prompt…` placeholder), an attachment-count badge, and the `Ctrl+\`` hint | 32px tall, shrink-to-fit, **pinned** to the dock's bottom-right corner (§21.4) |
| `docked` (default) | Full card | the remembered geometry: position and size, both dragged by the user, default 720—240 in the resting corner |
| `expanded` | Same card, maximized | fills the dock: full width, height capped at 80% of the body. Ignores the remembered geometry, which `docked` returns to |

The `hidden` rail is a **desktop addition** and is deliberate: the phone loses
the composer entirely when closed, so a preserved "Not sent" draft becomes
invisible (issue #695's complaint class). A persistent rail costs 32px and
guarantees a stale draft is always discoverable.

**Revised — the mode is not per session.** It was, and the bug that produced
was immediate: a session the composer had never been opened on started from
`blankState()`, whose mode is `docked`, so closing the panel and selecting
another session brought it straight back. Open/closed/maximized is a
**preference about the tool**; the draft, its attachments, the caret and the
dragged height are **facts about a session**. Only the second group is keyed by
`targetKey`. `lastOpenMode` moved with the mode, so closing and re-opening still
restores docked-vs-maximized — it just does so once for the app rather than once
per session.

### 12.1 Transitions

| From | Trigger | To |
| --- | --- | --- |
| `hidden` | click the rail / `Ctrl+Shift+K` / `Ctrl+Shift+↑` | `docked`, draft focused |
| `hidden` | a seed action (slash command tapped in the terminal, "send to composer" from Files, paste-to-attach) | `docked`, draft focused |
| `docked` | `Ctrl+Shift+K` / `Ctrl+Shift+↓` / chevron | `hidden` |
| `docked` | `Ctrl+Shift+↑` / drag the top handle above threshold / double-click the handle | `expanded` |
| `expanded` | `Ctrl+Shift+↓` / `Escape` (see §12.2) / drag the handle down | `docked` |
| any | **successful** send | the last open mode (never `hidden` — see §12.3) |
| any | failed send | unchanged, banner shown |
| any | session switch | **unchanged.** The panel does not open or close because you changed session; only which draft it shows changes (revised — see §12) |

### 12.2 Escape ladder (ordered; first match wins)

1. Slash dropdown open → close the dropdown only.
2. `expanded` → `docked`.
3. `docked` and the draft focused → blur, return focus to the terminal. Composer
   stays visible.
4. `docked` and not focused → `hidden`.

**Escape must never clear the draft.** This mirrors the phone's rule that the
`×` preserves the draft for resend (`PromptComposerViewModel.kt:779-782`).
Discarding is Discard's job and Discard's alone (§4.3).

### 12.3 A successful send does not hide the composer

The phone dismisses the sheet on delivery (`PromptComposerSheet.kt:322-323`)
because the sheet occludes the terminal on a phone screen. On desktop the
composer is a non-modal floating card — no scrim, nothing to dismiss — and the
user asked to interact *primarily* through it. So: on delivery, clear the draft
and the tiles, keep the card open and focused, ready for the next prompt. This is a deliberate,
justified divergence — record it in the component's header comment.

### 12.4 What persists — and the one mechanism NOT to port

Per session key, everything persists across every mode transition and every tab
switch: draft text, caret/selection, staged attachments, error banner and scroll
position. The **mode and the card's geometry are not among them** — both are
app-level, stored under their own key (§12, §15). The height moved to that side
with the rest of the geometry: a box split across two scopes would have to be
assembled from two places on every render.

**Do not port the #746 owner-stamp discard-on-switch mechanism.** It exists
solely because the Android ViewModel is a single activity-scoped instance shared
by all sessions (`PromptComposerViewModel.kt:813-820`). A Pinia store can hold a
`Map<targetKey, ComposerSessionState>`, so the desktop keeps a **per-session
draft** — which satisfies the same user-visible invariant the Android hack
enforces ("a draft never appears in a session it was not authored in") while
being strictly better: switching away and back restores your prompt instead of
destroying it. Persist the map via `electron-store` so drafts survive an app
restart, replacing `SavedStateHandle` (`:2544`, `:2558`) — and, unlike Android,
persist the attachment list too (Android loses it on process death because only
`KEY_DRAFT` is saved).

## 13. Files and component tree

```
src/shared/
  composerText.ts            pure: appendAttachmentPaths, slashQueryFor,
                             filteredCommands, insertCommandText, attachmentDisplayName
  agentCommands.ts           ported AgentCommandCatalog (data + filter)
  types.ts                   += StagedAttachment, ComposerMode, ComposerSendRoute

src/renderer/stores/
  composer.ts                Pinia store, keyed by session target

src/renderer/components/
  PromptComposer.vue         the whole composer; owns layout + shortcuts
  ComposerDraftField.vue     <textarea> + placeholder + autosize (optional split)
  ComposerAttachmentTiles.vue
  SlashCommandDropdown.vue

src/renderer/views/
  SessionWorkspaceView.vue   (owned by the navigation agent) mounts <PromptComposer/>
```

All components `<script setup lang="ts">`, matching
`src/renderer/views/ConversationView.vue:1` and
`src/renderer/components/TerminalView.vue:1`, with a top-of-file block comment
explaining the component's job, as every existing file does.

## 14. Pure helpers (`src/shared/composerText.ts`)

Port these verbatim in behaviour; they are the only parts of the Kotlin with
unit-test-grade contracts.

```ts
/** Android: PromptComposerViewModel.kt:2645. Appends the staged remote paths
 *  at the END of the draft, one blank line apart, as a bullet list. */
export function appendAttachmentPaths(draft: string, paths: string[]): string {
  if (paths.length === 0) return draft;
  const block = 'Attached files:' + paths.map((p) => `\n- ${p}`).join('');
  if (draft.trim() === '') return block;          // Kotlin isBlank()
  if (draft.endsWith('\n\n')) return draft + block;
  if (draft.endsWith('\n')) return draft + '\n' + block;
  return draft + '\n\n' + block;
}

/** Android: SlashCommandAutocomplete.kt:47. Null = dropdown closed. */
export function slashQueryFor(text: string, caret: number): string | null {
  if (!text.startsWith('/')) return null;
  const ws = text.search(/\s/);
  const tokenEnd = ws < 0 ? text.length : ws;
  if (caret < 0 || caret > tokenEnd) return null;
  return text.slice(1, tokenEnd);
}

/** Android: SlashCommandAutocomplete.kt:94. Returns [newText, newCaret]. */
export function insertCommandText(text: string, commandText: string): [string, number] {
  let tokenEnd = 0;
  if (text.startsWith('/')) {
    const ws = text.search(/\s/);
    tokenEnd = ws < 0 ? text.length : ws;
  }
  return [commandText + text.slice(tokenEnd), commandText.length];
}

/** Android: PromptComposerViewModel.kt:2675. Last path segment, never the full path. */
export function attachmentDisplayName(remotePath: string): string {
  const trimmed = remotePath.replace(/\/+$/, '');
  const seg = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return seg.trim() === '' ? remotePath : seg;
}
```

Note the Kotlin `isBlank()` vs `isEmpty()` distinction in the first function — a
whitespace-only draft is *replaced* by the attachment block, not appended to.

## 15. Pinia store (`src/renderer/stores/composer.ts`)

Follow the `defineStore(id, setup)` style used by
`src/renderer/stores/connection.ts:15` and `stores/agents.ts:16`.

```ts
export interface StagedAttachment {
  remotePath: string;      // stable identity, e.g. ~/.pocketshell/attachments/main/…png
  displayName: string;
  mimeType?: string;
  previewDataUrl?: string; // images only, for the tile thumbnail
}

export interface ComposerSessionState {
  draft: string;
  attachments: StagedAttachment[];
  error: string | null;
  sendInFlight: boolean;
  uploadingCount: number;      // 0 = idle;  Android AttachmentUploadState
  connectionDegraded: boolean;
  height: number | null;       // user-dragged px, null = the default 240
  caret: number;
}
```

Keyed by `targetKey = `${connectionId}/${sessionName}``, mirroring the phone's
`"$hostId/$sessionName"` (`TmuxSessionScreen.kt:2207`).

**Not keyed** (revised, §12): `mode`, `lastOpenMode` and `geometry` are plain refs
on the store, persisted under `pocketshell.composer.visibility.v1` — a second key
rather than a version bump of `pocketshell.composer.v1`, so the drafts already on
disk survive the change and an old blob's per-session `mode`/`height` are simply
ignored. That key keeps its `visibility` name even though the payload has since
grown `geometry`: renaming it would orphan the blob and silently reopen every
user's composer, and a stale name is cheaper than a lost preference. A record
with no draft and no attachments is not written at all: `ensure()` touches a key
for every session merely visited, and without that filter the blob grows one
empty entry per session forever.

`geometry` is stored RAW and never re-clamped to the current pane. A window that
is briefly made small would otherwise permanently rewrite the user's layout to
whatever fitted it; the component clamps for display instead (§21.1).

Actions, one-for-one with the Kotlin so the mapping stays auditable:

| Store action | Android counterpart |
| --- | --- |
| `setDraft(key, text)` — also clears `error` | `onDraftChange` `:286` |
| `stage(key, sources)` — single-flight, 90s timeout, dedupe, keeps partial survivors | `attachFiles` `:311` + `mergeStagedPaths` `:403` |
| `seedAttachment(key, remotePath)` | `seedAttachment` `:443` |
| `seedPrompt(key, prompt)` — appends on its own line if a draft exists | `seedDraftPrompt` `:482` |
| `prefillCommand(key, command)` | `prefillEngineCommand` `:508` |
| `removeAttachment(key, remotePath)` | `removeAttachment` `:528` |
| `send(key)` | `requestSend`/`dispatchSendNow` `:605`/`:661` |
| `markDelivered(key)` | `markSendDelivered` `:725` |
| `restoreFailedSend(key, payload, message?)` | `restoreFailedSend` `:746` |
| `discard(key)` — cancels an in-flight upload first | `discardDraft` `:783` |
| `setConnectionDegraded(key, boolean)` | `setConnectionDegraded` `:850` |
| `setMode(mode)` / `toggleHidden()` / `grow()` / `shrink()` — **no key**, §12 | *(desktop only)* |
| `setGeometry(box)` / `resetGeometry()` — **no key**, §21.1 | *(desktop only)* |

Copy the strings exactly:

- `'Not sent. Reconnect, then send again or discard the draft.'` (`:747`)
- `'Connection lost — Send will retry once reconnected.'` (`PromptComposerSheet.kt:1102`)
- `'Attachment upload failed: <detail>. Your draft was kept; reconnect or choose a smaller/readable file.'` (`:2687`)
- `'Uploading N attachment(s)...'` (`PromptComposerSheet.kt:1010`)
- placeholder `'Compose prompt…'` (`PromptComposerSheet.kt:2829`)

## 16. Send path

### 16.1 Sequence

1. Compose: `payload = appendAttachmentPaths(draft, attachments.map(a => a.remotePath))`.
2. Guard: return if `payload === ''` or `sendInFlight` (`:662`, `:672`).
3. If an upload is in flight, abort it and send with the tiles already staged
   (`:684-688`).
4. `sendInFlight = true`, `error = null`. **Leave the draft and the tiles on
   screen** — this is #745 and it is the single most user-visible send rule.
5. Deliver (§16.2) with a 12 000 ms timeout (`SEND_TIMEOUT_MS`, `:2535`).
6. Delivered → `markDelivered` (clear draft + tiles, keep the composer open and
   focused, §12.3). Not delivered or timed out → `restoreFailedSend(payload)`:
   put the **composed** payload back in the draft, drop the tiles, show the
   banner with a Discard button.

### 16.2 Transport, and the bracketed-paste requirement

The desktop writes into a PTY running `tmux attach` via
`api.shell.input(shellId, data)`
(`src/preload/index.ts:70`, channel `shell:input` at `src/shared/channels.ts:21`).
There is no tmux control-mode client here, so **the renderer must apply the
bracketed-paste framing itself** — the Android side gets it for free inside
`sendInputBytesToPane` (`TmuxSessionViewModel.kt:9758-9800`, `:9860-9870`).

```ts
const BP_START = '\x1b[200~';
const BP_END   = '\x1b[201~';

async function deliver(shellId: ShellId, payload: string): Promise<boolean> {
  const needsPaste = payload.includes('\n') || payload.includes('\r');
  const body = needsPaste ? BP_START + payload + BP_END : payload;
  const wrote = await api.shell.input(shellId, body);
  if (!wrote) return false;
  if (submitDelayMs > 0) await sleep(submitDelayMs);   // #526
  return api.shell.input(shellId, '\r');
}
```

Rules, each from the Kotlin:

- Wrap in `\e[200~`/`\e[201~` whenever the payload contains a line break
  (`TmuxSessionViewModel.kt:9781-9795`). Since §5.1 always adds newlines when
  attachments are staged, **any attachment send is a paste send**. Getting this
  wrong makes each line of an attachment block a separate agent prompt.
- Send the submit `\r` **separately, after** the paste block, never inside it
  (`:8777-8780`).
- Wait between the body and the Enter: default 150 ms
  (`SettingsModels.kt:271`), floor 250 ms for Codex
  (`TmuxSessionViewModel.kt:12135`). Until desktop has agent detection, use
  250 ms unconditionally — it is the safe end of the range.
- Programs that do not enable bracketed paste render the markers literally; the
  Kotlin accepts that degradation explicitly (`:9793-9795`). Do the same.

### 16.3 Routing

Port the enum shape now, with only the raw arm implemented, so the agent-aware
arms can be filled in without reshaping the call site:

```ts
export type ComposerSendRoute = 'agent-conversation' | 'agent-payload' | 'raw';
```

Decision function mirroring `tmuxComposerSendRoute` (`TmuxSessionScreen.kt:3163`):
`viewingConversation → 'agent-conversation'`; `liveAgent === 'codex' →
'agent-payload'`; `liveAgent → 'raw'`; `presumedAgent → 'agent-payload'`; else
`'raw'`. Today the desktop has no agent detection (`src/main/helper/parsers.ts`
knows engine names only for log reading), so `liveAgent`/`presumedAgent` are
`null` and every send takes `'raw'`. Keep the function pure and unit-test it
against the five cases exactly as `TmuxSessionScreenTest.kt:687-748` does.

`'agent-conversation'` additionally requires echoing an optimistic user turn into
the conversation view; defer it until the Conversation tab has a live transcript.

### 16.4 Only one Send verb

Per §5.3 the composer submits, always. Do not build Insert/Send. If a "stage
without submitting" affordance is ever wanted, it belongs in a snippet-style
surface outside the composer, per #187.

## 17. Attachments (composer side)

The upload backend is another agent's work (`src/main/attachments/AttachmentStager.ts`,
IPC `attachments:stage` / `attachments:pickFiles` at `src/shared/channels.ts:56-59`,
typed at `src/preload/index.ts:224-242`). The composer only consumes it.

- Call `api.attachments.stage({ connectionId, scopeKey, sources })` where
  `scopeKey` is the session name (the phone scopes per session —
  `PromptAttachmentStager.kt:47-49`).
- `StageAttachmentsResult` (`src/shared/types.ts:133`) already encodes the #570
  partial-failure contract: **when `ok === false` but `paths` is non-empty,
  attach those paths anyway and show `error`.** Do not throw the survivors away.
- Build tiles with `attachmentDisplayName(path)` — the file name, never the full
  remote path (`PromptComposerViewModel.kt:2675`).
- De-duplicate by `remotePath` (`:409-412`).
- Single-flight: ignore a second stage call while one is in flight (`:315`);
  disable the attach button meanwhile, but leave typing and text-only Send live
  (`PromptComposerSheet.kt:1150-1156`).
- 90 s timeout (`:2521`).
- Removing a tile never touches the draft (`:520-527`).
- After a failed send the tiles are gone and their paths live in the draft text
  (§4.2) — the resend must not re-append them.

Sources: `{ kind: 'file', path }` for the picker and drag-and-drop;
`{ kind: 'bytes', data, name, mimeType }` for clipboard paste
(`src/shared/types.ts:107-124`).

## 18. Slash commands

- Port `AgentCommandCatalog` to `src/shared/agentCommands.ts` as plain data
  (30 entries, `AgentCommandCatalog.kt:83-256`) plus the substring filter over
  command + label + description (`:268-277`). It is an app-shipped curated
  catalog, not user CRUD — do not build editing UI for it.
- Dropdown opens when `slashQueryFor(text, caret) !== null` **and** the filtered
  list is non-empty (`PromptComposerSheet.kt:631`).
- Position it **above** the draft field (`:780-786`).
- Cap at ~196px with internal scroll (`:2915`).
- Row: mono accent command token, inline `<arg>` hint for argument-taking
  commands, ≤2-line wrapping description, one command per row.
- Keyboard: `↑`/`↓` move the highlight, `Enter` or `Tab` accepts, `Escape`
  closes the dropdown only. This is a desktop addition — the phone is tap-only.
- The `/` toolbar button seeds a leading `/` and focuses the field; it is not a
  separate palette (`:650-656`).
- Disabled when no agent kind is known (`:1170-1174`,
  `SlashCommandAutocomplete.kt:68-70`). **Until desktop has agent detection the
  `/` button is permanently disabled and the dropdown never opens** — build the
  plumbing, gate it on a `agentKind: AgentKind | null` prop, and let the
  detection work light it up. Do not invent a desktop-only fallback catalog;
  that would violate the "never offer an unavailable command" rule.

## 19. Snippets — deferred

The desktop has no snippet storage at all (`grep -ri snippet src/` returns only
`docs/ANALYSIS.md:44`). Ship the composer without the `{}` button. When snippets
land, the rule to implement is §8: a pick **appends to the draft, never sends**,
with the `""`/`" "` separator rule from `PromptComposerSheet.kt:466-472`.

## 20. Keyboard shortcuts (recommended)

Register global chords on `window` with `{ capture: true }` in the workspace
shell and `preventDefault()` + `stopPropagation()` on match, so xterm's textarea
never sees them. `TerminalView.vue` has already claimed the
`Ctrl/Cmd+Shift+…` namespace for app chords (Ctrl/Cmd+Shift+V paste,
`components/TerminalView.vue:11-12`), which is why every global here is a
Shift-chord: bare `Ctrl+K`, `Ctrl+L`, `Ctrl+A`, `Ctrl+E`, `Ctrl+R` are all real
terminal keys and must keep reaching the pane.

**Global (workspace scope)**

| Chord | Action |
| --- | --- |
| `Ctrl/Cmd+Shift+K` | Toggle `hidden` ⇄ last non-hidden mode; focus the draft when opening |
| `Ctrl/Cmd+Shift+↑` | Grow: `hidden → docked → expanded` |
| `Ctrl/Cmd+Shift+↓` | Shrink: `expanded → docked → hidden` |
| `Ctrl/Cmd+Shift+A` | Attach files (open the native picker) |

**Draft-focused scope**

| Key | Action |
| --- | --- |
| `Enter` | Send (submits — §5.3) |
| `Shift+Enter` | Newline |
| `Ctrl/Cmd+Enter` | Send (alias, so muscle memory from other tools works) |
| `Escape` | The ladder in §12.2 — never destroys the draft |
| `/` as the first character | Opens the slash dropdown (via `slashQueryFor`, not a keybinding) |
| `↑`/`↓`, `Enter`/`Tab` | Navigate / accept in the slash dropdown when open |
| `Ctrl/Cmd+V` | Paste; non-text clipboard items become attachments (§23) |
| `Ctrl/Cmd+Shift+Backspace` | Discard draft (the Discard button remains the primary affordance) |

`Enter`-sends is the correct default here because the phone's single Send always
submits (§5.3) and the composer's whole purpose is submitting prompts. Do **not**
add a settings toggle for "Enter inserts a newline" — D22 (`docs/decisions.md:30`)
forbids settings flags for alternate behaviours; `Shift+Enter` is the escape
hatch.

## 21. Styling and geometry

**Superseded palette.** This section originally named the Catppuccin values
(`#1e1e2e` / `#cdd6f4` / `#89b4fa` …) and the literal `#181825` panel fill. The
app has since moved to the token set in `docs/DESIGN.md` §4.3, and
`tests/unit/designGates.test.ts` now fails any raw hex outside `App.vue`. The
mapping is: panel chrome `var(--surface)`, draft-box fill `var(--bg)`, draft
border `var(--border-strong)` (WCAG 1.4.11 — an input's boundary must be ≥3:1),
accent `var(--accent)`, muted text `var(--fg-secondary)`.

### 21.1 The composer FLOATS, and the user places it

The composer is not a docked row, not a full-bleed strip, and no longer even
fixed to a corner. It is a card the user can drag anywhere in the session body
and resize from any edge.

```
 .session-body            position: relative
 └── .composer-dock       position: absolute; inset: var(--composer-inset)
                          pointer-events: none      ← the terminal stays clickable
     └── .composer        position: absolute; right/bottom/width/height inline
                          pointer-events: auto
```

**The dock is INSET, not padded.** An absolutely positioned child resolves its
offsets against its containing block's *padding* box, so padding on the dock
would not have held the card off the pane's edges. Insetting the dock itself
does, and it buys something better: `right: 0; bottom: 0` now *means* the
resting corner, so `src/shared/composerGeometry.ts` never has to know what the
inset is. The dock has already subtracted it.

**Geometry** is four numbers, in dock coordinates, measured from the corner the
card rests in:

```ts
interface ComposerGeometry { right: number; bottom: number; width: number; height: number }
```

`right`/`bottom` rather than `left`/`top` because the card's home is the
bottom-right: the resting state is two zeroes instead of arithmetic over the
pane size, and a pane that gets *shorter* carries the card up with its bottom
edge instead of pushing it out of sight. The left and top edges are derived when
a resize needs them.

| | |
|---|---|
| Move handle | the **header strip** — the card's title bar, `cursor: move`, `user-select: none`. Presses that land on the maximize/close buttons are excluded; double-clicking it maximizes, as a title bar does everywhere |
| Resize | **all four edges and all four corners**, 6px strips and 14px corner boxes overlaid on the card's own padding, so none of them covers the textarea. The top one keeps the old sash's look and its double-click. Corners are declared after edges so they win the hit test where both would answer |
| Floors | 360—190. 360 leaves ~40 mono columns beside the tools pill and Send; 190 is the height at which the toolbar, two draft lines, the tiles and the Send row all still fit |
| Cap | 80% of the pane's height, and never wider or taller than the pane |
| Containment | clamped **fully inside** the pane, always. The strongest form of "never draggable off-screen": there is no partially-lost state to recover from, so no rescue affordance is needed |
| Snapping | on mouse-**up** after a MOVE only, 12px, each axis independently, to that axis's two flush positions. Never during a drag (DESIGN.md §5.9 wants pointer-1:1) and never after a resize, which would silently change the size just chosen |
| Maximize | fills the dock — full width, capped height. Deliberately unlike the resting card: "maximize" is a request for all the room there is, a different question from how wide a prompt wants to be |
| Corners / elevation | `--r-xl` and `0 8px 32px rgba(0,0,0,.5)` — §5.5's `OverlayPanel` treatment with the Y offset pulled in from 16px, because a card that can sit flush against the bottom of its dock would throw that shadow off the pane and leave its *top* edge, the one with terminal text behind it, unseparated |

Every rule above is pure arithmetic in `src/shared/composerGeometry.ts` and is
unit-tested in `tests/unit/composerGeometry.test.ts`. The component's only job
is to measure the dock (one `ResizeObserver`) and feed deltas in.

Dragging a **maximized** card leaves the maximized state and keeps the box it
had, exactly like dragging a maximized OS window restores it under the cursor.

### 21.2 The terminal-never-resizes guarantee

`.tab-body.with-composer` reserves
`calc(var(--composer-rail-h) + var(--composer-inset))` — **permanently**, open
or closed, moved or resized or mid-drag. The terminal is therefore sized as
though the composer were closed and stays that size whatever the card does, so
opening a prompt is never an SSH window-change and never makes the remote tmux
reflow.

**Moving and resizing did not weaken this.** The dock is an overlay: it takes no
part in the tab body's layout, so no card geometry can reach the terminal's box.
What *did* change is what the reserve is for. It used to be "the strip the pill
lives in"; it is now "the strip the composer's resting place lives in", and it
is the one piece of the composer's geometry the user cannot move — see §21.4.

Both constants are declared on `.session-workspace` in `SessionWorkspaceView.vue`
rather than in `App.vue`'s `:root`: they describe that pane's relationship with
the composer, and custom properties inherit, so the reserved space and the card's
inset are guaranteed to be the same number.

### 21.3 Inside the card

Ported from the phone: draft box `var(--r-lg)` radius, 1px border, `min-height`
46px (two lines — below that the caret line is clipped in half), internal scroll
past that; the tools pill 22px radius (`PromptComposerSheet.kt:1146-1150`); slash
dropdown `max-height` 196px (`:2915`), rendered **above** the card's top edge.
That last one is why the card is *not* `overflow: hidden`, which in turn is why
`.sash` closes the card's top corners itself.

`<style scoped>` per component, matching every existing view.
### 21.4 The collapsed pill stays in the corner

The card moves; the pill does not. Closing a card the user has dragged to the
middle of the pane puts the pill back in the dock's bottom-right corner, and
re-opening restores the card to where they left it.

That asymmetry is deliberate, and the reserve is the argument. The pane gives up
`rail + inset` px of terminal **forever** so that a closed composer costs
nothing and stays visible. That budget is only honest if the pill actually lives
in the strip it paid for: a pill that wandered with the card would cover
terminal rows — including tmux's status line — while the app went on reserving
a strip nobody used. It also keeps the pill where the eye already learnt to look,
which is the entire job of a collapsed rail (§12), and it keeps a 32px target
free of any drag-versus-click ambiguity.


## 22. Deliberately NOT ported

| Dropped | Why |
| --- | --- |
| **Voice / Whisper dictation** — the mic button, the `Idle/Recording/Transcribing` FSM (`PromptComposerViewModel.kt:2150`), the amplitude waveform (`PromptComposerSheet.kt:2231`), the mm:ss timer, the silence watchdog (`:1062-1130`), the swipe-up mic lock (`:621-639`), `Insert`/`Send` stop actions (`:1225-1275`), keep-screen-on (`:585-590`) | The desktop has no audio-capture dependency, no OpenAI key vault, and no permission flow. This is ~60% of the Kotlin ViewModel and ~40% of the sheet. Dropping it removes the *entire reason* `requestSend` has a queue-until-transcription branch (`:605-618`) — desktop `send()` is a straight-line call. |
| **Pending-transcription queue** — banner, per-item retry/discard/save-as-audio, foreground-resume auto-retry (`:1780-1960`, `PromptComposerSheet.kt:2386-2600`) | Exists only to salvage failed Whisper round-trips. |
| **API-key entry dialog** (`PromptComposerSheet.kt:2684`) | Whisper-only. |
| **Everything IME** — the `keyboardUp` chrome variant (§3.3), the header-drop at `:802`, the 96↔56dp draft floor swap at `:932`, the `maxHeight - (ime - navBars)` room formula at `:735-741`, the `weight(1f, fill = false)` squish arithmetic at `:869`, `contentWindowInsets` at `:392-397`, and the six regression tests (`PromptComposerImeSquishProofTest`, `PromptComposerImeTightScreenSquishProofTest`, `PromptComposerImeEmptyDraftDeadSpaceProofTest`, `PromptComposerImeLayoutRegressionTest`, `PromptComposerSheetImeReachabilityTest`, `PromptComposerLongDraftCaretVisibleTest`) | A desktop window has no soft keyboard, so there is no dead space, no squish, and no IME-resized window. The composer is a flex child of a fixed-height column. **Do not port any reserve constant, any height cap keyed on an inset, or any "hide the header when …" rule.** The one durable lesson to keep is the invariant those tests were protecting: the Send row must always be reachable and a long draft must scroll *within* the composer instead of pushing the controls out of view — which on desktop is `overflow-y: auto` on the draft plus `flex: none` on the control row. |
| **`TextFieldValue` composing-region handling** (#491, `UnifiedComposer.kt:42-60`, `PromptComposerSheet.kt:597-613`) | A DOM `<textarea>`'s `.value` is always the visible text; there is no uncommitted composing region to miss. Read `.value` directly. (IME composition for CJK still exists in the DOM — guard Enter-to-send with `event.isComposing` and that is the whole of it.) |
| **`SavedStateHandle` mirroring + the #746 owner stamp** (`:2544`, `:2558`, `:813-840`) | Replaced by a per-session map in Pinia persisted through `electron-store` — see §12.4. |
| **Modal bottom sheet, scrim, drag anchors, swipe-to-dismiss, `BackHandler`** (`PromptComposerSheet.kt:366`, `TmuxSessionScreen.kt:5543-5564`) | The desktop composer floats but is never modal: no scrim, the terminal behind it stays live and clickable. Escape replaces Back; the chevron and the shortcuts replace the swipe. |
| **Mic-release-on-dismiss** (`:361-364`) | No mic. |

## 23. What desktop should ADD

1. **The `hidden` rail** (§12) — the phone has no equivalent; it just vanishes.
2. **Real keyboard shortcuts** (§20) — the phone is tap-only and its only
   "keyboard" concerns are IME dead space.
3. **Keyboard navigation of the slash dropdown** (§18) — the phone requires a tap
   on a row.
4. **Paste-to-attach.** On the draft's `paste` event, inspect
   `event.clipboardData.files` and `.items`. If any item is not `text/plain`,
   `preventDefault()` and stage them as
   `{ kind: 'bytes', data, name, mimeType }` (`src/shared/types.ts:108-116`);
   plain text pastes normally. The phone can only attach through the SAF picker
   (`PromptComposerSheet.kt:279-292`). Screenshot → paste → attached tile is the
   single biggest desktop ergonomics win here, and the IPC already supports it.
5. **Drag-and-drop onto the composer** — same staging path with
   `{ kind: 'file', path }`.
6. **Draft persistence across app restarts** — Android persists only the draft
   text and only until the process is recreated; desktop should persist draft +
   attachments + mode per session to `electron-store`.
7. **A drag handle on the composer's top edge** to resize `docked`/`expanded`,
   persisted per session — the desktop analogue of the sheet's drag anchors,
   without any of the anchor arithmetic.

## 24. Test plan

Pure unit (Vitest) — port the Kotlin's own contracts:

- `appendAttachmentPaths`: empty paths; blank draft; whitespace-only draft;
  draft ending `\n`; draft ending `\n\n`; normal draft; multiple paths and their
  order.
- `slashQueryFor`: `/` → `''`; `/comp` → `'comp'`; `/comp arg` with the caret
  after the space → `null`; caret at 0 → `''`; text not starting with `/` →
  `null`.
- `insertCommandText`: replaces an existing leading token, preserves the trailing
  text, prepends when there is no leading token, caret position.
- `sendRoute`: the five branches, mirroring `TmuxSessionScreenTest.kt:687-748`.

Component (Vue Test Utils) — port the instrumented tests' assertions:

- **Send/dismiss** (`PromptComposerSendDismissE2eTest.kt`): a successful send
  clears the draft and the tiles; a failed send keeps the composer open with the
  payload restored and the "Not sent." banner; attach-then-type shows both; a
  failed send keeps the attachment path inside the restored draft; the resend
  still carries it.
- **Discard** (`PromptComposerDiscardE2eTest.kt:160-226`): the banner exposes a
  Discard control; tapping it clears draft + attachments + banner and leaves the
  composer open.
- **Per-session isolation** (the desktop replacement for
  `:231-276`): a draft authored in session A is absent when session B is
  selected, **and present again** when A is re-selected.
- **Compactness** (`ComposerPartialExpandE2eTest.kt:154-179`): in `docked` mode
  the card occupies the bottom-right of the workspace body, inset from its edges,
  and the tab content behind it remains rendered. Assert the *terminal's* box is
  unchanged between open and closed — that is the guarantee (§21.2), and it is
  what a docked panel could not give.
- **Slash** (`PromptComposerSlashButtonTest.kt:111-170`): the `/` button opens
  the full catalog on an agent session and is disabled with no agent; typing
  `/comp` shows `/compact` and hides `/clear`.
- **Escape ladder** (§12.2), each rung, asserting the draft survives every one.

Integration (Docker `tmux`/`helper` fixtures, per `docs/TESTING.md`): compose a
two-line prompt with one staged attachment, send it, and assert with
`tmux capture-pane` that the pane received **one** submission containing both
lines and the `Attached files:` block — the bracketed-paste proof (§16.2).

## 25. Conflicts and dependencies with in-flight work

1. **Resolved — session identity.** The restructure landed while this spec was
   being written. `SessionWorkspaceView` derives the session from the route
   (`:28`), so the composer's target key is
   `` `${connection.connectionId}/${route.params['session']}` `` with no new
   store plumbing needed. The dock slot is already reserved at `:94`.
2. **BLOCKER — `shellId` is not reachable from outside `TerminalView`.** It is a
   module-local `let` (`components/TerminalView.vue:48`), never returned or
   `defineExpose`d, and the shell is opened inside the component
   (`:67-72`). The composer has nothing to write to. Fix one of two ways, both
   acceptable:
   (a) `defineExpose({ shellId })` on `TerminalView` and hold a template ref in
   `SessionWorkspaceView`; or, better,
   (b) move shell ownership into `stores/sessions.ts` as a
   `Map<sessionName, ShellId>`, so the composer, the terminal, and any future
   surface all address the same shell. **This is the one hard dependency and it
   must be agreed with whoever owns `TerminalView`.**
   Related: `TerminalView` re-opens its shell whenever `sessionKey` changes
   (`:26`), so whatever the composer reads must be reactive, not captured once.
3. **`ConversationView.vue` still owns a session-id text input** (`:53-58`)
   even though the workspace now passes `sessionId` as a prop (`:10-13`,
   `SessionWorkspaceView.vue:87`). Once the composer docks below it, that input
   should go: two text boxes on one screen, one of which is not the prompt
   composer, is exactly the confusion the user is asking to avoid.
4. **Ports and Usage no longer have a home.** `SessionWorkspaceView` exposes
   only Terminal / Conversation / Files (`:25`); the old host-level Ports and
   Usage tabs (`HostWorkspaceView.vue:22` before the restructure) are
   host-scoped and cannot become session tabs. Wherever they land, they must not
   be siblings of the composer — the composer belongs to the session workspace
   only (§11).
5. **Agent detection does not exist.** `src/main/helper/parsers.ts:130` knows
   engine names for log reading only; nothing detects which engine is live in a
   pane. Consequences: slash commands stay disabled (§18), and every send takes
   the `'raw'` route (§16.3). Both are gated behind one `agentKind` prop, so the
   detection work can enable them without touching the composer.
6. **Attachments backend contract is already settled** and the composer should
   consume it as-is: `attachments:stage` / `attachments:pickFiles`
   (`src/shared/channels.ts:56-59`), `StageAttachmentsResult`
   (`src/shared/types.ts:133-142`). Its partial-failure semantics already match
   Android #570; do not re-litigate them.
7. **No decision here changes `docs/DESIGN.md`.** If the composer's placement
   (§11) contradicts what that document says about tab ownership, this spec's
   §11 justification should be reconciled by whoever owns that file — flagged,
   not edited.
