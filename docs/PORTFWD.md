# Port Forwarding — behaviour spec ported from `ssh-auto-forward`

This document extracts the behaviour of the user's Python tool
**`ssh-auto-forward`** (local clone `C:\Users\alexey\git\ssh-auto-forward`,
v0.0.4, published to PyPI) so it can be **reimplemented** in
`src/main/portfwd/`.

## The decision this document implements

The Python tool is not embedded, shelled out to, or shipped. It opens its own
paramiko connection per host; PocketShell already holds exactly **one
authenticated `ssh2` connection per host** and that property is load-bearing
(one auth, one keepalive, one TOFU prompt, one reconnect FSM). So the
*behaviour* is ported onto the existing connection and the Python process,
its `uv` runtime, and its stdout are never involved.

Everything below is therefore phrased as: **what the Python does (with
`file:line`) → what `src/main/portfwd/` does today → the diff-ready change.**

## Source map

| Role | File |
|---|---|
| Python core (scan, filter, tunnel, reconnect, persistence) | `ssh_auto_forward/forwarder.py` (1236 ln) |
| Python TUI (display derivation, remap/name UX, reconnect countdown) | `ssh_auto_forward/dashboard.py` (1267 ln) |
| Python CLI flags + defaults | `ssh_auto_forward/cli.py` (137 ln) |
| Python unit tests (encode the edge cases) | `tests/test_cli.py` |
| Python integration tests (Docker sshd) | `tests_integration/test_auto_forward.py`, `test_dashboard.py` |
| Target: scan loop + policy | `src/main/portfwd/AutoForwarder.ts` |
| Target: one forward rule (-L/-R/-D) | `src/main/portfwd/Forwarder.ts` |
| Target: remote scan orchestration | `src/main/portfwd/scanRemotePorts.ts` |
| Target: pure `ss`/`netstat` parsers | `src/main/portfwd/PortScanner.ts` |
| Target: per-connection manager + IPC surface | `src/main/portfwd/ForwardService.ts` |
| Target: reconnect FSM (currently orphaned) | `src/main/portfwd/AutoForwarderSupervisor.ts` |
| Target: UI | `src/renderer/views/PortPanelView.vue`, `src/renderer/stores/forwards.ts` |
| Rides on this engine: "Serve this folder" | `src/main/portfwd/ServeService.ts`, **`docs/SERVE.md`** |
| Already-built SSH config parser (models `LocalForward`) | `src/main/ssh-config/SshConfigParser.ts` |

One feature is built ON this engine rather than described by this spec:
**"Serve this folder"** (`docs/SERVE.md`) starts a static HTTP server on the
host's *loopback*, and then does nothing special — the scan finds the port like
any other listener and a `force-on` intent opens the tunnel. It is worth knowing
about here for two reasons: a `served` row in the panel has a remote process
behind it, so its toggle and remove buttons are deliberately disabled in favour
of `stop`; and it is the first caller that starts the engine as a *side effect*
of an action taken in another tab.

`docs/ANALYSIS.md` §4 records the lineage: the Android engine came from
`ssh-auto-forward-android`, **local (`-L`) forwards only**; the desktop added
`-R` and `-D` net-new (`ANALYSIS.md:182`, `:290`). Nothing in this spec
touches `-R`/`-D` semantics — auto-forwarding is `-L`-only in Python, in
Android, and here. `-R`/`-D` stay manual-only and keep working; they simply
share the key, state, and persistence model defined below.

---

## 0. Behaviour inventory (the gap at a glance)

| # | Behaviour | Python | Node today | Verdict |
|---|---|---|---|---|
| 1 | Scan command | `ss -tlnp`→`netstat -tlnp`→`ss -tln`→`netstat -tln`, first non-empty wins | `ss -tln` (+ `netstat -tln` fallback) then enrich from `ss -tlnp` | **differs, Node's order is better** |
| 1 | Scan interval | 5s (`-i`), dashboard hardcodes 5s | 10s | differs (align to 5s) |
| 1 | Non-blocking | background thread + single-flight guard | async, **no single-flight guard** | gap |
| 2 | Skip well-known | ports **0–999** (1000 forwarded) | ports **0–1023** | differs — pick one, document it |
| 2 | `--skip` list | unions with the default set | absent | gap |
| 2 | Max auto port | 10000, **inclusive** | 10000, inclusive | matches |
| 2 | Above-max ports | shown, manually forwardable | not shown, not forwardable | gap |
| 3 | Process name | `ss`/`netstat` proc column → `_parse_process_info` | `ss -tlnp` regex only | partial |
| 3 | PID + working folder | `readlink /proc/$pid/cwd` per PID | **absent** | gap (distinctive feature) |
| 4 | Local port choice | remap → mirror → `+1…+999` → sweep 3000+ | remap → mirror → 3000–3999 (own-forwards check only) | gap (no `+1` retry, no OS bind check) |
| 4 | Remap range | `-p 3000:10000` is **dead config** | `[3000, 3999]` | Node closer to intent |
| 5 | Friendly names | `~/.ssh-auto-forward/port-names.json`, per host alias | **absent** | gap |
| 6 | Auto-start on new port | yes, every scan | yes | matches |
| 6 | Auto-stop on vanished port | yes, **no debounce**; kills manual tunnels too | yes, keeps manual ports | Node better, both need debounce |
| 6 | Empty-scan protection | `if not remote_ports: return` | **none — tears down everything** | **Node bug** |
| 7 | SSH config `LocalForward` | parsed, excluded from auto, shown read-only ("Auto (SSH Config)") | parsed in `SshConfigParser`, never reaches `AutoForwarder` | gap |
| 8 | Reconnect | CLI 5→10→20→40→60s; TUI flat 5s countdown; tunnels dropped, rebuilt by next scan | `AutoForwarderSupervisor` (5→60s, 10 attempts) but **orphaned and opens its own connection** | needs rework |
| 9 | Persistence | port names only | **nothing** | gap |

---

## 1. Port discovery

### What the Python does

`SSHAutoForwarder.get_remote_listening_ports()` — `forwarder.py:779-859`.
Returns `Dict[int, str]` (remote port → process name).

Primary commands, tried in order; the **first that yields a non-empty dict
wins** (`forwarder.py:783-825`):

```
ss -tlnp      2>/dev/null | awk 'NR>1 {print $4, $7}'
netstat -tlnp 2>/dev/null | awk 'NR>1 && /LISTEN/ {print $4, $7}'
```

A command whose stderr contains `permission denied` (case-insensitive) is
skipped outright (`:793-794`). Parsing (`:798-815`): split on whitespace,
require ≥2 fields, `parts[0]` must contain `:`, the substring after the **last**
`:` must be all digits (`str.isdigit()`) — so `*:8080`, `[::]:8080`, and
`0.0.0.0:8080` all work and `*:*` is dropped. `parts[1]` is the process blob.

Fallback commands, only if both primaries produced nothing (`:828-851`):

```
ss -tln      2>/dev/null | awk 'NR>1 {print $4}'
netstat -tln 2>/dev/null | awk 'NR>1 && /LISTEN/ {print $4}'
```

Process name becomes `""`, and `process_pids` / `process_working_dirs` are
cleared (`:849-850`).

