# Serve this folder — behaviour and the decisions behind it

Right-click a directory in the Files tab → **Serve this folder**. A static HTTP
server starts on the host, the existing port-forward machinery tunnels it, and
the local URL opens in the system browser. The served folder appears in the
**Ports** panel as an ordinary row, badged `served`, with a `stop` button.

Distinct from the **HTML preview**, which renders one remote file by pulling
its assets over SFTP: this runs the actual site, with working relative URLs,
working `fetch`, and working routing, because a real origin is serving it.

| Role | File |
|---|---|
| Command construction, port choice, URL, failure classification (pure) | `src/main/portfwd/serveCommand.ts` |
| Channel, forward, lifetime | `src/main/portfwd/ServeService.ts` |
| IPC (`serve:start` / `stop` / `list` / `event:changed`) | `src/main/ipc.ts`, `src/shared/channels.ts`, `src/preload/index.ts` |
| The action | `src/renderer/components/FileTree.vue` |
| Visible + stoppable | `src/renderer/views/PortPanelView.vue`, `src/renderer/stores/forwards.ts` |
| Tests | `tests/unit/serveCommand.test.ts`, `tests/unit/ServeService.test.ts` |

---

## 1. The bind address

**`127.0.0.1`, always, and it is not a setting.**

`python3 -m http.server` binds *all interfaces* when `--bind` is omitted — its
own `--help` says so. The hosts this app talks to are internet-facing dev
boxes. The folders it is pointed at are whatever the user right-clicked, which
on a dev box means source trees, `.env` siblings, build outputs and `~/git` in
general. Omitting `--bind`, or exposing it as an option, means one mis-click
publishes a directory listing of someone's home directory to the internet, with
no auth, for as long as the app is open — and because nothing in the UI would
look different, with no indication it had happened.

Loopback makes that impossible at the socket. The only route in is the SSH
connection the app already holds, which is authenticated, and the `-L` tunnel
listens on `127.0.0.1` at this end too, so the bytes never touch a network
interface at either end.

A "share this on my LAN" feature, if it is ever wanted, must be a separate,
explicitly-named, explicitly-confirmed action — never a widening of
`SERVE_BIND_ADDRESS`.

`tests/unit/serveCommand.test.ts` asserts `--bind 127.0.0.1` is present and
that `0.0.0.0` never appears in a constructed command.

---

## 2. Which server, and why not the two that were asked for

The request was "use the server in `~/git/ai-buildcamp` … we can put it in
pocketshell cli". Three candidates; the stdlib one wins on availability and
loses nothing.

### Option 1 — `python3 -m http.server` (chosen)

```
python3 -u -m http.server <port> --bind 127.0.0.1 --directory <dir> [--protocol HTTP/1.1]
```

* Ships with the interpreter. `--bind` since 3.4, `--directory` since 3.7,
  `--protocol` since 3.11 — all three are probed, not assumed.
* Works in any folder on any host today. No install, no network, no repo.
* For static files it is a **superset** of the buildcamp app: it serves
  directory indexes (the ASGI app 404s a directory with no `index.html`), it
  falls back to `index.html` when there is one, it uses the same `mimetypes`
  table, and it streams with `shutil.copyfileobj` instead of reading the whole
  file into memory with `Path.read_bytes()` — which matters, because the Files
  tab gets pointed at build outputs full of video and source maps.
* Its traversal guard is `translate_path`: normalise the URL path, drop `..`
  segments, `os.path.join` the survivors onto the root. No prefix comparison to
  get wrong.

### Option 2 — the buildcamp ASGI app (rejected)

`~/git/ai-engineering-buildcamp/mdtohtml/http_server.py`, 79 lines, run as
`uv run --with 'uvicorn[standard]' uvicorn http_server:app`.

* **It is not on the host** — it is one file in one repo on one machine. A
  Files-tab action has to work anywhere the app can reach.
* It needs `uv`, and `--with 'uvicorn[standard]'` resolves and downloads
  uvicorn on first use: a multi-second, network-dependent step in front of an
  action whose whole value is being instant.
* Its traversal check is the **weak spelling** of the idiom —
  `str(file_path).startswith(str(root))`, which also accepts `/rootabc` for a
  root of `/root`. Copying that onto a live box was not worth it, and fixing it
  would have meant maintaining a fork of someone else's file.
* It reads whole files into memory and does not serve directory listings.

### Option 3 — `pocketshell serve` (deferred; see §6)

The shape the user actually asked for, and the right long-term home. Not
first, because it would ship dead. See §6 for what it costs and where it lives.

---

## 3. The tunnel is the existing one

Nothing in this feature opens a socket of its own.

The server binds the host's loopback. `AutoForwarder`'s scan runs every 5s and
keys on the **port**, not the bind address (`PortScanner.extractPort`), so it
sees the server like any other listener. "Forward this one" is then expressed
as the `force-on` **intent** that the Ports panel's own per-row toggle uses.

Consequences, all of them wanted:

* the served folder is an ordinary row — name, byte counters, status, local
  port — because it *is* one;
* it is stoppable from the panel, because rows are;
* there is exactly one kind of tunnel in the app, and one place where local
  port allocation, collision handling and reconnect live.

**Known side effect.** `ForwardService.setIntent` calls `ensure`, which lazily
starts the whole auto-forward engine for that host and persists
`autoEnabled: true`. Serving a folder therefore turns auto-forwarding on. That
is the app's existing contract for forcing a port on (the renderer already
documents it in `stores/forwards.ts`), not something invented here — but it is
a real, visible side effect and it is written down rather than hidden.

