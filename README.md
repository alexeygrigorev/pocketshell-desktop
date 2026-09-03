# PocketShell Desktop

A desktop SSH client built around tmux and AI coding agents — the keyboard-first
sibling of the [PocketShell](https://github.com/alexeygrigorev/pocketshell)
Android app. Pick a machine you develop on, see every tmux session running on
it, work in real terminals, edit files, forward ports, and keep an eye on your
AI agent usage — all in one window.

> **Status:** under active development.

## How it works

PocketShell pairs with a small helper (`pocketshell`) that runs on the machine
you connect to. The app reads your existing `~/.ssh/config` — no new
credentials to set up — and the helper tells it about sessions, agents, and
quota.

Because every session is a real tmux session, your work doesn't live in the
app. Close the laptop, come back tomorrow, reconnect — everything is still
running, exactly where you left it.

## What you can do

**Connect.** Hosts come straight from `~/.ssh/config` (with a manual-add
fallback), and host keys are verified against `known_hosts`. On connect, the
app checks the machine for `tmux` and the `pocketshell` helper and offers to
install whatever is missing. If the network drops, the app reconnects on its
own and restores your sessions and port forwards.

**Sessions and terminals.** The session panel lists every tmux session with
its last activity and a badge showing which agent runs in it — Claude Code,
Codex, OpenCode. Sessions that share a project folder open together as one
workspace: a tab per session, plus tabs for browsing files. Keystrokes and
resize go straight to tmux. Click the active tab to rename the session,
right-click it to stop it, or start a new one with an agent of your choice
from the workspace's `+` menu.

**Prompt composer.** A side panel for drafting what you send to your agents —
multi-line, resizable, with file attachments. Each workspace keeps its own
draft, so switching tabs never loses what you typed. Toggle it with
<kbd>Ctrl</kbd>+<kbd>\`</kbd>, send with <kbd>Enter</kbd>. Start typing
anywhere in a workspace and the composer opens for you (configurable).

**Files.** A full file browser over SFTP: browse the remote tree, open and
edit text files in the built-in editor, preview images, upload and download
(by drag-and-drop), create, rename and delete. Saving writes straight back to
the server.

**Port forwarding.** Local, remote, and dynamic SOCKS forwards, added by hand
or discovered for you: auto-forward watches which ports are actually listening
on the server and mirrors them locally. Each rule shows its status, bytes and
speed; forwarded HTTP ports open in your browser with one click. Forward
setups are remembered per host.

**Usage and environment.** A quota dashboard shows what's left per AI provider
and when it resets, read straight from the server helper. A per-folder env
editor lets you inspect and change the environment your agents run with.

## Keyboard

Every shortcut is listed — and rebindable — in **Settings → Keyboard**. The
ones worth learning first:

| Keys | Does |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>\`</kbd> | Toggle the prompt composer |
| <kbd>Ctrl</kbd>+<kbd>[</kbd> / <kbd>]</kbd> | Previous / next tab |
| <kbd>Ctrl</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd> | Move between folder workspaces |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> | New session |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> / <kbd>V</kbd> | Copy selection / paste into the composer |
| right-click | Paste into the shell |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> / <kbd>L</kbd> / <kbd>F</kbd> | Save / path bar / filter — on the Files tab |

Chords that belong to the shell (<kbd>Ctrl</kbd>+<kbd>C</kbd>,
<kbd>Ctrl</kbd>+<kbd>D</kbd>, the tmux prefix, …) are never taken by the app.

## Getting started

**On the machine you connect to** you need SSH access with key
authentication, `tmux`, and the helper:

```bash
uv tool install pocketshell
```

(The app detects what's missing on first connect and offers one-click
install, so this step is optional.)

**On your desktop**, grab an installer for Windows, macOS or Linux from the
[Releases](../../releases) page, or run from source — you need Node 20+:

```bash
npm install
npm run dev
```

## Design principles

- **Your state lives on the server.** tmux keeps the sessions; the app is a
  window onto them and reconnects freely.
- **No secrets on the client.** Quota and agent data come from the server
  helper; the desktop stores no API keys.
- **Your keys stay yours.** The shell gets every key it expects — the app
  only claims chords a terminal cannot send.

## Design & development docs

The reasoning behind the app lives in [docs/](./docs): process model and security
([ARCHITECTURE](./docs/ARCHITECTURE.md)), port-forwarding behaviour
([PORTFWD](./docs/PORTFWD.md)), every shortcut and why it exists
([SHORTCUTS](./docs/SHORTCUTS.md)), and the test strategy
([TESTING](./docs/TESTING.md)).

Development at a glance: `npm run dev` (app with HMR) · `npm run dist`
(installers) · `npm run test:unit` / `test:integration` / `test:e2e` (the
latter two need Docker) · `scripts/smoke.sh` (full gate). Tech: Electron ·
Vue 3 + TypeScript · Vite · `ssh2` · xterm.js · CodeMirror 6 · Pinia.

## License

MIT.