**Interval.** `-i/--interval`, default **5** seconds (`cli.py:42`). The CLI
loop sleeps `scan_interval` between scans (`forwarder.py:1165`).

**Non-blocking.** Only the dashboard needs this. `_start_background_refresh`
(`dashboard.py:930-943`) takes `_refresh_lock`, refuses to start if
`_refresh_in_progress`, then runs the scan on a daemon thread and marshals the
result back with `call_from_thread`. Overlapping scans are **dropped, not
queued** (`:936-938`).

### What Node does

`scanRemotePorts.ts:21-53` deliberately **inverts the priority**: `ss -tln`
first (full port list), then enrich with process names from `ss -tlnp`,
because `ss -tlnp` as non-root *filters out* rows whose process it cannot
read rather than blanking the name. That comment (`scanRemotePorts.ts:15-19`,
repeated at `AutoForwarder.ts:168-171`) is **correct and the Python gets this
wrong** — see §10. Keep it.

Cost: 2–3 sequential `exec`s per scan, each a full SSH channel round trip.
`AutoForwarder.start()` (`AutoForwarder.ts:61-65`) fires `setInterval` with no
in-flight guard, so on a slow link scans can overlap and interleave their
teardown decisions.

### Recommendation — `scanRemotePorts.ts`

1. **Collapse the round trips.** One `exec` emitting all candidate outputs
   with sentinels, then split in `PortScanner.ts`:

   ```ts
   const SCAN_CMD = [
     "echo '<<<PS_SS_TLN>>>';   ss -tln       2>/dev/null;",
     "echo '<<<PS_SS_TLNP>>>';  ss -tlnp      2>/dev/null;",
     "echo '<<<PS_NETSTAT>>>';  netstat -tlnp 2>/dev/null;",
     "echo '<<<PS_END>>>'",
   ].join(' ');
   ```
   Keep the existing merge policy: full port list from `ss -tln` (or
   `netstat` if empty), process names merged in by port number from
   `ss -tlnp` / `netstat -tlnp`.
2. **Single-flight the loop** in `AutoForwarder`:
   ```ts
   private scanning = false;
   private async scanAndForward(): Promise<void> {
     if (this.scanning) return;   // Python dashboard.py:936-938
     this.scanning = true;
     try { /* ... */ } finally { this.scanning = false; }
   }
   ```
3. **Default `scanIntervalSec` 10 → 5** (`AutoForwarder.ts:30`) to match
   `cli.py:42`, and make it user-settable.

---

## 2. Filtering

### Exact rules

| Rule | Python | Boundary |
|---|---|---|
| Well-known skip | `DEFAULT_SKIP_PORTS = set(range(0, 1000))` — `forwarder.py:19` | **0–999 skipped; port 1000 IS forwarded.** Asserted by `tests/test_cli.py:310-319` (`len == 1000`) |
| `--skip` | `skip_ports = DEFAULT_SKIP_PORTS.copy(); skip_ports.update(extra)` — `cli.py:95-99` | **Adds to** the default set; never replaces it |
| Max auto port | `if port <= self.max_auto_port` — `forwarder.py:1051`, default 10000 (`forwarder.py:21`, `cli.py:62`) | **Inclusive** — 10000 is auto-forwarded |
| Above max | shown in the table, **not** auto-forwarded (`forwarder.py:1053`); a manual toggle forwards it and marks it `manual_tunnels` (`:957-958`) | `forward_port` itself never checks `max_auto_port` |

`forward_port` (`forwarder.py:900-943`) applies five further exclusions, in
order:

1. already in `self.tunnels` → returns **True** (idempotent no-op) — `:909-910`
2. in `skip_ports` → False — `:912-914`
3. in `config_local_forwards` → False (SSH itself owns it) — `:916-922`
4. the remote port number is **already in use as one of our own local listen
   ports** → False — `:924-929`. Prevents mirroring a port that would collide
   with a tunnel we already opened.
5. in `failed_ports` → False — `:931-933`. Sticky: `failed_ports` is only
   cleared in `stop_forwarding_port` (`:983`), which only runs for ports that
   are *in* `tunnels` — a port that failed never got there. So a failure is
   **permanent for the process lifetime** unless a reconnect wipes state
   (`_clear_stale_state`, `:1106`). Android used a 60s TTL
   (`ANALYSIS.md:209`).

### Node today

`shouldForward` (`AutoForwarder.ts:145-149`): `manual` set wins, else
`port >= skipPortsBelow && port <= maxAutoPort` with `skipPortsBelow: 1024`
(`:31`). No `--skip` list, no failed-port memory, no config-forward exclusion,
no own-local-port guard.

### Recommendation — `AutoForwarder.ts`

```ts
export interface AutoForwardConfig {
  scanIntervalSec: number;          // 5
  maxAutoPort: number;              // 10_000 (inclusive)
  skipPortsBelow: number;           // 1024 — see note
  /** Extra ports never auto-forwarded (the Python `--skip` list). */
  skipPorts: number[];              // []
  localPortRange: [number, number]; // [3000, 65535] — sweep bound, see §4
  /** Retry a port that failed to bind after this long. Android: 60s. */
  failedPortTtlMs: number;          // 60_000
  /** Scans a port may be missing before its tunnel is torn down. */
  missingScansBeforeStop: number;   // 2
}
```

- **Keep `skipPortsBelow: 1024`, do not move it to 1000.** 1024 is the real
  privileged-port boundary, matches Android (`ANALYSIS.md:209`), and the
  Python's 1000 is an arbitrary round number. This is a deliberate,
  documented divergence — the only ports affected are 1000–1023.
- Add `skipPorts` to the union: `if (this.config.skipPorts.includes(p)) return false;`
- Add a `failedPorts: Map<number, number>` (port → epoch ms) checked and
  expired against `failedPortTtlMs`, cleared when the port disappears from a
  scan. Without it, every failed bind is retried every 5s forever.
- Add the own-local-port guard (Python rule 4): skip a remote port that equals
  a `listenPort` we already hold, unless it is that forward's own mirror.
- Ports **above** `maxAutoPort` must still reach the UI (see §3/§7 —
  `ForwardState` needs discovered-but-not-forwarded rows) so the user can
  toggle them on.

---

## 3. Process and folder attribution

This is the tool's most distinctive feature and Node has **none** of it.

### Process name — `_parse_process_info` (`forwarder.py:59-78`)

```
name: first  /"([^"]+)"/  group                       -> "python3"
      else if "/" in blob: blob.split("/")[-1].split(",")[0]  -> "12345/node" -> "node"
      else "unknown"
pid:  /pid=(\d+)/  else  /^(\d+)\//  else  /\/(\d+)(?:\/|$)/
```

Covered by `tests/test_cli.py:91-100`: `users:(("python",pid=12345,fd=7))` →
`("python", 12345)`; `12345/node` → `("node", 12345)`.

### Working folder — `_get_remote_process_cwds` (`forwarder.py:754-777`)

One shell command over all discovered PIDs:

```sh
for pid in 123 456 789; do
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) && printf "%s\t%s\n" "$pid" "$cwd";
done
```