**Port range.** `8081–8180`, chosen to sit inside `DEFAULT_AUTO_CONFIG`'s
auto-forward window (≥1024, ≤10000) and away from the numbers dev servers
squat on — 3000, 5173, 8000 (`http.server`'s own default) and 8080. The probe
lists the host's listeners and the first free candidate wins; a lost bind race
is detected from the server's own `Address already in use` and retried on the
next candidate, up to three attempts.

---

## 4. Lifetime — the part that matters on someone else's production box

The server is **not detached**. It runs on a PTY channel from
`SshService.openTrackedShell`, and the command `exec`s the login shell away so
python is the session leader on that pty. Closing the channel is a hangup, and
a hangup on a pty kills its session. So every way the app can go away kills the
server with it, with no bookkeeping that could be wrong:

| Event | Mechanism |
|---|---|
| user presses **stop** | `ServeService.stop` → `ssh.shellClose` |
| user disconnects | `SshService.close` → `ShellTracker.closeAllForConnection` |
| transport drops | sshd tears the channel down from its end |
| app quits | `before-quit` → `registry.clear()` → `client.end()` on every connection |

The alternative — `execBackground` + `setsid` + a pidfile — survives all four,
which sounds like a feature and is not: the failure mode becomes an orphaned
`http.server` still publishing a directory on a live box after the app that
started it is gone, recoverable only through a pidfile that is itself a thing
that can be wrong. Surviving a reconnect is not worth that. Re-serving is one
right-click.

The honest cost: **a dropped connection stops the server.** The panel says so
rather than leaving a URL that quietly answers nothing.

### Stopping is two operations, in order

1. kill the server (`shellClose`);
2. remove the forward by key (`forwards.remove`);
3. clear the intent and the name.

Step 2 has to be explicit. A `force-on` port is forwarded with
`origin: 'manual'`, and `AutoForwarder.stopPass` deliberately never reaps
manual forwards — so without it the local listener would outlive the server and
answer with a connection refused from the far end. Step 3 clears the
`force-off` that `remove` sets, so serving the same folder again is not
silently blocked by the last time it was stopped.

For the same reason the panel **disables** the per-row toggle and the remove
button on a served row: both close the tunnel and would leave the server
running with nothing in the app pointing at it. `stop` is the operation that
ends both.

---

## 5. Failures, and how each one is legible

Everything below produces a sentence in the Files tab's error banner, never a
silent no-op. The first four are refused by the **probe**, before a channel is
opened, so they cost one round trip.

| Failure | Detected by | What the user sees |
|---|---|---|
| no python3 on the host | probe: `command -v python3 \|\| command -v python` | "No python3 on the host — the folder server needs it." |
| python too old (<3.7, or python 2) | probe: `python -V` | "…is too old to serve a folder; 3.7 or newer is needed." |
| directory gone / is a file / unreadable | probe: `[ -e ]` / `[ -d ]` / `[ -r ] && [ -x ]` | "/srv/x is not there on the host." etc. |
| every candidate port busy | probe listener scan + `choosePort` | "No free port in 8081-8180 on the host." |
| lost bind race | server's `Address already in use` | *(recovered silently — next candidate)* |
| server dies later | PTY channel `close` | row goes `failed`, tunnel torn down, panel updates |
| tunnel never opens | `waitForForward` timeout | everything is torn down and the error names the port — **no record with a null URL is ever returned** |

Both `r` and `x` are checked on the directory: one without the other produces a
server that starts fine and then 403s everything, which is the least legible
outcome available.

---

## 6. `pocketshell serve` — the follow-up, and what it costs

**Where the CLI actually lives:** `~/git/pocketshell/tools/pocketshell` on the
host — a `hatchling` sub-project *inside the Android repo*, not a separate
checkout and not importable from the system python. It is installed as a `uv`
tool (`~/.local/share/uv/tools/pocketshell/`, receipt points at that directory)
and exposes `~/.local/bin/pocketshell`. Version on `hetzner`: **0.4.44**, which
matches `pyproject.toml` in that tree.

Adding a subcommand is mechanically trivial — `src/pocketshell/serve.py` with a
`@click.command`, one `cli.add_command(serve_command, name="serve")` line in
`src/pocketshell/cli.py` alongside the twenty already there.

The cost is everything around it:

* `pyproject.toml` pins the version to `versionName` in
  `app/build.gradle.kts`, enforced by `scripts/check-pypi-version.sh` in CI —
  so a subcommand means an Android release-tagged version bump and a PyPI
  publish;
* every host has to upgrade before the desktop feature works at all;
* no backwards-compat, hard cuts only — this
  app does not sniff helper versions and deliberately deleted the machinery
  that used to. So a desktop feature gated on `pocketshell serve` cannot fall
  back; it would simply be broken on every host until each one upgraded.

So: ship on the stdlib today, propose the subcommand separately. Retiring the
stdlib path later costs one function — `serveCommand()` — because everything
else in `ServeService` is about channels and forwards, not about which binary
is on the far end.

If it is built, the subcommand should earn its keep by doing what the stdlib
cannot: pick and report a free port atomically (closing the TOCTOU this
implementation retries around), emit a machine-readable ready line instead of
prose we pattern-match, and hold the socket itself so there is no bind race at
all.

---

## 7. Not verified

* **No server was actually started on `hetzner`.** The task was read-only on
  that box, so the transcript this implementation classifies (`Serving HTTP
  on …`, `[Errno 98] Address already in use`) comes from CPython's source and
  its `--help`, both read on the host, not from a live run. What *was* verified
  there: `python3` is 3.12.3 at `/usr/bin/python3`, and `python3 -m http.server
  --help` lists `--bind`, `--directory` and `--protocol`.
* **The hangup-kills-the-server property is reasoned, not observed** — it
  follows from `exec` making python the pty session leader and from sshd's
  SIGHUP on channel close, and the four teardown paths in §4 were traced in the
  code, but no end-to-end "quit the app, check the host" run was done.
