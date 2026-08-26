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
- Sending while an attachment batch is still uploading **waits for it**, then
  sends with the image included. This note used to say the opposite — cancel the
  upload, send what is staged — citing `:684-688`; the user, who wrote the phone
  app, says that is not what it does: *"that's not how the phone app works. it
  waits"*. See §16.3.

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

> **Revised again by docs/WORKSPACE.md.** `SessionWorkspaceView` no longer
> exists: the right pane is a FOLDER workspace whose tab bar carries one tab per
> tmux session, then Files tabs, and the Conversation tab has been deleted
> outright (WORKSPACE §9). Every rule below survives the move unchanged — the
> composer is still mounted once outside the tab body, still `v-show` rather
> than `v-if`, still hidden on a Files tab, and still keyed per session. What
> changed is only WHICH session it is handed: the active SESSION TAB rather than
> the route's `:session` param. Read `SessionWorkspaceView` as
> `FolderWorkspaceView` and `.session-body` as `.workspace-body` throughout this
> section; the file/line citations are historical.

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
| `hidden` | The card is gone; the **fixed toggle** (§21.4) remains — a 24px icon button wearing a pip when a draft or attachment is waiting | pinned to the pane's bottom-right corner, floating over the terminal |
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
| `hidden` | click the fixed toggle / `Ctrl+\`` / `Ctrl+Shift+K` / `Ctrl+Shift+↑` | the last open mode, draft focused |
| `hidden` | a seed action (slash command tapped in the terminal, "send to composer" from Files, paste-to-attach) | `docked`, draft focused |
| `docked` | click the **same** fixed toggle / `Ctrl+\`` / `Ctrl+Shift+K` / `Ctrl+Shift+↓` | `hidden` |
| `docked` | `Ctrl+Shift+↑` / drag the top handle above threshold / double-click the handle | `expanded` |
| `expanded` | `Ctrl+Shift+↓` / `Escape` (see §12.2) / drag the handle down | `docked` |
| any | **successful** send | the last open mode (never `hidden` — see §12.3) |
| any | failed send | unchanged, banner shown |
| any | session switch | **unchanged.** The panel does not open or close because you changed session; only which draft it shows changes (revised — see §12) |

### 12.2 Escape closes it — and what that costs

**Escape closes the composer.** The user asked for the plain meaning of the key:
*"esc should close the prompt composer."* Two rungs, first match wins:

1. **Slash dropdown open** — close the dropdown only. It is the one thing more
   local than the panel; Escape closes what you opened last, and picking a
   command is not a reason to lose the whole composer.
2. **Otherwise** — close it, and hand focus back to the terminal.

**Escape never clears the draft.** That is Discard's job and Discard's alone
(§4.3), and it survives every close.

#### What the ladder used to be, and why it changed

It had four rungs, and two of them existed to NOT close:

```
1. slash dropdown open   -> close the dropdown
2. expanded              -> docked            (restore from maximized)
3. draft focused         -> blur to the pane, composer STAYS OPEN
4. not focused           -> hidden
```

Rung 3 was doing a second job. `typingOpensComposer` (§26.1) only intercepts
while the composer is CLOSED, so "blur to the pane and leave it open" was the
only way to get a plain terminal with that setting on — an escape hatch that
cost no new chord and fell out of the ladder for free. It was a nice piece of
design and it is why Escape did not close.

It was also, from the user's side, Escape not doing what Escape does. So the
hatch became **explicit** instead of emergent: a dismissal now suppresses the
typing intercept (below), which is the same guarantee stated out loud, and the
rungs standing between Escape and closing went with it. Restoring from maximized
is still `Ctrl+Shift+↓` and the header button, and a dismissal remembers the
mode, so re-opening a maximized composer gets it back maximized.

#### Clicking outside closes it — but only when it is empty

*"if composer is empty click outside of composer closes it."* Implemented with
three guards, each of which is the whole safety of the feature:

- **Empty only.** Empty means no draft text, no staged attachments, no failure
  banner, nothing in flight. **Whitespace-only counts as empty** — the store
  already refuses to send `payload.trim() === ''`, so three spaces are not work
  by any definition the app already uses. With anything else present the click
  does nothing: dismissing unsent work because the user clicked the terminal to
  read something would be invisible until they went looking for it.
- **Gated on the press, not the click.** The card is movable and resizable, and
  both routinely travel outside its own bounds before the button comes up.
  Keying on `mousedown` and on where it LANDED means an interaction that started
  inside the composer can never dismiss it, however far it travels.
- **Inside means inside `.composer-root`** — the card, its grips, its header,
  the pinned toggle and the doodle overlay are all descendants. The toggle in
  particular sits outside the CARD but inside the composer, so a naive handler
  would close on its press and let its own click re-open, which reads as
  nothing happening.