Parsed as `pid<TAB>cwd`, requiring a digit PID and a non-empty cwd
(`:772-777`). Mapped port → cwd via the port→PID table (`:820-824`). Ports
that disappear have their PID and cwd evicted (`:1064-1067`).

Reality check: `readlink /proc/<pid>/cwd` only succeeds for **your own
processes or as root**. The Docker fixture (`docker/Dockerfile`) runs sshd as
root, so the tests never exercise the non-root case. Expect `cwd` to be `null`
for most ports on a real shared box — the UI must degrade to `-`, exactly as
`_compact_path` does for an empty string (`dashboard.py:66-67`).

### Display derivation (`dashboard.py`)

- Process: `_compact_text(name, 14)` (`:222`) — `<=14` chars verbatim, else
  first `max-3` chars + `...` (`:53-59`). Empty → dim `unknown`.
- Name: `_compact_text(name, 16)` (`:224`). Empty → dim `-`.
- Folder: `_compact_path(cwd, max_chars=18, tail_parts=2)` (`:62-82`):
  1. normalise `\`→`/`, strip trailing `/`; empty → `-`
  2. join the **last 2** path segments; prefix `.../` if more than 2 existed
  3. if that is `<= 18` chars, done — `/home/alexey/projects/client/web-api`
     → `.../client/web-api` (`tests_integration/test_dashboard.py:360-365`)
  4. else try `.../{basename}`
  5. else `"..." + basename[-(max-3):]`

### Recommendation

`PortScanner.ts` — widen the row:

```ts
export interface RemotePort {
  port: number;
  process: string | null;   // compact name, already parsed
  pid: number | null;       // NEW
  cwd: string | null;       // NEW, filled by the second exec
}
```

Port `_parse_process_info` verbatim as a pure exported function
`parseProcessInfo(blob: string): { name: string | null; pid: number | null }`
and unit-test it against the two strings in `tests/test_cli.py:91-100`.

`scanRemotePorts.ts` — after the listener scan, one extra exec for cwds:

```ts
const pids = ports.map(p => p.pid).filter((n): n is number => Number.isInteger(n));
// SECURITY: pids are parsed from remote output and interpolated into a shell
// command. Filter to integers (above) — never pass the raw token through.
if (pids.length) {
  const cmd = `for pid in ${pids.join(' ')}; do ` +
    `cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) && printf '%s\\t%s\\n' "$pid" "$cwd"; done`;
  // NOTE: pathAwareCommand() single-quote-escapes; verify the \t survives the
  // /bin/sh -lc wrapper against a real host before trusting it.
}
```

Keep `_compact_text` / `_compact_path` **out of the main process** — they are
presentation. Ship raw `process` and `cwd` over IPC and put the truncation in
`PortPanelView.vue` (which owns CSS-based truncation anyway). Port
`_compact_path`'s *segment* logic (last two segments, `.../` prefix) if the
renderer wants it; the char-budget arithmetic is a TUI artifact.

---

## 4. Local port allocation

### What the Python does

`find_available_local_port(preferred)` — `forwarder.py:879-898`:

1. `preferred` if available
2. else `preferred+1 … preferred+999`, stopping at 65535 (`:886-891`)
3. else a linear sweep `3000 … 65534` (`:894-896`)
4. else `None` → the caller records the port in `failed_ports` (`:940-943`)

`is_local_port_available(port)` — `:861-877`: `False` if the port is already a
value in `local_port_map`; otherwise **actually binds** `127.0.0.1:port` with
`SO_REUSEADDR` and reports success. The `SO_REUSEADDR` detail is deliberate
(`:867-870`): without it a port in `TIME_WAIT` from a just-closed forwarded
connection reads as busy and the tool needlessly remaps to `port+1`. That is a
fixed bug preserved in a comment — do not lose it.

`preferred` is the remote port itself, so the default is **mirror**
(`forward_port`, `:936-939`: explicit `local_port` → `port_remappings` →
`find_available_local_port(remote_port)`).

**`--port-range` is dead.** `-p MIN:MAX` (default `3000:10000`) is parsed
(`cli.py:88-89`), stored as `self.port_range` (`forwarder.py:521`), used to
seed `self.next_alt_port` (`:533`) — and `next_alt_port` is never read again.
The sweep is hardcoded `range(3000, 65535)`. `tests/test_cli.py:137-149` sets
`port_range` and only ever asserts 3000. Do not port the flag as-is.

**User remap.** `set_port_remapping(remote, local)` (`:1008-1031`): validates
availability, stores in `port_remappings`, and if a tunnel is live, stops and
restarts it preserving the manual flag. `clear_port_remapping` (`:1033-1035`)
just drops the entry — the dashboard is what restarts the tunnel afterwards
(`dashboard.py:1150-1161`). Remaps survive reconnects (`forwarder.py:1108`
explicitly keeps `port_remappings` and `port_names` in `_clear_stale_state`)
but **not process restarts** — despite the docstring calling them
"persistent" (`:1009`).

### What Node does

`resolveLocalPort` (`AutoForwarder.ts:151-158`) + `allocateLocalPort`
(`:160-165`): remap wins, in-range ports mirror, out-of-range allocate the
first port in `3000..3999` not used by *our own* forwards. It never asks the
OS. A collision surfaces as `Forwarder.start()` resolving `false`
(`Forwarder.ts:114`), the forward is silently dropped, and the next scan
retries identically — an infinite quiet failure loop.

### Recommendation — `AutoForwarder.ts`

```ts
private async resolveLocalPort(remotePort: number): Promise<number | null> {
  const remap = this.remappings.get(remotePort);
  if (remap !== undefined) return remap;          // user choice always wins
  return this.findAvailableLocalPort(remotePort); // mirror, then +1.., then sweep
}

/** Port of forwarder.py:861-898. */
private async findAvailableLocalPort(preferred: number): Promise<number | null> {
  if (await this.isLocalPortAvailable(preferred)) return preferred;
  for (let off = 1; off < 1000 && preferred + off <= 65535; off++) {
    if (await this.isLocalPortAvailable(preferred + off)) return preferred + off;
  }
  const [lo, hi] = this.config.localPortRange;
  for (let p = lo; p <= hi; p++) if (await this.isLocalPortAvailable(p)) return p;
  return null;
}

