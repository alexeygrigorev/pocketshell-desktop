# PocketShell Android — Feature-Parity Reference Target

Reference implementation: `/home/alexey/git/pocketshell` (single-Activity Compose app,
hand-rolled stack navigator, sshj for SSH, vendored Termux for the terminal, tmux `-CC`
control mode). This catalog is the parity target for the desktop sibling.

**Overarching architecture:** host list is the landing screen; one SSH connection per host
shared across all its tmux sessions; foreground-first (no background work) with
port-forwarding as the sole foreground-service exception.

---

## 1. Host & Connection Management

- **Host list (landing screen)** — scrollable list of saved host cards: name, `user@host:port`, connection-status badge (Unknown / NoActiveSessions / N sessions / Attached / NeedsSetup / ConnectionError), setup-state badge, usage warning chip, kebab overflow; FAB `+` to add. Client-side Room (`HostEntity`/`HostDao`); rendered in `HostListScreen.kt`.
- **Add / Edit host** — form: Name, Hostname/IP, Port (default 22), Username, SSH-key selector, optional Usage-command override; validation, dirty-state Discard dialog. `AddEditHostScreen.kt` / `AddEditHostViewModel.kt`.
- **Delete host** — Room FK cascade.
- **Import host (file)** — Settings → Hosts → Import host → Choose file; accepts `pocketshell.ssh-import.v1` JSON. Client codec `SshImportPayloadCodec.kt`; format in `docs/ssh-qr-import.md`.
- **QR-code import (camera scan)** — live camera scanner (zxing) consuming `pocketshell.qr.v1` chunked envelopes; multi-part reassembly keyed by transmission id, per-chunk CRC-32, 60 s stale expiry, progress chip. File fallback. `QrScannerScreen.kt`, `QrChunkCodec.kt`.
- **QR-code generation (dev-box side)** — **`pocketshell qr-share [alias|--host ...]`** produces the import payload + QR(s) (inline TTY or numbered PNG sequence). Optional `qr` extra. `tools/pocketshell/src/pocketshell/qr_share.py`.
- **Deep-link import** — `pocketshell://import?payload=...` (single-part only). `MainActivity.kt` intent filter.
- **Host share (export QR)** — in-app QR of a host config using `KeyReference` auth (never embeds the private key); plus "Share text". `HostQrCode.kt`.
- **SSH key import** — file picker (SAF) loads PEM/OpenSSH/PKCS8/PuTTY private key; stored under `filesDir/ssh-keys/`; fingerprint-dedup. `SshKeyStorage.kt`, `SshKeysViewModel.kt`.
- **SSH key generation** — on-device RSA-3072 (PKCS#8 PEM), `generated-<timestamp>`, no passphrase.
- **Passphrase detection** — local byte inspection (`Proc-Type: 4,ENCRYPTED`, `DEK-Info`, `ENCRYPTED PRIVATE KEY`, OpenSSH KDF). `SshKeyStorage.hasPrivateKeyPassphrase()`.
- **Biometric unlock** — Android `BiometricPrompt` (BIOMETRIC_STRONG | DEVICE_CREDENTIAL) gates the keys pane + passphrase entry. `SshKeysScreen.kt`.
- **Connection lifecycle state machine** — pure-JVM reducer: Idle → Connecting → Attaching → Live → Backgrounded → Reattaching/Reconnecting → Unreachable/Gone. `ConnectionController.kt`, `RevealStateMachine.kt` (`shared/core-connection`).
- **Warm lease / 60 s grace** — single 60 s grace window anchored on the lease when the app backgrounds; tmux control client detaches on background, reattaches on foreground; no timers while backgrounded.
- **SSH lease pool (1 connection per host)** — reference-counted, keyed by `(host, port, user, credentialId)`; concurrent acquires coalesce onto one handshake; 60 s warm idle TTL; max 2 idle leases; 35 s bounded connect timeout; 15 s keep-alive, 4 misses tears down. `SshLeaseManager.kt`, `SshConnection.kt` (`shared/core-ssh`).
- **Auto-reconnect** — bounded retry (immediate, 1 s, 2 s, 5 s) only for visible active screens after a transport drop; status `Reconnecting`, sending disabled; `Failed` + manual Reconnect after exhaustion. `docs/reconnect-policy.md`.
- **Liveness probe** — foreground-only periodic ping of the control channel (~10 s interval, 2-failure threshold).
- **Per-host port forwarding** — per-host auto-forward panel: scans remote `ss -tlnp`/`netstat` for listening ports, opens local forwards (127.0.0.1:remotePort), manual toggle, "show noisy ports", per-host persisted remappings, prefill-remote-port, open-browser-when-forwarded. Foreground service with persistent notification while any tunnel is active (the sole background exception). Exponential-backoff supervisor (5 s→60 s). `AutoForwarder.kt`, `AutoForwarderSupervisor.kt`, `ForwardingController.kt`, `ForwardingService.kt` (`shared/core-portfwd` + `app/.../portfwd`).

---

## 2. Sessions & tmux — CONNECTION MODEL CONFIRMED

**Confirmed: 1 SSH connection per host, multiplexing multiple tmux sessions over it.** `SshLeaseManager` is keyed by `SshLeaseKey(host, port, user, credentialId)`. Switching tmux sessions on the same host acquires a lease on the same key and reuses the warm SSH transport (proven by `TmuxSessionSwitchSameHostReusesSshE2eTest`, `BackThenOpenSecondSessionReusesWarmLeaseE2eTest`). Each tmux session attaches via its own `tmux -CC` control channel inside an SSH shell on that shared transport.

- **Session list (per host, "FolderList")** — host-detail screen lists the host's tmux sessions **grouped by working directory (folder)**; each folder shows a session count; tapping a session opens it; "show all sessions on this host" flat-list link; pull-to-refresh. Session metadata via **`pocketshell sessions list --by activity`** (fallback raw `tmux list-sessions -F`).
- **Project history chips** — recently-used project paths as chips in the folder list. **Server-side: `pocketshell logs tail --kind agent --json -n 200`** (cwd from agent log entries).
- **Attach to existing session** — `tmux -CC new-session -A -s <name>` attach-or-create; `tmux has-session` preflight throws `TmuxSessionNotFoundException` for killed sessions. `TmuxClientFactory.kt`.
- **Create new session (Shell or Agent)** — bottom sheet: Shell vs Agent (Claude/Codex/OpenCode), optional profile, optional skip-permissions; for agents the launch command is sent into a detached pane via `tmux send-keys`. **Server-side: `pocketshell agent <kind> --dir '<dir>' [--no-skip-permissions] [--profile '<name>']`** (merges .env/.envrc, suppresses first-run modals, `execvpe`s the agent); pre-flight **`pocketshell agent --help`** (helper ≥ 0.3.34); kind recorded as `@ps_agent_kind` tmux user option. `SessionTypePickerSheet.kt`, `AgentLaunchVersionCheck.kt`.
- **Multiple sessions per host** — yes; the folder list shows all of them; many can be concurrently attached over the single SSH lease.
- **Pane navigation** — ONE pane at a time in its own `TerminalSurface`; swipe left/right (Compose `HorizontalPager`) between panes in the current window. `TmuxSessionScreen.kt`, `TmuxPaneState.kt`.
- **Window handling (D30/#782)** — PocketShell does NOT manage tmux windows; externally-created windows appear as separate `[wN]` switcher entries, each attaching to that window's pane via the warm lease.
- **Detach** — back arrow on the breadcrumb; session keeps running server-side; control client detaches cleanly (`detach-client`) before teardown.
- **Switch session** — tap session name in breadcrumb → dropdown of sessions on this host.
- **Kill/rename session** — `⋮` menu on the breadcrumb.
- **Agent kind detection (foreign sessions)** — one-shot host-side call classifies the pane's PID to a cgroup scope. **Server-side: `pocketshell agents kind`** (stdin JSON `{"panes":[...]}` → `{"results":[{"pane_id","agent_kind","scope"}]}`). `AgentKindRemoteSource.kt`, `FolderListGateway.guessForeignAgentKinds()`.
- **Profiles (agent picker)** — discovered Claude/Codex profiles offered in the new-session picker, default pre-selected. **Server-side: `pocketshell profiles list [--engine <e>] --json`**; `ProfilesGateway.kt`.

---

## 3. Terminal Surface

- **Per-pane VT rendering** — vendored Termux `terminal-emulator` + `terminal-view` inside a Compose `AndroidView`; xterm-256color; one pane at a time. SSH stream is a dumb byte pipe; all emulation is client-side. `TerminalSurface.kt`, `SshTerminalBridge.kt` (`shared/core-terminal`).
- **tmux `-CC` control mode** — structured protocol client (NOT screen-scraping). Handles `%output`, `%session-changed`, `%window-add/-close`, `%unlinked-window-close`, `%window-renamed`, `%layout-change`, `%pane-mode-changed`, `%begin/%end/%error`, `%sessions-changed`, `%client-detached`, `%exit`. Single-command-at-a-time serialization via Mutex; `%begin`/`%end` correlation by command number; idle-deadline command timeout that re-arms on reader activity. `ControlModeParser.kt`, `ControlEvent.kt`, `ControlEventStream.kt`, `TmuxClient.kt` (`shared/core-tmux`).
- **Layout-change coalescing** — collapses structural-event storms into at most one `list-panes` reconcile per 16 ms frame (fixes the Codex `/new` ANR). `LayoutChangeCoalescer.kt`.
- **Key bar** — 8-slot strip above the keyboard: Esc, Tab, Ctrl, Alt, ↑ ↓ ← →. Modifier FSM: single tap = one-shot; double-tap (<350 ms) = locked; active modifiers light accent. `KeyBar.kt` (`shared/ui-kit`).
- **Scrolling** — Termux 2000-row scrollback; `pinTerminalToBottom` on keyboard show.
- **Copy/paste** — Termux selection cursors → Android `ClipboardManager`; paste via `PocketShellTerminalViewClient`; bracketed-paste helpers for multiline. `BracketedPaste.kt`.
- **Resize** — `TerminalView.updateSize` on layout; reports viewport to tmux via `refresh-client -C <cols> <rows>`.
- **Smart-selection overlays** — URL / file-path / engine-command tap detection; tapping an engine command (e.g. `/compact`) opens the composer pre-filled (#770). `AgentCommandScanner.kt`.
- **Terminal keyboard modes** — Raw command (default; `VISIBLE_PASSWORD | NO_SUGGESTIONS`) or Smart text (`AUTO_CORRECT`, staged locally until Enter).

---

## 4. Agent Awareness

- **Agents detected** — Claude Code, Codex (OpenAI), OpenCode. `shared/core-agents/`.
- **HOW detection works (two-phase)** — (1) **Kind**: for launched sessions read `@ps_agent_kind`; for foreign sessions **`pocketshell agents kind`** resolves pane PID → cgroup classification. (2) **Source-path resolution**: from the active pane's cwd, enumerate candidate logs (`find ~/.claude/projects/<encoded-cwd>`, `find ~/.codex/sessions/`, `sqlite3 ~/.local/share/opencode/opencode.db`), filter by 2 h recency, rank by recency + `/proc/<pid>/fd` ownership. Pane-scoped `ps` scan only for Codex owned-rollout binding. Output-parsing kind detection was hard-deleted (epic #821). `AgentDetector.kt`, `AgentConversationRepository.detectionCommand()`.
- **Log sources** — Claude Code: JSONL `~/.claude/projects/<encoded-cwd>/<session>.jsonl` (append-only, tailed); Codex: JSONL `~/.codex/sessions/**/*.jsonl`; OpenCode: SQLite `~/.local/share/opencode/opencode.db` (polled every 2 s). Parsers `ClaudeCodeParser.kt`, `CodexParser.kt`, `OpenCodeReader.kt`.
- **Codex initial history** — **Server-side: `pocketshell agent-log --engine codex --session <id> --json --tail <n>`** (Codex only; Claude/OpenCode use direct file/SQLite reads).
- **Conversation tab** — appears only when an agent is detected; **opens by DEFAULT on the Conversation view for agent sessions (#818)**, configurable to Terminal; **per-session remembered choice wins; never yanks a user mid-session from Terminal to Conversation**. `TmuxSessionScreen.kt` (`SessionTab` enum).
- **Turns rendering** — chat-style USER/ASSISTANT blocks (role label, timestamp, streaming badge, send-state Confirmed/Pending/Failed, optimistic local echo #494); markdown; no ANSI noise. `ConversationMessageTurn.kt`, `MarkdownText.kt`.
- **Tool calls** — collapsible cards (default collapsed), tap to expand command + output + diff; auto-expand on search match; tool-call/result pairing.
- **Live tail** — auto-tails JSONL/SQLite as the agent writes; 60 ms coalesce; message-preserving bound (never drops Message turns under tool flood); first-paint budget 30 messages.
- **Reply composer (sends back into the pane)** — bottom composer sends text as `tmux send-keys -t <pane>` + Enter (Codex-specific submit delay to close the agent-TUI paste-ingestion race).
- **Search in conversation** — full-text substring search across message text, tool name, tool input, tool output; matching tool cards auto-expand.
- **Long-press message** — copy / quote-reply into the prompt composer.
- **Hint chip** — one-time "Claude Code session detected — Tap to see full conversation" inline in the terminal; dismissible per session.
- **Per-agent slash-command catalog** — app-shipped, per-AgentKind catalogs (ClaudeCode: /clear /compact /goal /rewind /resume /context /model /cost /review /init; Codex: /new /compact /goal /diff /clear /resume /review /status /model /init; OpenCode: /new /compact /sessions /undo /redo /share /export /models /init). Leading-`/` autocomplete in the composer; argument-aware; destructive flag. Tapping a rendered engine command opens the composer pre-filled (#770). `AgentCommandCatalog.kt`, `SlashCommandAutocomplete.kt`.

---

## 5. Input & Composition

- **Prompt Composer (primary voice surface)** — modal bottom sheet over the terminal (terminal dims): editable transcript area, big mic button, Insert vs Send vs Snippets, draft preserved per session (SavedStateHandle), connection-lost indicator, keep-screen-on during recording. `PromptComposerSheet.kt`, `PromptComposerViewModel.kt`.
- **Mic swipe-up-to-lock** — Telegram-style swipe-up locks recording. `MicSwipeUpLockGestureTracker.kt`.
- **Voice: OpenAI Whisper** — multipart POST `<baseUrl>/audio/transcriptions`, model `whisper-1`, optional language; key in `CharArray`; per-call cost tracked. `WhisperClient.kt` (`shared/core-voice`).
- **Voice: Android/Google Speech** — `SpeechRecognizer`, `LANGUAGE_MODEL_FREE_FORM` + partial results; on-device. `AndroidSpeechRecognitionProvider.kt`.
- **Provider selection** — Settings → Voice: OpenAI Whisper (default, needs key) vs Android/Google Speech.
- **Whisper API key storage** — `EncryptedSharedPreferences` + MasterKey (AES256_GCM), file `pocketshell-voice-secrets`. `AndroidKeystoreApiKeyStorage.kt`.
- **Silence threshold** — 2–60 s (default 30 s); energy-based auto-stop with dual amplitude thresholds; hallucination blocklist (6 languages). `SpeechAudioGuard.kt`.
- **PCM capture** — 16-bit mono 16 kHz from `VOICE_RECOGNITION`; WAV wrapping; peak-amplitude waveform. `AudioRecorder.kt`, `PcmCapturePump.kt`.
- **Pending transcription retry queue** — failed/offline transcriptions persisted to Room + disk (`filesDir/voice-pending/<uuid>.wav`); auto-retry on foreground resume when connectivity returns; foreground-only (D21). `PendingTranscriptionStore.kt`.
- **AI cost tracking** — per-call Whisper cost into Room `ai_api_call_log`; surfaced on the Costs screen. `PriceCatalogue.kt`.
- **Inline dictation (key-bar mic)** — mic slot at the trailing edge; tap streams words into the terminal at cursor (no review step); prompt/command mode toggle; input-enabled gating (#249). `InlineDictation.kt`.
- **Per-host snippets** — Room `SnippetEntity` (hostId FK CASCADE, label, body, kind=command|prompt); derived label from body first line (#190); `{{name}}` placeholder expansion; built-in "Git add, commit, push" template; full CRUD screen (Prompts/Commands/Macros tabs). `SnippetEntity.kt`, `SnippetsScreen.kt`, `SnippetTemplate.kt`.
- **Command templates (macros)** — per-host multi-command sequences (`CommandTemplateEntity`), one shell submission per line, `{{placeholder}}` expansion; interleaved into the snippet picker as pseudo-snippets. `CommandTemplateEntity.kt`.
- **Snippet picker** — bottom sheet with search, "Manage" → full screen, Send vs Send+Enter chips, template-expansion dialog. `SnippetPickerSheet.kt`.
- **Attachments (in-composer)** — multi-file attach via platform picker; SCP to `~/.pocketshell/attachments/<scope>/` with timestamped sanitized names; partial-failure handling; on send, paths composed into the sent text; 7-day TTL pruner. `PromptAttachmentStager.kt`, `AttachmentRetentionPolicy.kt`.
- **In-app action assistant (voice command agent loop)** — provider-agnostic LLM agent loop (#266) that takes a transcript and drives a multi-turn tool-calling conversation. Inspect/nav tools auto-run (D25); mutating tools (`run_command`, `create_file`, `start_session`, `send_prompt_to_session`, `clone_repo`) go through a `CommandSafety` gate + confirm-or-correct UX. Tool catalog: get_context, list_hosts, list_folders, resolve_folder, list_sessions, list_directory, read_file, list_repos, open_folder, open_session, open_screen, start_session, send_prompt_to_session, create_project, run_command, create_file, clone_repo. Provider/base-url/model/key configurable in Settings → Assistant. `AssistantAgentLoop.kt`, `AssistantActions.kt`, `AppAssistantActions.kt`, `SessionAssistantController.kt`; trace events shipped via **`pocketshell logs ingest -`** (silent on exit 127).
- **Share target (Android share sheet)** — `ShareActivity` receives `ACTION_SEND`/`ACTION_SEND_MULTIPLE`; host picker → per-host target chooser (host inbox `~/inbox/pocketshell/`, active-session project `.inbox/`, known project roots); text≤8KB → "paste into session" via tmux `send-keys` (bracketed-paste for multiline); files → SCP. Share-into-active-session uploads to attachments scope then launches MainActivity into that session with chips pre-loaded (#560); passphrase dialog for encrypted keys (#654). `ShareActivity.kt`, `ShareViewModel.kt`, `ShareUploader.kt`.

---

## 6. Server-Side Helper Features (`pocketshell` CLI — `tools/pocketshell/`)

The app probes one binary (`command -v pocketshell`), checks `pocketshell --version`, and uses whichever installer (`uv`/`pipx`) the host has. Full subcommand inventory + app-consumption status:

| Subcommand | What it does | Consumed by app? |
|---|---|---|
| **`pocketshell usage [--json\|--cached\|--capture] [provider]`** | Provider quota/limits (codex/claude/copilot/zai; gemini unsupported). `--json` NDJSON live; `--cached` reads last capture; `--capture` writes `usage-latest.json` + `usage-history.jsonl` (≤2000 lines). | YES (live + cached + version detect) |
| **`pocketshell sessions list [--by activity]`** | tmux session summaries (name → cwd grouping). | YES (fallback raw `tmux list-sessions`) |
| **`pocketshell sessions resumable` / `resume` / `create`** | Session resume/create metadata. | (available; create uses `tmux new-session` directly) |
| **`pocketshell jobs list/show/trigger/add/edit/remove`** + **`jobs daemon start/status/stop`** | Recurring tmux-send jobs (cron-like); daemon keeps them alive across phone offline. | YES (list/add/edit/remove) |
| **`pocketshell agent <kind> --dir <dir> [--profile] [--no-skip-permissions]`** | Launch claude/codex/opencode in a dir, first-run prompts suppressed, .env merged. | YES (+ `agent --help` pre-flight) |
| **`pocketshell agents kind`** | Batch cgroup-v2 agent-kind classification for pane list (stdin JSON). | YES (foreign-session detection) |
| **`pocketshell profiles list [--engine] --json`** | Discover Claude/Codex profiles from `~/.claude`, `~/.zlaude`, `~/.codex`, optional `profiles.yaml`. | YES |
| **`pocketshell tree get/upsert/reconcile`** | Durable per-host project-tree registry (epic #821). | YES |
| **`pocketshell agent-log --engine codex --session <id> --json --tail <n>`** | Agent conversation log retrieval. | YES (Codex history only) |
| **`pocketshell repos list [--local\|--remote] [--json]` / `open` / `clone`** | Enumerate git repos (local `~/git` scan or GitHub via `gh api user/repos`); clone/open. | YES (list remote + local; clone on tap) |
| **`pocketshell github status [--json]`** | `gh` install/auth state. Always exits 0. | YES (gates Issues tab) |
| **`pocketshell env list/get/set/unset/copy/export --dir <dir>`** | `.env`/`.envrc` management; `set` reads value from stdin tmpfile (D24 secret safety). | YES (list/get/set/copy) |
| **`pocketshell hooks install/status/events/uninstall [--engine claude\|codex\|opencode\|all]`** | Agent stop/idle-detection hooks; non-destructive merge into `~/.claude/settings.json`, `~/.codex/config.toml`, `~/.config/opencode/plugin/`. | NOT consumed (app reads agent state via JSONL/SQLite directly) |
| **`pocketshell logs ingest/tail/path/import-hooks`** | Server-side trace sink. | YES (`logs ingest -` assistant diagnostics; `logs tail --kind agent` project-history chips) |
| **`pocketshell prune-attachments`** | Server-side attachment retention backstop. | NOT directly (client-side `RemoteAttachmentPruner`) |
| **`pocketshell push register-token <token>` / `token-path`** | Persist FCM device token for usage-reset push delivery. | YES (foreground carrier during usage refresh) |
| **`pocketshell qr-share [alias\|--host ...]`** | Build `pocketshell.ssh-import.v1` payload + QR(s). | NOT invoked by app (app *imports* payloads) |
| **`pocketshell daemon start/stop/status/_serve`** | IPC daemon (Unix-socket JSON-RPC); perf optimization, fall-through when absent. | NOT directly (app checks `systemctl --user is-active pocketshell-jobs.service`) |

Surfaces powered by the helper:
- **Usage screen** — per-provider cards (status pill ok/limited/blocked/error/unsupported, short + long-term windows with data-driven labels `5h`/`7d`/`weekly`/`monthly`, progress bars, reset countdown, last error); pull-to-refresh; stale-while-revalidate. Dashboard strip on host list; warning chip on session rows. **`pocketshell usage --json` / `--cached`**.
- **Repo browser** — GitHub repos joined with locally-cloned repos; not-yet-cloned show "clone" badge; tap clones + opens a session. **`pocketshell repos list --remote/--local --json`, `repos clone`**.
- **File viewer** — remote preview (images zoom/pan, UTF-8 text, Markdown, PDF, audio); word-wrap; review mode (per-line comments → `~/inbox/pocketshell/reviews/`); image annotation (pen/arrow → `~/inbox/pocketshell/annotations/`); "Attach to current session" seeds the composer. Raw SFTP + `git blame`.
- **File explorer** — browsable remote filesystem (folders-first, `ls` over SSH), upload-to-remote, create-folder, sort. Raw SFTP.
- **Env screen** — per-folder key management (masked values, reveal on tap, create/update/copy). **`pocketshell env list/get/set/copy`**.
- **Recurring jobs screen** — per-session add/edit/remove/enable-disable; daemon-missing error with systemctl hint. **`pocketshell jobs list/add/edit/remove`**.
- **Git history screen** — commit timeline, branches with upstream tracking, worktrees, ahead/behind, dirty/clean, origin URL, GitHub issues tab (gated on `pocketshell github status`), create-issue. Raw `git` over SSH + raw `gh`; only `github status` uses the helper.

---

## 7. Settings

File: `app/src/main/java/com/pocketshell/app/settings/SettingsScreen.kt`. Eight sections, most-useful-first (#486):

- **Terminal** — default font size (10–22 sp, default 14); conversation font size (11–22 sp, default 13); Smart text keyboard toggle; Use tmux when available (default ON); Background grace (30 s / 1 min / 5 min / 10 min); Agent submit delay (0–1000 ms, default 150); Open agent sessions in (Conversation default / Terminal); Open on launch (Host list / a saved host).
- **Voice & Dictation** — Transcription provider (Whisper / Android Speech); Whisper API key (KeyStore); Language (Auto/EN/ES/FR/DE/JA/RU); Auto-stop silence threshold (2–60 s, default 30); AI Costs nav row.
- **Assistant** — Provider (OpenAI/Anthropic/ZAI); Base URL; Model; API key (KeyStore). Powers the in-app action assistant.
- **Usage** — Usage & quota nav row; per-provider worst-case state list; "Warn me when usage exceeds" slider (50–95%, default 80).
- **Workspace** — per-host watched-folder roots.
- **Hosts** — Import host (Scan QR / Choose file).
- **Diagnostics** — Flight recorder switch (default OFF, REC badge); Start fresh capture; Share JSONL; Clear; Crash reports nav row.
- **About** — Version display; Update check (Idle/Checking/UpToDate/UpdateAvailable/Failed).

Plus AI Costs screen (lifetime/month/week/day totals, per-feature, per-day log, CSV export, Clear) and Crash Reports screen (share-all/delete-all/per-report).

---

## 8. Onboarding / UX Flows

- **No wizard** — first launch goes straight to `HostList`; empty-state card "No hosts yet / Use + to add an SSH host" with the FAB as the only CTA. Cold-launch silently re-probes hosts with `Unknown` setup state.
- **Host bootstrap (first connect)** — tapping a host opens a short-lived SSH session and probes: PATH detection (prepends `~/.local/bin`, `~/bin`, `~/.cargo/bin`), `command -v tmux`, `command -v pocketshell` + `pocketshell --version`, `uv`/`pipx` detection, `systemctl --user is-active pocketshell-jobs.service`. Bootstrap bottom sheet: Prompt (per-tool Missing/Outdated rows + Install/Update + Install all + Skip) → Installing → Success (Open Usage / Continue) → Failed (stderr block). 24 h per-host cache; OS-aware tmux install (apt/apk/dnf/pacman/zypper/brew). Install: `uv tool install [--upgrade] --exclude-newer-package pocketshell=2099-12-31 pocketshell`.
- **App update check** — throttled (6 h) GitHub Releases check on foreground resume / host open / screen show; banner on host list + Settings About + local notification (de-duped per tag); APK URL `ACTION_VIEW`.
- **Diagnostics flight recorder** — bounded JSONL (512 KB / 2000 events), privacy-redacted (no commands/prompts/secrets; hostnames/usernames/paths fingerprinted); Settings → Share JSONL / Start fresh capture / Clear.

---

## The 5 Main Navigation Paths

1. **Launch → host list → connect → folder list → session.** App opens at `HostList` (or directly into a saved host's session if "Open on launch" is set) → tap host card → (biometric/passphrase prompt if needed) → SSH lease acquired → bootstrap probe (cached or sheet) → `FolderList` (sessions grouped by folder) → tap session → `TmuxSession` (live terminal, Conversation tab if agent detected).
2. **Create a new agent session.** `FolderList` → "new session" / `RepoBrowser` → `SessionTypePickerSheet` (Shell vs Agent → Claude/Codex/OpenCode, optional profile, skip-permissions) → agent launched via **`pocketshell agent <kind> --dir`** into a detached pane → `TmuxSession` opens on the Conversation view by default → reply via Prompt Composer (voice/text/slash-commands/snippets/attachments).
3. **In-session access to secondary screens.** From `TmuxSession` kebab: Port forwarding → `PortForwardPanel`; Usage → `Usage`; Recurring jobs → `RecurringJobs`; Open file → `FileViewer`; Browse files → `FileExplorer` → `FileViewer`; Settings → `Settings`. From `FolderList` folder action: Env → `EnvFiles`; Git history → `GitHistory`; Browse files → `FileExplorer`.
4. **Host management / import.** `HostList` FAB `+` → `AddHost` (form or "Scan QR" → `Scan`); or Settings → Hosts → Import host; or `pocketshell://import` deep link; or host-card kebab → Edit/Share/Watched folders/Re-check setup. Conflicts surface Overwrite/Add-as-new/Skip.
5. **Share-into-session.** Android share sheet → `ShareActivity` → host picker → per-host target chooser → SCP upload → (session target) launch `MainActivity` into that `TmuxSession` with attachment chips pre-loaded; (text ≤8KB) "paste into session" via tmux `send-keys` + bracketed paste.

---

## Notes for the desktop parity target

- The **connection model (1 SSH per host, warm lease, 60 s grace, tmux `-CC`)** is the load-bearing core — it's the #1 dogfood blocker (D28) and the thing every other feature hangs off.
- The **server-side `pocketshell` helper is shared infrastructure** — a desktop sibling can reuse the same PyPI package verbatim; the contract is one binary, one probe, NDJSON outputs.
- The **agent-awareness layer** (cwd-encoded path detection + JSONL/SQLite parsers + Conversation view + reply composer) is the differentiated surface vs. ordinary SSH clients/VS Code — this is where parity effort pays off most.
- Features the app does NOT have (out of v1 / explicit): Mosh, background work (D21), historical usage charts, dollar-cost tracking from providers, per-session token attribution, cross-session/cross-project conversation search, editing/replaying past tool calls, wake-word, self-hosted Whisper, voice commands inside dictation.