It does **not** suppress the typing intercept, unlike Escape. A click elsewhere
is incidental — the user reached for the terminal, not against the composer —
and the composer was empty, so nothing was lost; typing afterwards almost
certainly means they want it back. The rule that falls out, and the one to keep
in mind when adding any future dismissal:

> **A click dismisses the view. A key dismisses the intent.**

It does not move focus either: the click already decided where focus goes.

#### SUPERSEDED — "closed is two states, not one"

This section said that closing the composer YOURSELF suppressed the typing
intercept, so the next keystroke reached the shell, while a send-close did not.
The user reported the consequence:

> "I start typing, prompt composer opens, I click esc, continue typing and now
> the input goes to the terminal"

That was the design working exactly as written, and the report is a rejection of
the design rather than of the code. It is right to reject. Escape's job is to
put the panel away; reading a second, durable instruction into it — "and also
do not come back when I type" — is the old rung 3 returning in disguise, where
Escape did something other than close because the intercept needed a hatch. The
hatch was moved rather than the key overloaded again.

The superseded table is kept because the DISTINCTION it drew is still real; only
the right-hand column changed:

| Closed by | Means | Next keystroke |
|---|---|---|
| **the user** — Escape, `Ctrl+\``, `Ctrl+Shift+K`, `Ctrl+Shift+↓`, the toggle, the card's close | "put it away" | **re-opens** the composer, carrying that character |
| **a delivered send** (`closeComposerOnSend`, §26.2) | "that one's away, next?" | **re-opens** the composer, carrying that character |

All four user-close routes behave identically, which is the point: a user who
dismisses three different ways must not get three different results.

**The two paths stay distinct in the model even though they now agree.**
`dismiss()` still exists as its own action — it is where the user-close path can
be given behaviour again without hunting down four call sites, and the two
closes are different facts about the world even when they produce the same
state. Collapsing them into one boolean is precisely what the earlier design was
avoiding, and what would make them cancel each other out again the next time one
of them needs to differ.

#### The plain-terminal hatch is now a PRESS IN THE TERMINAL

`typingSuppressed` survives, and now means what its name says: the user is
typing at the shell, so withhold the intercept. It is armed by a `mousedown`
inside a terminal pane and by nothing else.

The model is that **the intent follows the pointer** — you type where you last
pointed. That is a better home for the meaning than Escape, and not only because
the user asked: pressing Escape is a statement about the PANEL, whereas pointing
at the terminal is a statement about where you intend to type. It is also the
gesture a user performs before typing at a shell anyway, so the hatch costs
nothing to reach and needs no chord in an already-full map.