/** In-use by one of our forwards, or unbindable. SO_REUSEADDR is the point. */
private isLocalPortAvailable(port: number): Promise<boolean> {
  if ([...this.forwards.values()].some(f => f.spec.listenPort === port)) {
    return Promise.resolve(false);
  }
  return new Promise(resolve => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen({ port, host: '127.0.0.1', exclusive: false }, () => s.close(() => resolve(true)));
  });
}
```

`exclusive: false` is Node's `SO_REUSEADDR` equivalent; keep the Python's
comment about `TIME_WAIT` so the next reader does not "simplify" it away.
There is an inherent TOCTOU between probe and bind — that is fine, the bind
failure path still exists; the probe just makes the common case pick a working
port on the first try instead of never.

Set `localPortRange` default to `[3000, 65535]` (the sweep the Python
actually performs), not `[3000, 3999]` — the 999-port window is exhaustible on
a busy box and `allocateLocalPort` currently **throws** when it runs out
(`AutoForwarder.ts:164`) inside an un-awaited `void this.scanAndForward()`,
i.e. an unhandled rejection. Return `null` and record a failed port instead.

**A user remap must persist across restarts** (§9) — this is the one place the
Node app should be strictly better than the Python.

---

## 5. Friendly names

### What the Python does

- Path: `~/.ssh-auto-forward/port-names.json` (`forwarder.py:27`).
- Schema: `{ "<host alias>": { "<remote port>": "<name>" } }` — verified by
  the round-trip test `tests/test_cli.py:103-109`.
- Load (`:30-46`): missing file → `{}`; non-dict → `{}`; per-host dicts
  coerced to `str→str`, empty names dropped; JSON/OS errors swallowed.
  At construction, filtered to this host and keys parsed to `int`, dropping
  non-numeric keys (`:537-542`).
- Save (`:49-56`): atomic — write `<path>.tmp`, `indent=2`, `sort_keys=True`,
  trailing newline, then `os.replace`.
- `set_port_name` trims; an empty name **deletes** the entry (`:985-992`).
  `_save_port_names` (`:999-1006`) re-reads the whole file first, so two
  concurrent host sessions do not clobber each other, and removes the host key
  entirely when its last name is cleared.
- Keyed by the **SSH config host alias** (`self.host_alias`), not by
  hostname/IP — two aliases pointing at the same box keep separate name sets.

### Recommendation

Node has nothing here. Use `electron-store` (already a dependency,
`package.json:27`, currently unused anywhere in `src/`) — see §9 for the full
schema. Two wrinkles:

1. **There is no host alias in the main process.** `ipc.ssh.connect`
   (`src/main/ipc.ts:76-101`) takes `{host, port, user, ...}` and
   `ConnectionRecord` (`ConnectionRegistry.ts:12-23`) stores
   `host/port/user/label` — the `~/.ssh/config` `Host` name is dropped at the
   IPC boundary even though the renderer has it on `HostEntry.name`. Add an
   optional `hostAlias?: string` to `ConnectOptions`/`ConnectionRecord` and
   pass `HostEntry.name` through. *(That file is owned by another agent —
   flag it, don't edit it.)*
2. Until then, derive `hostKey = rec.hostAlias ?? \`${rec.user}@${rec.host}:${rec.port}\``
   in one exported helper so the fallback and the real key never diverge.

`electron-store` writes atomically already, so the tmp+replace dance is free.

---

## 6. Lifecycle: start, stop, and flap protection

### What the Python does — `scan_and_forward` (`forwarder.py:1037-1070`)

```python
remote_ports = self.get_remote_listening_ports()
if not remote_ports:
    return                                   # <-- :1041-1042
self.all_remote_ports = remote_ports.copy()
for port, proc in remote_ports.items():
    if port <= self.max_auto_port:
        self.forward_port(port, proc)        # idempotent
closed = set(self.tunnels) - set(remote_ports)
for port in closed:
    self.stop_forwarding_port(port)          # <-- no grace period
```

Two things matter:

- **`if not remote_ports: return` is the only flap protection there is.** A
  scan that fails entirely (transport hiccup, `ss` missing, permission error)
  returns `{}` and the loop leaves every tunnel alone. There is **no
  per-port debounce**: one scan in which a port is genuinely absent tears its
  tunnel down immediately.
- **Manual tunnels are torn down too.** `closed` is computed from
  `self.tunnels` without consulting `manual_tunnels`, so a hand-forwarded high
  port dies the moment its process stops listening — even though the user
  explicitly asked for it.

`stop_forwarding_port` (`:972-983`) closes the listener and evicts the port
from `tunnels`, `local_port_map`, `process_names`, `process_pids`,
`process_working_dirs`, `manual_tunnels`, and `failed_ports` (so a port that
comes back is retried).

### What Node does — `scanAndForward` (`AutoForwarder.ts:113-143`)

Same shape, two differences:

- It **keeps manually-toggled ports alive** across a disappearance
  (`:138`) — better than the Python, do not regress it.
- It has **no empty-scan guard**. `scanRemotePorts` returns `[]` on any exec
  failure (`scanRemotePorts.ts:38`), so a single failed scan makes
  `activeRemote` empty and stops *every* non-manual forward. Mid-download,
  silently. **This is the most damaging bug in the current Node code.**

`togglePort` (`AutoForwarder.ts:99-107`) is also semantically wrong for the
UI: toggling a port that policy already forwards adds it to `manual` (no
visible change); toggling again removes it from `manual` but policy
immediately re-forwards it. There is no "user disabled this port" state, so
the panel's toggle cannot turn an in-policy port off.

### Recommendation — `AutoForwarder.ts`

```ts
private missing = new Map<number, number>();   // remotePort -> consecutive misses
private disabled = new Set<number>();          // user said "off" (survives scans)

private async scanAndForward(): Promise<void> {
  const ports = await this.scan();
  if (ports.length === 0) return;              // forwarder.py:1041-1042
  // ... start pass ...
  for (const [key, f] of this.forwards) {
    if (f.spec.kind !== 'local' || f.origin === 'manual') continue;
    const seen = activeRemote.has(f.spec.destPort);
    const misses = seen ? 0 : (this.missing.get(f.spec.destPort) ?? 0) + 1;
    this.missing.set(f.spec.destPort, misses);
    if (misses >= this.config.missingScansBeforeStop) { await f.stop(); /* ... */ }
  }
}
```

`missingScansBeforeStop: 2` at a 5s interval means a service must be gone for
~10s before its tunnel drops — enough to ride out a `systemctl restart` or a
dev server reload, which is precisely the flap the Python thrashes on. Reset
the counter to 0 whenever the port reappears.

Replace `togglePort` with an explicit tri-state so the UI toggle is honest:

```ts
/** User intent for one remote port. Absent = follow the auto policy. */
type PortIntent = 'force-on' | 'force-off';
private readonly intents = new Map<number, PortIntent>();
```

`shouldForward` = `intent === 'force-on'` → true; `'force-off'` → false; else
the range policy. Persist `force-off` per host (§9) — a user who silenced a
noisy port expects it silent tomorrow.

---

## 7. SSH config `LocalForward`

### What the Python does

Parsed inside its own hand-rolled config reader
(`_load_ssh_config`, `forwarder.py:604-625`) into
`config["local_forwards"]: Dict[remote_port, local_port]`:

- form `LocalForward [bind:]localPort host:remotePort`
- the local port is the token after the last `:` of field 1, so
  `127.0.0.1:8080` → `8080` (`:611-615`, test `tests/test_cli.py:396-408`)
- field 2 **must** contain `:`, otherwise the line is dropped (`:619-620`)
- keyed **remote → local**, so `LocalForward 8081 localhost:8080` stores
  `{8080: 8081}` (test `:410-423`)

Interactions:

1. `forward_port` refuses any port in `config_local_forwards` (`:916-922`) —
   SSH itself owns that local port, so auto-forwarding it would collide.
2. The dashboard merges them into the table even when the remote scan did not
   see them, with process name `"SSH Config"` (`dashboard.py:158-160`), a
   cyan status dot (`:204`), the configured local port, a clickable URL, and
   no traffic stats. The README calls this the **"Auto (SSH Config)"** status
   — that literal string does not exist in the code, only the cyan dot does.
3. Toggling such a row is refused with
   *"Port N is forwarded via SSH config - cannot toggle here"*
   (`dashboard.py:268-272`, `:345-350`).
4. `--include-configs` / `include_config_ports` is threaded from `cli.py:71-75`
   all the way into `TunnelDataTable.__init__` (`dashboard.py:111`) and **never
   read**. Dead flag; do not port it.

### What Node has

`SshConfigParser.ts:171-175` already parses `LocalForward`/`RemoteForward`
into `ForwardSpec[]` on `HostEntry.localForwards` / `.remoteForwards`
(`types.ts:29-30`), handling `[::1]:8080`, `host:port`, and bare-port forms
(`splitHostPort`, `:235-248`). This is strictly better than the Python parser.
It just never reaches `AutoForwarder`.

### Recommendation — and one deliberate divergence

Pass the host's `localForwards` into the forwarder:

```ts
constructor(
  ssh, connectionId, registry,
  config = DEFAULT_AUTO_CONFIG,
  remappings: Record<number, number> = {},
  configForwards: ForwardSpec[] = [],   // NEW: HostEntry.localForwards
)
```

- **Exclude** every `destPort` in `configForwards` from the auto policy
  (Python rule 3, `forwarder.py:916-922`).
- **Surface** them as rows with `origin: 'ssh-config'` so the panel can render
  the "Auto (SSH Config)" status and disable the remove/toggle button.

The divergence: in the Python's world the user separately runs
`ssh -L …` from OpenSSH, so those local ports really are bound by another
process and the tool is only *reporting*. **PocketShell is the SSH client.**
Nothing else establishes those forwards. So the desktop should actually
**open them** on connect as ordinary `-L` forwards tagged
`origin: 'ssh-config'` — the config said "I want this forward" and we are the
one connection that can honour it. If the bind fails with `EADDRINUSE`
(because the user *does* have a real `ssh -L` running), mark the row
`active: false, origin: 'ssh-config'` and **do not retry it** — that is
exactly the Python's read-only view, arrived at honestly.

`RemoteForward` entries exist on `HostEntry` too and can be established the
same way through the already-working `-R` path (`Forwarder.ts:137-164`).

---

## 8. Reconnect

### CLI path — `forwarder.py:1082-1143`

`_is_connected()` (`:1082-1091`): transport non-null and active, then a
`transport.send_ignore()` probe. Checked once per loop iteration, before each
scan (`:1167`).

`_reconnect()` (`:1110-1143`): close the client, `_clear_stale_state()`, then
backoff **5 → 10 → 20 → 40 → 60s (capped)**, `delay = min(delay*2, 60)`
(`:1141`), sleeping in 1-second increments so `Ctrl+C` stays responsive
(`:1128-1131`). **Retries forever** while `self.running`.

`_clear_stale_state()` (`:1093-1108`) stops every tunnel and clears `tunnels`,
`local_port_map`, `process_names`, `process_pids`, `process_working_dirs`,
`manual_tunnels`, `failed_ports`, `all_remote_ports` — and explicitly
**keeps `port_remappings` and `port_names`** (`:1108`). So across a reconnect:
names and remaps survive; manual toggles and failed-port memory do not; every
tunnel is rebuilt from scratch by the next scan, and a mirrored port can land
on a *different* local port if something else grabbed it meanwhile.

### TUI path — `dashboard.py:983-1038`

Different, and inconsistent with the CLI: `_start_reconnect` →
`_reconnect_countdown(5)` ticks once per second showing
`"Connection lost\n\nReconnecting in N..."` (`:408-411`), then
`"Reconnecting..."` and a background reconnect thread. On failure it restarts
the countdown at **5 again — flat, no backoff** (`:1036-1038`), hammering a
down host every ~5s forever.

### What Node has

`AutoForwarderSupervisor.ts` implements the Android FSM: 5s→60s exponential,
`MAX_ATTEMPTS = 10` then state `lost`. But it is **not wired to anything** —
`ForwardService.ts:13-15` says the supervisor is "deferred to Phase 3.5", and
nothing constructs it. Worse, `connectAndRun` (`:91-111`) calls
`this.ssh.connect(this.connectOpts)` — **it opens its own second connection**,
which is exactly what the single-connection decision rules out.

### Recommendation

**Delete `AutoForwarderSupervisor.ts`, or reduce it to a pure backoff-timer
helper.** The app already owns connection lifecycle: `SshService` emits
`onCloseConnection(connectionId, reason)` with `reason: 'user' | 'lost'`
(`SshService.ts:91-94`, fired from `'error'`/`'close'` at `:132-133`).

`ForwardService` should:

```ts
constructor(ssh: SshService, registry: ConnectionRegistry) {
  ssh.onCloseConnection((id, reason) => {
    const fwd = this.forwarders.get(id);
    if (!fwd) return;
    fwd.suspend();            // stop listeners + timer, KEEP intents/remaps/names
    if (reason === 'lost') this.emitState(id, 'reconnecting');
    else this.evict(id);
  });
}
```

and, when the app re-establishes the connection (new `connectionId`), rebuild
the forwarder seeded from persisted state. Concretely, mirror
`_clear_stale_state`'s split:

| Survives a reconnect | Dropped |
|---|---|
| friendly names, remaps, `force-on`/`force-off` intents | live `Forwarder` objects, byte counters, failed-port memory, PID/cwd cache |

The countdown belongs in the renderer — main emits
`{ state: 'reconnecting', retryAtEpochMs }` and the panel renders the ticking
number. Do not port `ReconnectOverlay` (TUI widget) or the dashboard's flat
5s retry (a bug); keep the CLI's exponential 5→60s, and prefer the
supervisor's cap-then-give-up over the Python's infinite retry so a dead host
does not spin forever.

---

## 9. Persistence

### What the Python persists

**Exactly one thing:** `~/.ssh-auto-forward/port-names.json` (§5). Nothing
else outlives the process — remaps, manual toggles, failed ports, and the
auto-forward on/off state are all in-memory, per run.

### Recommendation — `electron-store` schema

`electron-store@10.0.1` is in `package.json:27` and used nowhere in `src/`.
Add a single namespaced store (suggested new file
`src/main/portfwd/PortfwdStore.ts`):

```ts
/** All port-forward state that outlives a run, keyed by host. */
export interface PortfwdState {
  /** Friendly names. Port keys are decimal strings (JSON object keys). */
  names: Record<string, string>;          // "8080" -> "admin UI"
  /** User-chosen local ports. Python keeps these only in memory. */
  remaps: Record<string, number>;         // "19840" -> 3000
  /** Ports the user explicitly forced on (above maxAutoPort) or off. */
  forceOn: number[];
  forceOff: number[];
  /** Whether auto-forward was left running for this host. */
  autoEnabled: boolean;
}

export interface PortfwdSchema {
  /** hostKey -> state. hostKey = ssh-config alias, else `user@host:port`. */
  hosts: Record<string, PortfwdState>;
  /** Schema version so a later shape change can migrate rather than guess. */
  version: 1;
}

const store = new Store<PortfwdSchema>({
  name: 'portfwd',
  defaults: { hosts: {}, version: 1 },
});
```