It composes with the close, and the composition is the reason the hatch works:
click into the terminal, then press Escape, and typing still goes to the shell —
because Escape no longer re-arms anything. Escape ALSO hands focus back to the
pane, so every non-printable key (Ctrl-C, the arrows, Enter, tmux's prefix)
reaches the shell immediately whatever the flag says; only a printable one is at
stake.

The rule the previous revision drew still holds, with its second half rewritten:

> **A click dismisses the view. A click INTO THE TERMINAL dismisses the intent.**

`TerminalView` reports the press as a fact (`pressed`) and the workspace decides
what it means — the same division `typed` and `paste-into-composer` already use,
so the pane goes on knowing nothing about the composer.

**What lifts the suppression:**

- **any opening.** `Ctrl+\`` (the summons the user explicitly endorsed —
  *"ctrl + ` is okay"*), the toggle, `Ctrl+Shift+K`, `Ctrl+Shift+↑`, a seed
  action, an explicit Ctrl+V. `setMode` clears the flag whenever it opens the
  panel, so no caller has to remember to.
- **a press INSIDE the composer**, the exact counterpart of the press that armed
  it. The pointer moved, so the intent moved.
- **A session switch.** A decision about where you are typing spoke for the pane
  you were in; another session is a different job and very often a different
  intent.

It is not persisted — it is a statement about this moment, not a preference.

Enter is deliberately **not** bound to open the composer. It was asked for and
retracted in the same breath (*"enter should open" — "okay let's not do
enter"*), and it could not have worked anyway: Enter at a shell prompt has to
stay Enter, which is exactly why `isTypingKey` rejects it (§26.1).

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

### 16.0 An upload in flight is waited for, not abandoned

> "If I'm uploading an image and hit enter, I wait till image is uploaded and
> then send the prompt" — and, on the old rule citing the phone: "that's not how
> the phone app works. it waits"

The desktop used to mark the in-flight batch cancelled and deliver whatever was
already staged. The user attaches an image and then writes a prompt ABOUT that
image, so what went out was not a smaller version of what they asked for: it was
a question with its subject missing, to an agent that answered it anyway, having
never seen the picture.

Four things make the wait safe rather than a hang:

- **`sendInFlight` goes up BEFORE the wait.** The Send button reads it, so it
  disables; the single-flight guard reads it, so a second Enter is a no-op
  rather than a second prompt queued behind the same upload; `isEmpty` reads it,
  so a click-outside cannot dismiss a prompt parked on its own picture. #745's
  rule — draft and tiles stay on screen — simply holds through a longer wait.
- **The batch always settles.** `Batch.done` resolves on every exit including a
  throw, and the upload's own `uploadTimeoutMs` bounds the wait.
- **The payload is composed AFTER the wait.** Reading it first is precisely how
  the old rule managed to send a prompt about an image with the image missing.
- **A failed upload does not send.** The banner and the intact draft are what
  every other refusal in this store leaves behind, and the user can retry
  without retyping.

### 16.1 Sequence

1. Compose: `payload = appendAttachmentPaths(draft, attachments.map(a => a.remotePath))`.
2. Guard: return if `payload === ''` or `sendInFlight` (`:662`, `:672`).
3. If an upload is in flight, **wait for it** and compose the payload
   afterwards (§16.3).
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
`Ctrl/Cmd+Shift+…` namespace for app chords (both paste chords, Ctrl/Cmd+V and
Ctrl/Cmd+Shift+V, now land in THIS composer — see `onCustomKey` and
docs/SHORTCUTS.md §1.1), which is why every global here is a
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
     └── .composer-root   the card's world, and what the geometry measures
         ├── .composer    position: absolute; right/bottom/width/height inline
         └── .rail        the fixed toggle (§21.4), pinned to the corner
```

`.composer-root` is the WHOLE dock. It used to be a `.composer-stage` that
excluded a strip along the bottom, because the toggle lived in a band reserved
out of the terminal. With that band gone (§21.2) the card gets the whole pane,
and the only thing it must still clear is the toggle's own box — expressed as
`PaneBox.keepOut` rather than as a wall, so a card parked to the LEFT of the
toggle may sit on the pane's floor.

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
| Move handle | the **header strip** — the card's title bar, `cursor: move`, `user-select: none`. Presses that land on its one button (maximize/restore) are excluded; double-clicking it maximizes, as a title bar does everywhere |
| Resize | **all four edges and all four corners**, 6px strips and 14px corner boxes overlaid on the card's own padding, so none of them covers the textarea. The top one keeps the old sash's look and its double-click. Corners are declared after edges so they win the hit test where both would answer |
| Floors | 360—190. 360 leaves ~40 mono columns beside the tools pill and Send; 190 is the height at which the toolbar, two draft lines, the tiles and the Send row all still fit |
| Cap | 80% of the pane's height, and never wider or taller than the pane |
| Containment | clamped **fully inside** the pane, always. The strongest form of "never draggable off-screen": there is no partially-lost state to recover from, so no rescue affordance is needed |
| Keep-out | the fixed toggle's measured corner box. A card spanning it is lifted to sit above it, and shortened if it would not otherwise fit — so the control that closes the card can never end up underneath it |
| Snapping | on mouse-**up** after a MOVE only, 12px, each axis independently, to that axis's two flush positions. Never during a drag (DESIGN.md §5.9 wants pointer-1:1) and never after a resize, which would silently change the size just chosen |
| Maximize | fills the dock — full width, capped height. Deliberately unlike the resting card: "maximize" is a request for all the room there is, a different question from how wide a prompt wants to be |
| Corners / elevation | `--r-xl` and `0 8px 32px rgba(0,0,0,.5)` — §5.5's `OverlayPanel` treatment with the Y offset pulled in from 16px, because a card that can sit flush against the bottom of its dock would throw that shadow off the pane and leave its *top* edge, the one with terminal text behind it, unseparated |

Every rule above is pure arithmetic in `src/shared/composerGeometry.ts` and is
unit-tested in `tests/unit/composerGeometry.test.ts`. The component's only job
is to measure the dock (one `ResizeObserver`) and feed deltas in.

Dragging a **maximized** card leaves the maximized state and keeps the box it
had, exactly like dragging a maximized OS window restores it under the cursor.

### 21.2 The terminal-never-resizes guarantee

**The composer reserves nothing.** `.tab-body` used to carry
`padding-bottom: calc(var(--composer-rail-h) + var(--composer-inset))` — about
two terminal rows, given up permanently whether the composer was open or shut,
so that the collapsed toggle could sit *below* the last row instead of on top of
it. The user asked for those rows back: *"prompt composer thing should be flying
so it shouldn't be taking space from the terminal it should be an overlay."*

**The guarantee survives the change.** It never depended on the padding being
44px, only on its being a **constant**: the terminal is sized by the pane, and
no composer state can change it. Zero is a constant. Opening, closing, moving
and resizing the card still cause no SSH window-change and no remote tmux
reflow — the guarantee simply settles at a larger row count. The dock is an
absolutely positioned overlay and takes no part in the tab body's layout in any
state, which is the mechanism, and it is unchanged.

What the change costs is stated plainly in §21.4: the toggle now floats over
the bottom-right of the terminal, where tmux paints the right end of its status
line.

`--composer-inset` is declared on `.session-workspace` in
`SessionWorkspaceView.vue` rather than in `App.vue`'s `:root`: it describes that
pane's relationship with the composer, and custom properties inherit, so
PromptComposer reads it without being handed it. `--composer-rail-h` sat beside
it to size the reserved strip and is **gone** with the strip; the toggle sizes
itself from `--control-h-sm`.

### 21.3 Inside the card

Ported from the phone: draft box `var(--r-lg)` radius, 1px border, `min-height`
46px (two lines — below that the caret line is clipped in half), internal scroll
past that; the tools pill 22px radius (`PromptComposerSheet.kt:1146-1150`); slash
dropdown `max-height` 196px (`:2915`), rendered **above** the card's top edge.
That last one is why the card is *not* `overflow: hidden`, which in turn is why
`.sash` closes the card's top corners itself.

`<style scoped>` per component, matching every existing view.
### 21.4 One toggle, one position — the control that never moves

Opening and closing used to be two different controls in two different places:
the collapsed rail *was* the opener, and the card's header carried a close
button. So the user reached for one spot to put the panel away and a different
spot to bring it back, and the control they had just clicked was no longer under
the cursor. The user's words: *"I want the button that minimizes it — on the
same place — so when I click on it it goes down, and then if I want to hide it
I just click on the same thing."*

**There is exactly one open/close control, and it is anchored to the PANE.**

```
 .composer-dock          the session body, inset on all sides
 ├── .composer-root      the card's world: the whole dock
 │   └── .composer       the card: dragged, resized, maximized, or absent
 └── .rail               the fixed toggle, pinned to the bottom-right corner
```

| | |
|---|---|
| Position | pinned `right: 0; bottom: 0` of the dock. Identical in every state — open, closed, card dragged elsewhere, card maximized |
| Both states | open — chevron **down**, the direction the panel will travel. Closed — chevron **up** |
| Size | a 28px (`--control-h`) round button around a **16px** mark — docs/POLISH.md §2.7's DEFAULT scale, not its dense one, which is right for a primary affordance |
| Surface | opaque `--surface-2`, a `--border-strong` edge and the card's elevation shadow. Not a taste call: DESIGN.md §4.2 requires `--border-strong` (4.12:1) wherever a boundary is the only thing identifying a control, and here it is the only thing separating the chip from the terminal behind it |
| Inset | a further `--sp-3` inside the dock's own corner, so it visibly floats ON the terminal rather than hugging the pane's edge — and clears almost the whole tmux status row instead of sitting in it |
| Never covered | `PaneBox.keepOut` (§21.1) is the toggle's measured box; `clampGeometry` lifts any card that would span it. A **corner hole in the card's placement**, not a band carved out of the pane |
| Click target | the whole button. It is pinned, so it is never dragged: a click is unambiguously a click |

It could not have lived on the card. The card moves — that is §21.1 — so
any control riding on it has no fixed position to offer.

**Why it is a bare icon.** It began as a rail spelling out a `PROMPT` label, the
waiting draft's first line, an attachment count and the `Ctrl+\`` hint. That was
right while the composer owned a reserved strip below the terminal. Once it
became a pure overlay (§21.2) everything it drew sat on top of terminal output,
which made the *quietest* state the most intrusive one. An icon is the least
that still offers the affordance. The user: *"let's make it smaller and an
icon."*

Nothing the rail answered was simply deleted:

| Was | Now |
|---|---|
| `PROMPT` label | the tooltip and the `aria-label` |
| `Ctrl+\`` hint | the tooltip, in both states |
| draft's first line, attachment count | a 6px accent **pip** on the button's corner, plus `— unsent draft` in the tooltip. `railToggle(open, unsent)` owns that copy |
| the `Compose prompt…` placeholder | **deleted.** It was never an answer to anything — a label for a button that already has a chevron and a tooltip |

The pip follows docs/POLISH.md §2.4: a CSS circle, not a glyph, so it does not
scale with font metrics, ringed in the panel surface so it reads against
whatever terminal output is behind it.

**Small but not shy — superseding this section's own first answer.** The button
began at 24px and `opacity: 0.55`, on the reasoning that an overlay drawing over
tmux's status line should defer to it until wanted. The user, running it: *"the
^ icon should be an overlay over the terminal not hiding in the corner it's
almost invisible."*

They were right, and the mistake was one of category. Deference is the correct
instinct for decoration; this is the ONLY way to summon the composer once it is
closed, so a control nobody can find is not subtle, it is broken. The fix was
**contrast and placement, not size** — the user liked the compact icon and
asked for it (*"let's make it smaller and an icon"*), so the old wide rail did
not come back. It is now an opaque chip with a strong edge and real elevation,
inset far enough to read as floating, at full opacity in every state.

Hover and focus step the fill up the elevation ladder (`--surface-2` —
`--surface-3`) and brighten the mark; a **waiting draft** brightens the mark
too, so the pip is not carrying the news alone.

**The card has a close button too — superseding this section's own earlier
decision.** For one revision it did not: the header carried maximize/restore
alone, on the reasoning that a second closer, on a surface the user can drag
anywhere, was the "the control moved" problem all over again. That was a fair
reading of the complaint as it stood, and it is recorded here rather than
deleted because the reversal is the interesting part.

What it got wrong is that OPENING and CLOSING are not symmetric acts. Closing is
something you do to a surface you are already looking at, at the point of
attention — the conventional — gesture, which needs no fixed address because
you are looking straight at it. Opening is a summons issued from somewhere else
entirely, and *that* is what needs one unmoving pixel. The user, having used the
result: *"the button on the top right of prompt composer should be x — I want
it to close the composer (i.e. minify)."*

So the header is `[ PROMPT ——— maximize/restore ] [ close ]`: the
conventional window order, dismissal last so it is not what the cursor lands on
by accident. Maximize keeps its button rather than retreating into the header's
double-click — that gesture still works, and so do `Ctrl+Shift+↑`/`↓`, but a
primary affordance should not live only behind an undiscoverable one.

Both closers run the same `hideComposer()`, so `lastOpenMode` carries
docked-vs-maximized across the round trip whichever is used, and the pinned
toggle's fixed-position invariant is untouched: it is an ADDITIONAL way to
close, not a replacement. The other ways out are unchanged and all end in the
same visible state: `Ctrl+\``, `Ctrl+Shift+K`, `Ctrl+Shift+↓`, and rung 4 of the
Escape ladder (§12.2).

**Closing always hands the keyboard back to the terminal.** Every path — the
pinned toggle, the card's close, Escape rung 4, the chords, close-on-send —
routes through one `hideComposer()` that focuses the pane. That is not a
nicety: the typing intercept of §26 lives on the terminal's own textarea, so a
close that left focus on a button would leave the next keystroke going nowhere
and the whole feature looking broken.

The chevron mapping and the unsent copy are a pure function (`railToggle` in
`src/shared/composerText.ts`), tested in `tests/unit/composerText.test.ts`; the
coordinate invariance is asserted end-to-end in `tests/e2e/composer.spec.ts`.

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

## 26. Two behaviours the user drives from Settings

Both are switches in `stores/settings.ts` (`typingOpensComposer`,
`closeComposerOnSend`), both default **on**, and both are read through the store
on every use rather than copied at mount — flipping either one takes effect on
the next keystroke.

They exist for one reason, stated by the user: on the phone the composer is the
primary way you talk to the agent, and they want the same reflex on the desktop
with typing as the trigger. Together they make the rhythm: type anywhere, the
card appears with what you typed; send, it gets out of the way; type again, it
is back.

### 26.1 `typingOpensComposer`

A printable keystroke at a CLOSED composer opens it and lands in the draft
instead of reaching the shell. **The character that triggered it is not lost** —
having to retype the first letter of every prompt would defeat the point.

Where it is decided:

| | |
|---|---|
| Predicate | `isTypingKey` in `src/shared/composerText.ts`, unit-tested. Pure, so the line it draws is checkable rather than buried in an event handler |
| Intercept | `TerminalView.vue`'s existing `attachCustomKeyEventHandler`, which already owns the clipboard chords. Returning `false` stops xterm turning the key into input bytes |
| Condition | `SessionWorkspaceView.vue` computes `settings.typingOpensComposer && composer.mode === 'hidden' && tab !== 'files'` and hands TerminalView the answer as `interceptTyping`. The terminal knows nothing about the composer or the settings; the composer knows nothing about the terminal's key handling |
| Delivery | TerminalView emits `typed`; the workspace calls the composer's `typeInto(char)`, which opens on `lastOpenMode` and splices the character in at the remembered caret (`insertAtCaret`) |

**Where the line is drawn, exactly.** `isTypingKey` returns false — so the key
goes straight to the shell — for:

- **anything with Ctrl, Meta or Alt.** One rule covers Ctrl-C, Ctrl-D, Ctrl-Z,
  Ctrl-R, tmux's prefix and every app chord. A terminal that swallows Ctrl-C is
  broken. Shift is deliberately not in that list: Shift-A is a capital letter.
- **any key whose `key` is not exactly one code point.** The DOM spells named
  keys out (`Enter`, `Tab`, `Escape`, `ArrowUp`, `F5`, `Backspace`, `Home`…), so
  one rule covers the whole control keyboard without enumerating it.
- **a bare space.** It is the near-universal "next page" in pagers and tmux copy
  mode, and nobody begins a prompt with it. Only the TRIGGER is affected: once
  the composer is open the draft has focus and space types normally.
- **a key mid-IME-composition.** The composing text belongs to whatever already
  has focus; stealing it half-written would drop it.

**The keypress latch.** xterm consults the handler for keydown *and* keypress,
and it is the keypress it turns into a byte. Swallowing only the keydown would
still let the character through — and by keypress time the condition has gone
false, because the composer we just opened is no longer closed. So the decision
is latched on the keydown and spent on the keypress.

**How to get a plain terminal**, which is the question this feature has to have
an answer to:

1. **Click in the terminal**, then type. A press inside a pane says you are
   working at the shell, and the intercept stands down until you point somewhere
   else or summon the composer (§12.2). This is the hatch, and it is the gesture
   a user performs before typing at a shell anyway.
2. **The setting**, for turning the behaviour off entirely.

This has been in three places. First there was no explicit hatch: Escape's third
rung blurred the draft and left the composer OPEN, and since the intercept only
fires while it is closed, that bought a plain terminal for free. It was neat and
it depended on Escape not doing what Escape does everywhere else, so the user
asked for the plain meaning of the key. The hatch then moved ONTO Escape — a
dismissal suppressed the intercept — and that is what the user hit and reported:
"I click esc, continue typing and now the input goes to the terminal". Escape
had stopped meaning "close" and started meaning "close, and speak for my next
keystroke".

So it moved off the keyboard entirely. The reason it works there is that a press
in the terminal is the ONLY gesture in this window that is unambiguously about
the shell: Escape is about the panel, and a click elsewhere — the tab strip, the
session panel — is about neither. **Note what this costs**: with the setting on
and nothing suppressing, every printable keystroke reaches the composer, so the
hatch is load-bearing rather than a convenience. Losing it entirely would leave
the Settings toggle as the only way to type at a shell.

### 26.2 `closeComposerOnSend`

After a delivered send the composer closes itself, and the next keystroke brings
it back (§26.1). This is the phone's rhythm, asked for explicitly.

- **Only a confirmed delivery closes it.** A failure — including a timeout,
  which §4.2 treats as a failure — leaves the card open: the composed payload
  is back in the draft and the "Not sent" banner is showing, and closing over
  the top of that would hide both, leaving an invisible unsent prompt and no
  explanation.
- A **partial attachment failure** (#570) happens at STAGE time, not send time.
  Its survivors are attached and its error shown; if the user then sends, the
  send either lands or it does not, and the earlier error has no say in whether
  the panel closes.
- The rule lives in the store's `send(key, deliver, { closeOnDelivery })` rather
  than in the component, so the failure case is testable without a settings
  fixture. The component passes the setting in and, on a delivered-and-closed
  send, hands focus to the terminal — which is what arms §26.1 for the next
  keystroke.
- It composes with `lastOpenMode`: a maximized composer that closes on send
  re-opens maximized.

## 27. The doodle / annotate surface

`DoodleCanvas.vue`, reached two ways: from the composer's attach row through a
source chooser (blank sheet, clipboard, a local file, a file on the host), and
from the pencil on an image tile that is **already staged** (§27.7). Whatever
the source, the image arrives as a URL an `<img>` can load and leaves as PNG
bytes that go straight into the `{kind:'bytes'}` staging path the clipboard
already uses — no new upload, remote-path, tile or send code (§17, §23.4).

### 27.1 The document, and what "attached" means

The sheet is a list of ITEMS — strokes, and text annotations — repainted onto
one canvas on every change. There is exactly one canvas and one painter, and
`commit()` encodes that same canvas, so **anything visible on the sheet is in
the attached PNG by construction**. There is no preview layer for the exporter
to reproduce, which is the failure this design exists to make impossible.

The one thing that is NOT an item is the text tool's caret: it is a real
`<textarea>` floating over the canvas, and `toBlob` cannot see it. So the commit
path flushes the open editor into the document *before* it encodes. Attaching
mid-sentence attaches the sentence. `tests/unit/DoodleCanvas.test.ts` asserts
this against a recording 2D context rather than trusting it.

### 27.2 Tools

| Tool | Gesture | Notes |
| --- | --- | --- |
| Draw | drag | freehand, smoothed through the sample midpoints |
| Line / Arrow | drag, tail to head | **Shift constrains to 45° steps** |
| Rectangle / Ellipse | drag two corners | Shift does nothing here — see below |
| Text | click to place, click existing text to edit | |

- **The arrowhead scales with the mark weight**, at 4x the stroke, capped at 60%
  of the arrow's length so a short arrow is not all head. The shaft stops at the
  barb baseline, not at the tip, so a fat round cap cannot poke out of the point.
- **A click with no drag commits nothing.** A zero-length arrow is invisible but
  would still consume an Undo, and an Undo that appears to do nothing is how
  users conclude undo is broken. Only the pen means anything by a single point
  (it is a dot).
- **Shift is deliberately not wired to rectangle/ellipse.** On those the same key
  conventionally means "square"/"circle", which is a different constraint under
  the same keycap; implementing one and leaving the other inert is worse than
  doing neither.
- **One colour row and one weight row serve every tool**, text included. Weight
  drives stroke thickness and, through it, text size — they are the same idea
  (how heavy a mark), which is why it is one control.

### 27.3 Text: the keys, and the Escape collision

| Key | In the annotation editor |
| --- | --- |
| `Enter` | **newline** — annotations wrap and are routinely two lines |
| `Ctrl/Cmd+Enter` | commit |
| `Escape` | commit, and **stop propagating** |
| `Ctrl/Cmd+Z` | the textarea's own undo, not the sheet's |

Enter is the opposite of the draft's Enter-sends (§20), and that is fine: the
draft is a message being finished, this is a caption being laid out.

**The Escape rung is the load-bearing part.** This canvas sits inside an
`OverlayPanel` (Escape closes the overlay) inside `.composer-root` (Escape runs
the §12.2 ladder and hides the whole composer), and both listen for a bubbling
Escape. Without `stopPropagation` on the editor's own handler, one Escape while
typing a caption would throw away the caption, the drawing and the composer, in
that order. Handling it on the focused element makes the open editor the
innermost rung of the same ladder — *Escape closes what you opened last* —
without either outer handler needing to know this tool exists. Neither §12.2 nor
`OverlayPanel` was changed.

It **commits** rather than cancels, because Escape in this app never destroys
work (§12.2). Ctrl+Z is how you take an annotation back.

Committed text stays editable: click it again with the text tool and the caret
returns, at the end of the text. Emptying an annotation deletes it — there is no
separate delete control, and adding one would mean a selection model this
surface does not otherwise have. Clicking a swatch while the caret is open
retargets the annotation being typed; re-opening an old one keeps its own colour
rather than adopting the toolbar's.

### 27.4 Undo

`history` is a stack of previous versions of the item ARRAY — references, tens of
them, which is a different proposition from the per-stroke pixel snapshots the
original design rejected. It is what lets one Ctrl+Z (or the toolbar button)
cover every mutation the surface has:

- a stroke, a shape or an arrow;
- placing a text annotation;
- **retyping an existing one** — a mutation in the middle of the document, which
  a pop-the-last-item stack cannot express;
- **Clear**, which is otherwise one misclick from losing the whole markup.

Nothing that changes the document bypasses it: every mutation goes through one
function, so "does undo cover this tool?" stays answerable by reading one place.

### 27.5 Geometry lives outside the component

`src/shared/doodleGeometry.ts` holds the arithmetic — arrowhead barbs and shaft
stop, 45° snapping, greedy line breaking with hard breaks and character-level
breaking for an unbreakable URL, block layout and hit testing. It is pure: it
takes numbers and a `measure` callback and knows nothing of the DOM, tokens or a
canvas context. That is what makes the parts most likely to be subtly wrong
testable in `tests/unit/doodleGeometry.test.ts` without a canvas at all.

### 27.6 Typography, and the one token deviation

Family (`--font-ui`), weight (`--fw-semibold`) and leading (`--lh-300`) are
resolved from computed style at paint time, exactly as the pens resolve their
colour tokens — no literal enters the `.vue` file.

**Size is not from `--fs-*`, and this is deliberate.** That ladder is a chrome
density system (28px rows, 40px bars) that tops out at 20px — `fonts.ts` says so
in as many words — while this canvas is a bitmap up to 2048px wide whose logical
pixels are not CSS pixels. `--fs-300` text on a phone screenshot would be
13/2048 of the image width and about four screen pixels tall on the sheet. Size
follows the selected mark weight instead — 8x, with a 36px floor so the lightest
weight stays legible once the sheet is shrunk to about a third — so a caption
and the arrow pointing at it read as one hand.

The ratio was 4x, borrowed from the arrowhead, and that borrowing was the bug a
user reported as "for annotations font size is too small": an arrowhead is a
SHAPE and survives being shrunk, type does not, and this sheet is always shrunk
(an `md` overlay is ~700 CSS px over a backdrop worked at up to 2048). At 4x the
three weights reached the eye at 4 / 8 / 16 CSS px — two of them, the default
among them, below the 11px `--fs-100` this app never goes under. The ratio and
the floor are named constants in the pure module, and the test asserts what
REACHES THE EYE (`textFontSize(w) * (700/2048) >= 11`) rather than asserting the
constants against themselves.

### 27.7 Annotating an image that is already attached

The request was "when I attached an image I want to be able to annotate on it",
clarified as *on an already-attached image*. That is a different act from the
four source-chooser routes, and the difference is entirely on the way out: the
others produce a NEW tile, this one **replaces** an existing one.

**The affordance.** A pencil appears on image tiles only, decided by
`classifyByName(remotePath)` — the same classifier the Files tab uses. Not by
"does the tile have a thumbnail": a tile only carries a preview when it came
from a paste or a drop, so that rule would offer annotation on a dropped
screenshot and refuse it on the identical file attached through the paperclip
(which stages by path and never mints one), or on either after a restart
(previews are deliberately not persisted). The remote name always survives. The
pencil sits *before* the `×`, so the destructive control keeps the corner
muscle memory expects.

**Where the pixels come from.** Staging is EAGER — the bytes are uploaded when
the file is attached, not when the prompt is sent (§17) — so the host always
has an authoritative copy, and `sftp:readBinary` under
`absoluteAttachmentPath()` is a correct fallback for any tile, including one
restored from a previous run. But it is a round trip, and for the case people
actually hit (a screenshot pasted five seconds ago) the same bytes are already
in the renderer behind the tile's object URL. So the local preview is tried
first: instant, and it works with the connection down. Only tiles with no
preview pay for the read, behind a `loading` step that also gives a failed read
somewhere to be reported that is not the source chooser.

**Replace, not keep alongside.** "Annotate it" is a sentence about one image.
Keeping both would double every attachment anyone marks up and hand the agent a
clean copy and a scribbled copy of the same screenshot with nothing to say which
to believe. The swap is **in place**, and that is the load-bearing detail: paths
are folded into the prompt in tile order at send time (§5.1), so a draft that
says "compare the first screenshot with the second" is a statement about the
list's ordering. Remove-then-reattach — the only thing the store's existing
actions can express between them — would silently move the image to the end.
`replaceStagedAttachment()` in `src/shared/composerAttachments.ts` is the
ordering rule, pure and unit-tested; it reports `null` rather than appending
when the target is gone, because re-adding an attachment the user has since
removed is worse than losing the drawing.

The original on the host is left where it is. Nothing references it, and
`AttachmentRetentionPolicy` already owns the lifetime of everything under
`~/.pocketshell/attachments`. Deleting eagerly would mean a new privileged IPC
channel that removes remote files, to reclaim one screenshot from a directory
that prunes itself.

**Re-annotating works, and starts from the flattened result.** That is the
honest behaviour: the second pass draws on the PNG the first pass produced, not
on its vector items, which are not persisted anywhere. The visible cost is the
filename, which by then carries this surface's `annotated-…-<stamp>` and the
stager's own `<stamp>-<ordinal>-` prefix; `doodleAttachmentName()` strips both
before it adds one of each, so the name is stable under any number of passes
instead of growing a decoration per pass.

### 27.8 Cancelling no longer destroys the drawing

Every route out of the sheet except Attach used to discard silently: the Cancel
button, the overlay's `✕`, a click on the backdrop, and Escape. Backdrop clicks
against a modal are the easiest mouse error there is, and the undo stack that
would otherwise be the recovery (§27.4) lives *inside* the component the close
unmounts. On a blank sheet that is an annoyance; on a screenshot the user
attached and then spent a minute marking up it is the loss of all of it.

So `DoodleCanvas` owns the decision now and the parent routes every dismissal
through `requestClose()`, exposed for exactly that. An empty sheet still closes
on one Escape — a doodle opened by mistake must not argue. A sheet with work on
it raises a confirmation in its own footer, replacing the action row rather than
stacking above it, so the buttons that answer the question are the only buttons
there are. An open caption is flushed into the document first, so it counts as
work.

Escape keeps its meaning from §12.2 — *it never destroys work*. It arms the
confirmation, and a second Escape **dismisses the confirmation** rather than
confirming it: the safe direction on the key people press without reading.
Discarding takes a deliberate click on a button labelled Discard.

This is fixed for every doodle source, not just the new one. `OverlayPanel` was
not changed; it still emits `close` for Escape and for a backdrop click, and the
composer decides what that means.