Rules ported from `_load_port_names` / `_save_port_names`
(`forwarder.py:30-56`, `:999-1006`):

- Corrupt or non-object data → treat as empty, never throw (`:44-46`).
- Drop non-numeric port keys and empty names on read (`:40-42`, `:538-542`).
- Setting an empty name **deletes** the entry (`:988-991`); a host whose
  state becomes fully empty is removed from `hosts` (`:1005`).
- Read-modify-write the whole document on save so two windows on different
  hosts don't clobber each other (`:1001`). `electron-store` reads from disk
  per `get`, so this is the default behaviour — just don't cache the document.

---

## 10. Parsers need real captured output, not assumed formats

`docs/ANALYSIS.md:73-118` records that the helper contract this project
assumed drifted badly from reality (`--json` flags that don't exist, envelopes
where arrays were expected, padding rules that break naive column slicing).
The same hazard applies here, and the Python contains a live example of it:

> `ss -tlnp 2>/dev/null | awk 'NR>1 {print $4, $7}'` (`forwarder.py:784`)

`ss -tlnp` emits six columns —
`State Recv-Q Send-Q Local:Port Peer:Port users:(("name",pid=N,fd=M))` — so
the process blob is **`$6`, not `$7`**. With `$7` empty, awk prints
`"addr "`, the Python's `len(parts) >= 2` check fails (`:803`), the dict comes
back empty, and the code silently falls through to `netstat -tlnp`. On a host
with `iproute2` but no `net-tools` (most modern minimal images), that means no
process names, no PIDs, and therefore **no working-folder column at all** —
the feature quietly degrades to the `ss -tln` fallback. The Docker fixture
(`docker/Dockerfile`) installs *both* `iproute2` and `net-tools` and runs as
root, so no test ever catches it.

**Do not port the awk trick.** `PortScanner.ts` already parses whole lines and
takes `tokens.slice(5)` for the process blob (`PortScanner.ts:34-36`), which
is the correct column. Keep that.

Before touching any of these parsers:

1. Capture real `ss -tln`, `ss -tlnp`, `netstat -tln`, `netstat -tlnp`, and
   `readlink /proc/*/cwd` output from at least (a) the project's Docker sshd
   fixture as root, (b) a real host as a non-root user, and check them in as
   fixture files.
2. Assert the parsers against those bytes, including the header variants
   (`State`/`Netid` for `ss`, `Proto`/`Active Internet connections` for
   `netstat`), IPv6 `[::]:PORT`, `*:PORT`, and the non-root `ss -tlnp` case
   where rows are **missing entirely** rather than blank.
3. Only then wire the merge policy.

---

## 11. Deliberately not ported

| Python behaviour | Why not |
|---|---|
| Textual TUI: `DashboardApp`, `TunnelDataTable`, `LogPanel`, `InputScreen`, `ReconnectOverlay`, key bindings `X/O/N/M/R/L/Q` (`dashboard.py:696-1180`) | The app has a real UI. The *actions* (name, remap, toggle, open URL) port; the widgets and keymap do not. |
| `HostSelectorScreen` / `HostSelectorApp` / `run_host_selector` (`dashboard.py:510-694`, `:1247-1267`) | PocketShell already has a host picker with a real config parser. |
| Hiding hosts that have `LocalForward` from the picker, plus the "▶ Show hosts with local forwards" toggle row (`forwarder.py:358-503`) | An artifact of the tool's single-purpose framing. Hiding a host from the desktop's picker because it has a forward directive would be actively wrong. |
| `_find_ssh_config`, `_load_ssh_config`, `_host_matches`, `get_ssh_hosts*` (`forwarder.py:340-503`, `:557-641`) | `SshConfigParser.ts` is a better parser (Include, globs, multi-name Host lines, IPv6, RemoteForward). The Python's `break`-on-second-match loop (`:589-590`) mis-handles multiple matching blocks. |
| All paramiko connection management: `connect`, `_load_keys`, `_get_agent_keys`, `_find_identity_keys`, `AutoAddPolicy` (`forwarder.py:643-752`) | The app owns one authenticated connection with real known_hosts/TOFU. `AutoAddPolicy` (`:707`) accepts any host key — never bring that in. |
| `_update_terminal_title` ANSI escape (`forwarder.py:1072-1080`) | Writes `\033]0;…\007` to stdout. Meaningless in Electron; in a packaged app it would corrupt whatever is reading stdout. |
| `LogHandler` + `_log_buffer` (`dashboard.py:85-102`) | Logging plumbing for a TUI that hijacks stdout. |
| `--include-configs` / `include_config_ports` (`cli.py:71-75`) | Dead — threaded through and never read. |
| `-p/--port-range` as specified | Dead — see §4. Port the *concept* (a bounded sweep range), not the flag's advertised meaning. |
| `ssh_auto_forward/pipe.py` (`bidirectional_pipe`) | Dead module: nothing in `ssh_auto_forward/` imports it; only `tests/test_pipe.py` does. The live implementation is `SSHTunnel._pipe` (`forwarder.py:168-301`). |
| `SSHTunnel._pipe`'s thread choreography, `SO_LINGER`, half-close, `SSH_FORWARD_IDLE_TIMEOUT` (`forwarder.py:168-301`) | This is Python solving a Python problem: blocking sockets + GIL + two threads per connection. Node's `socket.pipe(channel)` (`Forwarder.ts:208-209`) gets half-close and backpressure from the stream layer for free. **But** see §12 — the *idle-timeout* idea is worth keeping. |

---

## 12. Where the Node implementation is already better — do not regress

1. **Scan strategy order.** `scanRemotePorts.ts:15-19` gets right what the
   Python gets wrong: `ss -tlnp` as non-root *drops* rows it cannot attribute,
   so the full list must come from `ss -tln` and process names are an
   enrichment. Keep it.
2. **`-R` and `-D`.** `Forwarder.ts` implements remote forwards via
   `forwardIn` (`:137-164`) and a SOCKS5 dynamic forward (`:229-279`). Neither
   Python nor Android has these (`ANALYSIS.md:182`, `:290`). Nothing in this
   spec may drop them.
3. **Manual forwards survive a port disappearing** (`AutoForwarder.ts:138`).
   The Python kills them (§6).
4. **Streams instead of threads.** No 2 threads + 2 timeouts + an
   `error_queue` per connection.
5. **`SshConfigParser`** handles `Include`, globs, multi-name `Host` lines,
   IPv6, and `RemoteForward` (§7).
6. **One connection.** The Python opens one paramiko client per host *and*
   `AutoForwarderSupervisor` would open a second one here. Neither is
   acceptable; `Forwarder` resolving its client from the registry per
   operation (`Forwarder.ts:184-186`) is the right shape.

Two things from the Python that Node dropped and probably should not have:

- **The idle-connection reaper.** `SSH_FORWARD_IDLE_TIMEOUT`, default 3600s,
  `0` disables (`forwarder.py:26`, `:201-203`, `:246-247`): a forwarded
  connection silent in *both* directions for an hour is torn down, so an
  abandoned keep-alive socket cannot leak a channel forever. Node's
  `Forwarder` has no such reaper. Worth adding as
  `idleTimeoutMs: 3_600_000` with the same both-directions-silent rule.
- **Byte counters that distinguish direction.** `Forwarder.ts:210-216`
  increments `bytesIn` from the **local socket** and `bytesOut` from the
  channel — i.e. `bytesIn` is upload and `bytesOut` is download, the opposite
  of the Python's `bytes_sent`/`bytes_received` (`forwarder.py:96-97`) and of
  what the column headers "In"/"Out" in `PortPanelView.vue:98` imply. Fix the
  naming while you are in there. Also port `get_stats()`'s rate calculation
  (`forwarder.py:303-326`): deltas since the previous snapshot divided by
  elapsed monotonic time, which is what makes the dashboard's live speed
  column possible.

---

## 13. Diff-ready summary by file

### `src/main/portfwd/PortScanner.ts`
- `RemotePort` gains `pid: number | null` and `cwd: string | null` (§3).
- Export `parseProcessInfo(blob)` — port of `forwarder.py:59-78`; unit-test
  against `users:(("python",pid=12345,fd=7))` and `12345/node`.
- Parse PIDs in `parseSsTlnp` / `parseNetstatTlnp`; carry them through
  `dedupe` (which today discards everything but `process`).
- Add fixture-backed tests before changing anything (§10).

### `src/main/portfwd/scanRemotePorts.ts`
- One sentinel-delimited exec for all listener commands (§1).
- Second exec for `/proc/<pid>/cwd`, PIDs filtered to integers (§3).
- Return `RemotePort[]` with `process`, `pid`, `cwd` populated.

### `src/main/portfwd/AutoForwarder.ts`
- `AutoForwardConfig`: `scanIntervalSec` 10→5, add `skipPorts`,
  `failedPortTtlMs`, `missingScansBeforeStop`; `localPortRange` → `[3000, 65535]` (§2, §4).
- `if (ports.length === 0) return;` — the empty-scan guard (§6). **Highest value single line in this document.**
- Single-flight guard on the scan (§1).
- `missing: Map<number, number>` debounce before teardown (§6).
- Replace the `manual: Set<number>` with `intents: Map<number, 'force-on'|'force-off'>` (§6).
- `findAvailableLocalPort` with `+1…+999` then sweep, and a real
  `SO_REUSEADDR` bind probe (§4).
- `failedPorts: Map<number, number>` with TTL (§2).
- Accept `configForwards: ForwardSpec[]`; exclude and surface them (§7).
- Never `throw` from inside the interval callback (`:164` today).

### `src/main/portfwd/Forwarder.ts`
- `ForwardState` gains `key`, `origin: 'auto'|'manual'|'ssh-config'`,
  `name: string | null`, `process`, `cwd`, `remapped: boolean`,
  `rateIn`/`rateOut` (§3, §12). Export one `forwardKey(spec)` helper — the key
  string is currently rebuilt independently in `AutoForwarder.ts:120`, `:176`
  and `PortPanelView.vue:48-50`, which is a divergence waiting to happen.
- Optional idle reaper, default 1h (§12).
- Fix the `bytesIn`/`bytesOut` direction naming (§12).

### `src/main/portfwd/PortfwdStore.ts` (new)
- `electron-store` wrapper implementing the §9 schema, plus
  `hostKeyFor(rec: ConnectionRecord): string`.

### `src/main/portfwd/ForwardService.ts`
- Own the store; seed each `AutoForwarder` with that host's names, remaps and
  intents; write back on change.
- Subscribe to `ssh.onCloseConnection` for suspend/evict (§8).
- New IPC verbs: `setName`, `setRemap`, `clearRemap`, `setIntent`, and a
  `discovered` list (ports seen but not forwarded, including above
  `maxAutoPort`) so the panel can show and toggle them.

### `src/main/portfwd/AutoForwarderSupervisor.ts`
- Delete, or strip to a pure backoff-timer utility. It must not call
  `ssh.connect` (§8).

### Not this document's files
- `src/main/ssh/SshService.ts` + `src/main/ipc.ts`: add an optional
  `hostAlias` to connect options so per-host persistence can key on the SSH
  config alias like the Python does (§5). *Owned by another agent.*
- `src/renderer/views/PortPanelView.vue`: name/remap/toggle affordances, the
  discovered-ports rows, `Process`/`Folder` columns, the "Auto (SSH Config)"
  status, and the reconnect countdown. *Owned by another agent.*

---

## 14. If only three things get done

1. **The empty-scan guard + teardown debounce** (§6) —
   `if (ports.length === 0) return;` plus `missingScansBeforeStop`. Today one
   failed scan silently kills every live tunnel mid-transfer. It is one line
   plus a counter, and it is the difference between the feature being
   trustworthy and being a liability.
2. **Real local-port allocation** (§4) — the `+1…+999` fallback and the
   `SO_REUSEADDR` bind probe. Without it, any port collision is a permanent
   silent no-op that retries identically forever. This is the single most
   visible behaviour of the Python tool
   (`✓ Forwarding remote port 19840 -> local port 3000`).
3. **Persistence + friendly names + remaps** (§5, §9) — the `electron-store`
   schema and the name/remap plumbing. It is the feature the user built and
   kept, it survives restarts (which the Python's remaps do *not*), and it is
   what makes a wall of anonymous port numbers usable.

Next after those: process/folder attribution (§3), then the SSH-config
forwards (§7), then the reconnect rework (§8).

---

## 15. Bugs and sharp edges found while reading

**In `ssh-auto-forward` (Python):**

1. `ss -tlnp … awk '{print $4, $7}'` reads the wrong column; the `ss` path
   silently never produces process info (`forwarder.py:784`). §10.
2. `failed_ports` never expires — one transient bind failure blacklists a port
   for the life of the process (`forwarder.py:931-933` vs `:983`). §2.
3. `-p/--port-range` is parsed, stored, and never used; the sweep is hardcoded
   `range(3000, 65535)` (`forwarder.py:533` vs `:894`). §4.
4. `--include-configs` is threaded through three layers and never read
   (`cli.py:74` → `dashboard.py:111`). §7.
5. The dashboard's refresh timer is hardcoded to 5s and ignores `--interval`
   (`dashboard.py:791`, `:857` vs `cli.py:42`).
6. The dashboard's reconnect has **no backoff** — flat 5s forever
   (`dashboard.py:1036-1038`) — while the CLI has 5→60s exponential
   (`forwarder.py:1141`). Two different behaviours for the same failure.
7. `scan_and_forward` tears down **manual** tunnels when their port stops
   listening, ignoring `manual_tunnels` (`forwarder.py:1055-1062`).
8. `port_remappings` are documented as "persistent" (`forwarder.py:1009`) but
   only survive reconnects, never a restart.
9. `_load_ssh_config` breaks out of the parse loop at the *second* `Host` line
   after a match (`:589-590`), so a later, more specific block for the same
   alias is never seen; and its wildcard→regex conversion is unanchored, so
   `Host dev` would regex-match `dev-prod` in `_load_ssh_config`'s inline
   `re.match` path (`:594`) even though `_host_matches` (`:630-641`) demands
   an exact match for literals. Two different matching rules in one class.
10. `pipe.py` is dead code with a 214-line test file behind it
    (`tests/test_pipe.py`), giving false coverage confidence.
11. `SSHTunnel` counts bytes from non-atomic `+=` across two threads — the
    displayed totals can drift under load (`forwarder.py:227`, `:259`).

**In `pocketshell-electron` (Node):**

1. **A failed scan tears down every forward** — `scanRemotePorts` returns `[]`
   on exec failure and `scanAndForward` treats that as "nothing is listening"
   (`scanRemotePorts.ts:38` → `AutoForwarder.ts:133-141`). §6.
2. `allocateLocalPort` **throws** when `3000..3999` is exhausted
   (`AutoForwarder.ts:164`), inside `void this.scanAndForward()` — an
   unhandled promise rejection that kills the scan loop.
3. `togglePort` cannot turn *off* a port the auto policy forwards
   (`AutoForwarder.ts:99-107`). §6.
4. A `Forwarder.start()` that returns `false` is discarded silently
   (`AutoForwarder.ts:131`) with no user-visible error and no backoff.
5. `AutoForwarderSupervisor` opens a second SSH connection
   (`AutoForwarderSupervisor.ts:94`) — contradicts the single-connection
   decision. It is also unreferenced, so this is latent, not live.
6. `Forwarder.onRemoteConnection` (`Forwarder.ts:166-181`) accepts every
   inbound `-R` channel and just counts bytes into `bytesIn`, never piping to
   a local destination — so `-R` is byte-count-only today. It also registers a
   `client.on('tcp')` handler **per remote forward** on the shared client, so
   N remote forwards means every inbound channel is handled N times.
7. `bytesIn`/`bytesOut` are swapped relative to their column labels
   (`Forwarder.ts:210-216` vs `PortPanelView.vue:98`). §12.
8. The forward key is constructed in three places with two different formats —
   `AutoForwarder.ts:120` (`local:${localPort}->${rp.port}`, no host) vs
   `AutoForwarder.ts:176` and `PortPanelView.vue:48-50`
   (`${kind}:${listenPort}->${destHost}:${destPort}`). An auto-created forward
   therefore **cannot be removed from the UI** — the renderer computes a key
   the map does not contain. Fixing this is nearly free and is a real,
   user-visible bug.
9. `PortPanelView.vue` fetches `remotePorts` into the store and never renders
   them, so discovered-but-unforwarded ports are invisible
   (`forwards.ts:33`, `PortPanelView.vue:101`).

---

## 16. Seeing that it is on from the outside

> "if auto-forward is on I want to see an indicator e.g. in the panel with
> icons — like a border around it or something like that"

The panel with icons is the session header's strip, and the glyph that stands
for this feature is the Ports button (`arrow-right-left`). While the engine
runs for the connected host, that button now carries the state on its face:
the fill tints `--accent-soft`, a 1px ring in `--accent-dim` goes around it,
the glyph recolours `--accent`, and a 5px dot with a soft glow sits in the
corner (`HostPanelButtons.vue`). The register is not new — it is the same
three tokens the panel's own `Auto-forward: ON` toggle words the state with
(`.toggle.on`, PortPanelView.vue) — so "on" reads the same way in both places.
The dot is the half the ring cannot say: a ring alone could be read as
"selected"; a glowing dot says "running".

Both surfaces that render the buttons — the session header and the collapsed
rail — mark identically, because they always rendered from one component and
the indicator is just one more prop. The tooltip grows a suffix while the
indicator is up ("Port forwarding — auto-forward on"), which matters more than
it looks: the `title` is the button's entire accessible name, so the word must
keep travelling with the mark (§5.3e's rule, applied to state as well as
identity). The ring is an inset box-shadow rather than a border so the glyph
does not shift half a pixel inside the fixed square when the state flips.

### Where the state lives, and why it is not the store's `autoOn`

The forwards store's `autoOn` is the flag the ports panel itself renders — and
it is only fresh while that panel is MOUNTED: `PortPanelView` subscribes on
entry and the store `clear()`s on unmount (`stores/forwards.ts`). An indicator
read off it would say OFF almost all of the time, which is the opposite of an
indicator. So the workspace owns the value (`HostWorkspaceView.vue`):

- whenever the connection or the ports overlay changes, it asks the engine
  directly — `forwards.isAutoEnabled`, which answers "forwarder running, else
  the persisted per-host flag" (`ForwardService.ts:108`) — so the mount case
  ("relaunch on a host where I left it on, never opened the panel") is covered
  by one IPC read;
- while the overlay IS open, the store's live flips are mirrored straight
  through, so the toggle inside the panel reaches the header button without
  waiting for a reopen.

A late answer for a connection that has since been replaced is dropped rather
than written — reconnect mints a new id, and the old flag is about a dead
link. Tested in `tests/unit/autoForwardIndicator.test.ts` (mount, plain-OFF,
reconnect, live mirror) and `tests/unit/SessionTree.test.ts` (the relay, and
that Usage — the sibling button — is never marked).

---

## 17. One-click open in the browser

> "for port forwarding I want to open the port in the browser with one click —
> like I do it with ssh-auto-forward or in the Android app"

A forwarded port is a URL, and the commonest thing to do with a URL is look at
it. The actions column now opens it: every row with a live LOCAL tunnel has an
`external-link` button first in the cell, which opens
`http://127.0.0.1:<listenPort>/` in the system browser
(`PortPanelView.vue`, `localUrlOf`/`openLocal`).

Where the button appears is the whole design, because a forwarded port is only
a URL when a local tunnel for it exists:

- **A live local forward gets it, at the tunnel's LISTEN port** — not the
  remote port. They differ whenever a pin or an allocation moved the local
  end (`remap`), and a URL naming the remote port would reach whatever else
  happens to sit there.
- **A `-R` forward does not.** Its listener is on the HOST; a browser on this
  machine reaches nothing there.
- **A discovered-but-not-forwarded port does not.** There is no tunnel, and a
  button that opens an error page teaches the user it lies.
- **The served row keeps its own open** — it has been this feature for one
  special row since SERVE landed, its URL carries the trailing slash the
  directory index needs, and "stop" is the other half of that pair. It does
  not get a second button.

Two consistency decisions ride along. The served row's open mark was
`arrow-right` while the new one is Feather's `external-link` — two glyphs for
one action in one column was drift, so both now carry `external-link`
(AppIcon.vue). And the URL host is the loopback unless the forward bound a
specific interface on purpose (`listenHost` passed through verbatim); a
listen host of "any" (`0.0.0.0`, `::`, empty) maps to `127.0.0.1` rather than
putting `0.0.0.0` in an address bar. `serveUrl` (serveCommand.ts) words the
same URL for served folders.

The open itself is `window.open(url, '_blank', 'noopener,noreferrer')` — not
an IPC verb — because main's `setWindowOpenHandler` already allow-lists
http(s) into `shell.openExternal` (index.ts), and that is the route every
other in-app link takes. The tooltip names the exact URL, which is the one
fact the click needs to be predictable.

Tests: `tests/unit/portPanelOpen.test.ts` — the URL at the listen port, the
verbatim interface host, the wide-host mapping, no button on `-R`, none on
unforwarded, and the served row keeping its single open.
