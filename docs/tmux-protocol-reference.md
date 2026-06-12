# tmux -CC Control Mode Protocol Reference

This document is derived from the PocketShell Android implementation
(`shared/core-tmux/`). It is the authoritative spec for the TypeScript port
to PocketShell Desktop.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Protocol Messages](#2-protocol-messages)
3. [Escape Decoding](#3-escape-decoding-output-data)
4. [DCS Passthrough Wrapping](#4-dcs-passthrough-wrapping)
5. [State Model](#5-state-model)
6. [Parser Architecture](#6-parser-architecture)
7. [Response Block Framing](#7-response-block-framing)
8. [Command Flow](#8-command-flow)
9. [Per-Pane Output Demux](#9-per-pane-output-demux)
10. [Connection Lifecycle](#10-connection-lifecycle)
11. [Error Handling and Edge Cases](#11-error-handling-and-edge-cases)
12. [Command Reference](#12-command-reference-tmux-commands-used)

---

## 1. Overview

tmux's control mode (`tmux -CC`) is a line-oriented, full-duplex protocol
carried over a single stdio pair (the SSH shell). It provides:

- **Structured notifications** (`%session-changed`, `%output`, `%window-add`,
  etc.) -- tmux pushes these asynchronously as state changes.
- **Command-response blocks** (`%begin` / `%end` / `%error`) -- every command
  the client writes to stdin produces exactly one block, correlated by a
  monotonically increasing command number.

Key constraints:

- **One outstanding command at a time.** tmux serializes command processing.
  The client must queue commands locally.
- **Byte-oriented `%output`.** tmux emits raw high UTF-8 bytes inside `%output`
  data under a UTF-8 locale. It does NOT octal-escape them. Multi-byte
  characters can be split across consecutive `%output` events. The parser must
  operate on raw bytes to avoid U+FFFD corruption.
- **ID prefixes are part of the value.** Session IDs carry `$` (e.g. `$0`),
  window IDs carry `@` (e.g. `@3`), pane IDs carry `%` (e.g. `%12`). These
  prefixes are preserved in string fields so callers can pass them straight
  back to tmux commands without rebuilding syntax.

### Source Files (Android)

| File | Role |
|------|------|
| `ControlEvent.kt` | Sealed interface with all event type definitions |
| `ControlModeParser.kt` | Stateless line-oriented parser + escape decoder |
| `ControlEventStream.kt` | Stateful `%begin`/`%end` framing over a `Flow<ByteArray>` |
| `TmuxClient.kt` | High-level client: connect, sendCommand, outputFor, lifecycle |
| `CommandResponse.kt` | Data classes for command results |
| `TmuxClientFactory.kt` | Factory constructing `TmuxClient` instances |

---

## 2. Protocol Messages

Every line in the control-mode stream is one of:

1. A **notification** starting with `%` -- parsed into a `ControlEvent`.
2. A **response payload line** -- any text between `%begin` and
   `%end`/`%error`, not starting with `%` in general (but payload CAN contain
   `%`-prefixed lines; see framing rules).
3. **Garbage** -- lines without a `%` prefix outside response blocks are
   ignored.

### 2.1 `%output` -- Pane Output

**Wire format:**
```
%output %<paneId> <data>
```

- `paneId` is `%N` (e.g. `%0`, `%12`), including the leading `%`.
- `<data>` is the raw bytes written to the pane's tty, with non-printable
  bytes octal-escaped (`\NNN`) and backslashes doubled (`\\`). High UTF-8
  bytes (>= 0x80) are passed through as-is under a UTF-8 locale.
- `<data>` can be empty (`%output %0 ` with trailing space and no data).

**Parsed into:**
```kotlin
data class Output(paneId: String, data: ByteArray) : ControlEvent
```

**Examples from tests:**

| Wire line | paneId | Decoded data (hex) |
|-----------|--------|--------------------|
| `%output %0 hello` | `%0` | `68 65 6c 6c 6f` |
| `%output %123 x` | `%123` | `78` |
| `%output %1 \033[31mred\033[0m` | `%1` | `1b 5b 33 31 6d 72 65 64 1b 5b 30 6d` |
| `%output %0 a\\b` | `%0` | `61 5c 62` |
| `%output %0 ` | `%0` | (empty) |
| `%output %0 ` + raw bytes `D1 8C E2 94 80` | `%0` | `D1 8C E2 94 80` (UTF-8 for `ь─`) |

**Critical: byte-oriented parsing (issue #435).** tmux under a UTF-8 locale
emits raw high UTF-8 bytes inside `%output` and can split a single multi-byte
character across two consecutive `%output` events. The parser MUST slice the
data tail as raw bytes without an intermediate String round-trip. The old
String-based path corrupted orphaned continuation bytes into U+FFFD.

### 2.2 `%session-changed` -- Active Session Changed

**Wire format:**
```
%session-changed $<sessionId> <name>
```

- `sessionId` is `$N` (e.g. `$0`).
- `name` may contain spaces; everything after the first space is the name.

**Parsed into:**
```kotlin
data class SessionChanged(sessionId: String, name: String) : ControlEvent
```

**Examples:**

| Wire line | sessionId | name |
|-----------|-----------|------|
| `%session-changed $0 main` | `$0` | `main` |
| `%session-changed $2 my session` | `$2` | `my session` |

### 2.3 `%sessions-changed` -- Global Session List Changed

**Wire format:**
```
%sessions-changed
```

No payload.

**Parsed into:**
```kotlin
data object SessionsChanged : ControlEvent
```

### 2.4 `%window-add` -- New Window Created

**Wire format:**
```
%window-add @<windowId>
```

- `windowId` is `@N` (e.g. `@0`).
- tmux does NOT include the parent session ID or window name on this
  notification. The consumer must look those up via `list-windows`.

**Parsed into:**
```kotlin
data class WindowAdd(sessionId: String = "", windowId: String, name: String = "")
```

### 2.5 `%window-close` -- Window Closed

**Wire format:**
```
%window-close @<windowId>
```

**Parsed into:**
```kotlin
data class WindowClose(sessionId: String = "", windowId: String)
```

### 2.6 `%window-renamed` -- Window Renamed

**Wire format:**
```
%window-renamed @<windowId> <name>
```

- tmux does not include the session ID on this event.

**Parsed into:**
```kotlin
data class WindowRenamed(sessionId: String = "", windowId: String, name: String)
```

**Example:**
```
%window-renamed @3 build
```
Parsed: `windowId = "@3"`, `name = "build"`.

### 2.7 `%layout-change` -- Window Layout Changed

**Wire format (older tmux):**
```
%layout-change @<windowId> <layout>
```

**Wire format (tmux 2.2+):**
```
%layout-change @<windowId> <layout> <visible-layout> <window-flags>
```

Only the first `<layout>` token is captured; the visible-layout and
window-flags suffixes are dropped (PocketShell renders one pane at a time).

**Parsed into:**
```kotlin
data class LayoutChange(sessionId: String = "", windowId: String, layout: String)
```

**Examples:**

| Wire line | windowId | layout |
|-----------|----------|--------|
| `%layout-change @0 b25d,80x24,0,0,0` | `@0` | `b25d,80x24,0,0,0` |
| `%layout-change @0 b25d,80x24,0,0,0 b25d,80x24,0,0,0 *` | `@0` | `b25d,80x24,0,0,0` |

### 2.8 `%pane-mode-changed` -- Pane Entered/Left Special Mode

**Wire format:**
```
%pane-mode-changed %<paneId>
```

- tmux does not include the new mode value. Callers must query via
  `display-message` if they care.

**Parsed into:**
```kotlin
data class PaneModeChanged(paneId: String)
```

### 2.9 `%begin` / `%end` / `%error` -- Command Response Framing

These three delimiters frame the response to a command the client sent.

**Wire format:**
```
%begin <unix-time> <command-number> <flags>
%end <unix-time> <command-number> <flags>
%error <unix-time> <command-number> <flags>
```

- `<unix-time>` is a Unix timestamp (seconds).
- `<command-number>` is a monotonically increasing integer assigned by tmux.
  Used to correlate responses to requests.
- `<flags>` is an integer (typically `0`).

**Parsed into:**
```kotlin
data class Begin(time: Long, number: Long, flags: Int) : ControlEvent
data class End(time: Long, number: Long, flags: Int) : ControlEvent
data class Error(time: Long, number: Long, flags: Int) : ControlEvent
```

Lines between `%begin` and the matching `%end`/`%error` are **payload** --
they are NOT parsed as events but collected as the command's output text.

**Example response block:**
```
%begin 1700000000 5 0
session 0: 1 windows
session 1: 2 windows
%end 1700000000 5 0
```

The two middle lines are the response payload for command number 5.

### 2.10 `%client-detached` -- Client Detached

**Wire format (tmux < 3.2):**
```
%client-detached
```

**Wire format (tmux >= 3.2):**
```
%client-detached <clientName>
```

The client name is intentionally not captured -- PocketShell is always the
only control-mode client.

**Parsed into:**
```kotlin
data object ClientDetached : ControlEvent
```

### 2.11 `%exit` -- Server Shutting Down

**Wire format:**
```
%exit
%exit <reason>
```

- `reason` is optional human-readable text (e.g. `server exited`).
- After `%exit`, the control-mode channel will close.

**Parsed into:**
```kotlin
data class Exit(reason: String?) : ControlEvent
```

**Examples:**

| Wire line | reason |
|-----------|--------|
| `%exit` | `null` |
| `%exit server exited` | `"server exited"` |
| `%exit ` | `null` (trailing space, empty args) |

---

## 3. Escape Decoding (Output Data)

tmux's control-mode emitter (`control.c::control_write_output`) escapes
non-printable bytes in `%output` data. The decoder handles:

| Escape form | Description | Example |
|-------------|-------------|---------|
| `\NNN` | 3-digit octal (tmux's primary form) | `\033` = ESC (0x1B) |
| `\xNN` | 2-digit hex (legacy iTerm2 form) | `\x1b` = ESC (0x1B) |
| `\\` | Literal backslash | `\\` = `\` |
| `\n` | LF (tolerated, not emitted by stock tmux) | |
| `\r` | CR (tolerated) | |
| `\t` | TAB (tolerated) | |
| High bytes (>= 0x80) | Passed through verbatim | Raw UTF-8 |
| Unknown `\X` | Backslash passed through literally, `X` processed next | `\q` = `\q` |

### Fast path

If no backslash exists in the data slice, the entire slice is returned as-is
(no copy overhead). This is the common case when tmux emits raw UTF-8 text
without control sequences.

### Decoder pseudocode (from `decodeOutputData`)

```kotlin
fun decodeOutputData(escaped: ByteArray, start: Int, end: Int): ByteArray {
    // Fast path: scan for any backslash
    var i = start
    while (i < end) { if (escaped[i] == BACKSLASH) break; i++ }
    if (i == end) return escaped.copyOfRange(start, end)  // identity

    val out = ByteArrayOutputStream(end - start)
    i = start
    while (i < end) {
        val c = escaped[i]
        if (c != BACKSLASH || i + 1 >= end) {
            out.write(c); i++; continue
        }
        val next = escaped[i + 1]
        when {
            // \NNN -- 3-digit octal
            next.isOctalDigit() && i + 3 < end
                && escaped[i+2].isOctalDigit() && escaped[i+3].isOctalDigit() -> {
                val value = (next.octal() shl 6) or (escaped[i+2].octal() shl 3) or escaped[i+3].octal()
                out.write(value and 0xff); i += 4
            }
            // \xNN -- 2-digit hex
            next == 'x' && i + 3 < end
                && escaped[i+2].isHexDigit() && escaped[i+3].isHexDigit() -> {
                val value = (escaped[i+2].hex() shl 4) or escaped[i+3].hex()
                out.write(value and 0xff); i += 4
            }
            next == 'n' -> { out.write('\n'); i += 2 }
            next == 'r' -> { out.write('\r'); i += 2 }
            next == 't' -> { out.write('\t'); i += 2 }
            next == BACKSLASH -> { out.write('\\'); i += 2 }
            else -> { out.write('\\'); i++ }  // pass backslash through, process next char
        }
    }
    return out.toByteArray()
}
```

---

## 4. DCS Passthrough Wrapping

Some terminal multiplexers or transport layers wrap tmux control-mode lines in
a DCS (Device Control String) passthrough:

```
ESC P <params> %<event> ... ESC \
```

The parser strips this transparently via `normalizeControlLine()`:

1. If the line starts with `ESC P` (`0x1b 0x50`), skip forward to the first
   `%` byte.
2. If the line ends with `ESC \` (`0x1b 0x5c`), trim those two bytes.

Both the byte-oriented and String-oriented normalizers exist. The byte version
is used on the critical `%output` path; the String version on response payload
lines.

**Examples from tests:**
```
P1000p%begin 1234567890 1 0     ->  %begin 1234567890 1 0
P1000p%output %0 hello\   ->  %output %0 hello
```

---

## 5. State Model

### 5.1 Entity Hierarchy

```
tmux server
  +-- session ($N)
  |     +-- window (@N)
  |           +-- pane (%N)
```

**ID conventions:**
- Sessions: `$0`, `$1`, ... (string with `$` prefix)
- Windows: `@0`, `@1`, ... (string with `@` prefix)
- Panes: `%0`, `%1`, ... (string with `%` prefix)

These IDs are stable for the lifetime of their entity and are used as opaque
identifiers throughout the protocol.

### 5.2 ControlEvent Types

```typescript
// TypeScript port type definitions

type ControlEvent =
  | { type: "output"; paneId: string; data: Uint8Array }
  | { type: "session-changed"; sessionId: string; name: string }
  | { type: "sessions-changed" }
  | { type: "window-add"; sessionId: string; windowId: string; name: string }
  | { type: "window-close"; sessionId: string; windowId: string }
  | { type: "window-renamed"; sessionId: string; windowId: string; name: string }
  | { type: "layout-change"; sessionId: string; windowId: string; layout: string }
  | { type: "pane-mode-changed"; paneId: string }
  | { type: "begin"; time: number; number: number; flags: number }
  | { type: "end"; time: number; number: number; flags: number }
  | { type: "error"; time: number; number: number; flags: number }
  | { type: "client-detached" }
  | { type: "exit"; reason: string | null }
```

### 5.3 Command Response

```typescript
interface CommandResponse {
  number: number;    // tmux-assigned command number from %begin
  output: string[];  // payload lines between %begin and %end/%error
  isError: boolean;  // true if closed by %error rather than %end
}

interface CaptureWithCursor {
  capture: CommandResponse;
  cursorReply: string | null;  // "cursor_x,cursor_y" or null
}
```

### 5.4 Pane State (App-Level)

```typescript
interface TmuxPaneState {
  paneId: string;         // e.g. "%0"
  windowId: string;       // e.g. "@0"
  windowIndex: number | null;
  sessionId: string;      // e.g. "$0"
  title: string;
  cwd: string;
  currentCommand: string;
  paneTty: string;        // e.g. "/dev/pts/3"
  inCopyMode: boolean;
  surfaceError: boolean;  // local terminal failure flag
}
```

### 5.5 Disconnect State

```typescript
enum TmuxDisconnectReason {
  ExplicitClose = "explicit_close",
  ExplicitDetach = "explicit_detach",
  ReaderEof = "reader_eof",
  ReaderException = "reader_exception",
  CommandTimeout = "command_timeout",
  Unknown = "unknown",
}

interface TmuxDisconnectEvent {
  reason: TmuxDisconnectReason;
  source: string;           // "eof", "read_failure", "local"
  intent: string;           // "local_close", "detach_or_replace", "command_timeout", "unknown"
  commandKind?: string;     // e.g. "kill-pane"
  timeoutMode?: string;     // "fatal", "best-effort", "fail-open"
  exceptionClass?: string;  // e.g. "IOException"
  message?: string;
}
```

---

## 6. Parser Architecture

### 6.1 ControlModeParser (Stateless)

The parser is **pure and stateless**. Each call to `parse(line)` is independent.
State tracking for response-block framing lives in `ControlEventStream`.

```
parse(line: ByteArray): ControlEvent?
  |
  +-- normalizeControlLine(line)        // strip DCS wrapper
  |
  +-- if starts with "%output ":
  |     parseOutput(line)               // byte-oriented fast path
  |       +-- extract paneId (ASCII)
  |       +-- decodeOutputData(tail)    // escape decode on raw bytes
  |       +-- return Output(paneId, data)
  |
  +-- else:
        parseStructured(decodedString)  // String-based for non-output events
          +-- split opcode + args
          +-- dispatch by opcode
          +-- return appropriate ControlEvent or null
```

### 6.2 Byte-Orientated Output Path (Critical)

The `%output` parsing path operates entirely on `ByteArray`:

1. `normalizeControlLine()` strips DCS at byte level.
2. The parser checks for the `%output ` prefix as ASCII bytes.
3. Pane ID extraction uses ASCII decoding (safe -- pane IDs are `%N`).
4. The data tail is sliced as raw bytes and passed to `decodeOutputData()`.
5. `decodeOutputData()` processes octal/hex escapes while preserving high
   bytes verbatim.

This avoids the U+FFFD corruption that occurs when orphaned UTF-8
continuation bytes are decoded to String prematurely.

### 6.3 Structured Event Path

Non-`%output` events carry only ASCII structured fields. The normalized line
is safely decoded to a String for opcode dispatch and field parsing:

1. Split on first space to get opcode and args.
2. `when` dispatch on opcode string.
3. Each handler extracts typed fields from args.

### 6.4 Malformed/Unknown Handling

- Unknown opcodes return `null` (logged at FINE level).
- Malformed events (missing fields, wrong prefix) return `null`.
- Non-`%`-prefixed lines return `null`.
- Empty lines return `null`.
- `null` values are silently filtered by `ControlEventStream`.

---

## 7. Response Block Framing

### 7.1 ControlEventStream (Stateful)

`ControlEventStream` wraps a `Flow<ByteArray>` of raw lines into a structured
`Flow<ControlEvent>`. It tracks a single piece of state:

```
openBlock: Long? = null   // command-number while inside a %begin/%end block
```

### 7.2 State Machine

```
For each line:
  1. normalizeControlLine(line)
  2. if openBlock != null (inside a block):
       a. Parse the line
       b. If it is %end or %error with matching command-number:
            - Set openBlock = null
            - Emit the closing event
       c. Otherwise:
            - This is PAYLOAD, not an event
            - Forward to onResponsePayload(openBlock, decodedString)
            - Do NOT emit
       d. Return (skip step 3)
  3. Outside any block:
       a. Parse the line
       b. If null, skip (unknown/malformed)
       c. If Begin, set openBlock = event.number
       d. Emit the event
```

### 7.3 Critical Rule: Payload Lines Are Opaque

Inside a `%begin`/`%end` block, **every line is payload** except the matching
`%end`/`%error`. This means:

- Payload lines that happen to start with `%` (e.g. `%output %0 fake`) are
  still payload, not events.
- A `%end` with a **different** command-number is treated as payload, not a
  block close.
- Only the `%end`/`%error` with the **same** command-number as the opening
  `%begin` closes the block.

This is verified by test: `payload lines that look like control events are
still treated as payload`.

---

## 8. Command Flow

### 8.1 Spawning tmux -CC

```
1. Open an SSH shell channel
2. Write: tmux -CC new-session -A -s '<sessionName>' [-c '<startDir>']\n
3. Flush
```

- `-A` reattaches to an existing session or creates a new one.
- Session name is single-quote escaped: `'` becomes `'\''`.
- The reader coroutine must be launched BEFORE the spawn write to avoid
  missing tmux's initial notifications.

### 8.2 Attach-Only Preflight (createIfMissing = false)

Before connecting, optionally probe with `tmux has-session -t '<name>'`
via a separate SSH exec channel (NOT the control shell):

- Exit code 0: session exists, proceed with attach.
- Non-zero: session gone, throw `TmuxSessionNotFoundException` without
  creating or writing to the control shell.

### 8.3 Single Command: sendCommand

```
1. Acquire sendMutex (serializes commands)
2. Create PendingCommand(deferred: CompletableDeferred<CommandResponse>)
3. Enqueue in pendingQueue
4. Write command + "\n" to stdin, flush
5. Await deferred (with timeout)
6. On timeout: handle per timeout mode (see section 11)
7. On response: return CommandResponse
```

The reader loop resolves the deferred:
1. On `%begin`: dequeue next PendingCommand, set its commandNumber.
2. On payload lines: append to inflight PendingCommand.output.
3. On `%end`: complete inflight deferred with success CommandResponse.
4. On `%error`: complete inflight deferred with error CommandResponse.

### 8.4 Chained Commands: sendChainedCommands

tmux -CC answers `cmd1 ; cmd2` with N **separate** `%begin`/`%end` blocks
(chaining does NOT collapse them). The implementation:

```
1. Acquire sendMutex (with bounded acquire timeout)
2. Create one PendingCommand per command
3. Enqueue ALL before writing
4. Write "cmd1 ; cmd2\n" once
5. Await each deferred in order:
   - First block: fatal timeout (full commandTimeoutMs)
   - Remaining blocks: best-effort timeout
     - If timed out: remove from queue, increment staleResponseBlocksToIgnore,
       degrade to synthetic error CommandResponse
6. Return one CommandResponse per command in submission order
```

### 8.5 Capture With Cursor: captureWithCursor

Special case of chained commands for the seed path:

```
Wire command: capture-pane -p -e -S -<scrollbackLines> -t <paneId> ;
              display-message -p -t <paneId> '#{cursor_x},#{cursor_y}'
```

Two blocks are drained: the capture block (fatal) and the cursor block
(best-effort, degrades to null cursorReply).

### 8.6 Client Size Reporting

```
refresh-client -C <cols>x<rows>
```

Reports the control client's viewport size to tmux. This is the control-mode
equivalent of a terminal resize.

### 8.7 Window Size Policy

```
set-window-option -t '<sessionId>' window-size latest
```

Chooses tmux's `latest` window-size policy so the control client drives
sizing.

### 8.8 Clean Detach: detachCleanly

```
1. Send "detach-client" (with half-timeout budget)
2. Wait for reader to observe EOF (with remaining budget)
   - tmux responds with %begin/%end then %exit and closes the channel
3. Call close() unconditionally
```

### 8.9 Shell Quoting

Session names and other user-supplied strings in commands are single-quote
escaped:

```kotlin
fun escapeSingleQuoted(input: String): String = input.replace("'", "'\\''")
```

Example: `it's here` becomes `'it'\''s here'`.

---

## 9. Per-Pane Output Demux

### 9.1 Architecture

`%output` events are routed to per-pane output pipes rather than relying on
subscribers filtering the global event bus. This prevents a slow global
subscriber from blocking the control-mode reader.

```
readerLoop
  |
  +-- ControlEvent.Output -> emitOutput(event)
  |     |
  |     +-- paneOutputPipes[paneId]?.send(event)   // per-pane pipe
  |     +-- eventBus.tryEmit(event)                 // best-effort global
  |
  +-- other events -> eventBus.emit(event)          // blocking global
```

### 9.2 PaneOutputPipe

Each pane gets a `PaneOutputPipe` with:
- A bounded `Channel<Output>` (4096 events) as intake buffer.
- A `MutableSharedFlow<Output>` for fan-out to multiple subscribers.
- A coroutine that drains the channel into the flow.
- Overflow handling: when the channel is full, the event is dropped and
  `TmuxOutputBacklogOverflow` is emitted to a separate flow.

### 9.3 outputFor(paneId)

```kotlin
fun outputFor(paneId: String): Flow<ControlEvent.Output>
```

Returns a hot `SharedFlow` for a specific pane. Multiple callers can subscribe
to the same pane. Pipes are created lazily and stored in a `ConcurrentHashMap`.

---

## 10. Connection Lifecycle

### 10.1 State Diagram

```
[constructed] -> connect() -> [connected]
                                    |
                     +--------------+---------------+
                     |              |               |
                  close()     reader EOF      reader exception
                     |              |               |
                     v              v               v
                  [closed]      [disconnected]   [disconnected]
```

### 10.2 Latched Signals

- `disconnected: StateFlow<Boolean>` -- latches to `true` when the reader
  loop exits (EOF, exception, or close). Never flips back.
- `disconnectEvent: StateFlow<TmuxDisconnectEvent?>` -- structured reason
  for the disconnect, with priority-based overwrite.

### 10.3 Disconnect Priority

Higher priority events overwrite lower:
```
Unknown = 0 < ReaderEof = 1 < ReaderException = 2 < ExplicitClose = 3 < ExplicitDetach = 4 < CommandTimeout = 5
```

### 10.4 Reader Exit Classification

```
if readerExitIntent == CommandTimeout -> CommandTimeout
if readerExitIntent == DetachOrReplace -> DetachOrReplace
if closed && readerExitIntent == LocalClose -> LocalClose
if source == "read_failure" -> ReadFailure
if source == "eof" -> ReadEof
if closed -> LocalClose
else -> Unknown
```

---

## 11. Error Handling and Edge Cases

### 11.1 Command Timeout Modes

| Mode | Behavior on timeout |
|------|-------------------|
| `FatalClose` | Close the client, throw TmuxClientException. Used for structural commands (kill-pane, list-sessions). |
| `BestEffortDrain` | Try a 1-second late-drain window. If the late response arrives, still throw but log it. Used for capture-pane, display-message. |
| `FailOpenDrain` | Like BestEffortDrain but also quarantines the stale response block. Used for send-keys, set-window-option, refresh-client. |

`send-keys` uses `FailOpenDrain` by default. All other commands use
`FatalClose`. `sendBestEffortCommand()` uses `BestEffortDrain`.

### 11.2 Stale Response Block Quarantine

When a command times out but its response might still arrive late, the client
increments `staleResponseBlocksToIgnore`. The reader loop checks this counter
when it sees a `%begin`: if the counter is positive, the block is consumed and
discarded instead of being correlated to a pending command.

This prevents a late response from completing the NEXT command's deferred with
the wrong data.

### 11.3 Event Bus Overflow

The global event bus has a buffer capacity of 256 events. If `tryEmit` fails
(the buffer is full), the event is dropped and an overflow diagnostic is
recorded. Per-pane output pipes have a separate 4096-event channel buffer and
emit their own overflow signals.

### 11.4 Write Failures

If the stdin write fails (e.g. SSH channel torn down):
1. Cancel the write job.
2. Close the client.
3. Throw `TmuxClientException` with the write failure cause.

### 11.5 Pending Command Drain on Close

When the reader loop exits (in the `finally` block):
1. Complete the in-flight pending command with an exception.
2. Drain ALL remaining queued pending commands with exceptions.
3. Flip `disconnected` to true.

This ensures no caller blocks forever waiting for a response that will never
arrive.

### 11.6 Malformed Lines

Malformed control-mode lines return `null` from the parser and are silently
skipped by the stream. A FINE-level log is emitted for diagnostics. This
includes:
- Lines with wrong ID prefixes (e.g. `%output 1 data` instead of `%output %1 data`)
- Missing required fields (e.g. `%begin 12345` with only 1 of 3 fields)
- Non-numeric fields where numbers are expected
- Empty `%window-add` (no window ID)

### 11.7 CRLF Handling

The reader frames lines on the LF byte (0x0A). If a trailing CR (0x0D) is
present (CRLF from some systems), it is trimmed. This normalizes both LF-only
and CRLF-terminated lines to the same representation.

### 11.8 Reconnection

Reconnection requires creating a new `TmuxClient` instance. The old client's
`disconnected` flow latches to `true` and never resets. The design is:

```
old client -> close/detach
new client = factory.create(session, name, ...)
new client.connect()
```

The warm cache (`TmuxSessionRuntimeCache`) can keep terminal surface state
alive across reconnects to avoid re-seeding.

---

## 12. Command Reference (tmux Commands Used)

### Session Management

| Command | Purpose | Response |
|---------|---------|----------|
| `tmux -CC new-session -A -s '<name>' [-c '<dir>']` | Attach or create session | Notifications: %session-changed, %window-add, %layout-change, %output |
| `tmux has-session -t '<name>'` | Probe session existence (exec, not control mode) | Exit code: 0=exists, non-zero=gone |
| `detach-client` | Clean detach from tmux server | %begin/%end, then %exit + channel close |
| `list-sessions` | List all tmux sessions | One session per line in response payload |
| `kill-session -t '<name>'` | Kill a session | Empty response or error |

### Window Management

| Command | Purpose |
|---------|---------|
| `list-windows` | List windows in current session |
| `select-window -t '<windowId>'` | Switch active window |

### Pane Management

| Command | Purpose |
|---------|---------|
| `list-panes -a [-F '<format>']` | List all panes with format fields |
| `capture-pane -p -e -S -<N> -t <paneId>` | Capture pane content with N lines of scrollback |
| `display-message -p -t <paneId> '#{cursor_x},#{cursor_y}'` | Get cursor position |
| `send-keys -t <paneId> <keys>` | Send keystrokes to a pane |

### Client Control

| Command | Purpose |
|---------|---------|
| `refresh-client -C <cols>x<rows>` | Report viewport size |
| `set-window-option -t '<target>' window-size latest` | Set window size policy |

### Common Format Strings for list-panes

```
#{pane_id}        Pane ID (e.g. %0)
#{window_id}      Window ID (e.g. @0)
#{session_id}     Session ID (e.g. $0)
#{pane_title}     Pane title
#{pane_current_command}  Running command name
#{pane_current_path}    Current working directory
#{pane_tty}       Pane TTY device (e.g. /dev/pts/3)
#{pane_in_mode}   1 if pane is in copy/choose mode
#{window_index}   Window index (e.g. 0, 1)
#{cursor_x}       Cursor X position
#{cursor_y}       Cursor Y position
```

---

## Appendix A: Typical Session Transcript

This is what a fresh `tmux -CC new-session -A -s 'pocketshell'` produces
on stdout:

```
%session-changed $0 pocketshell
%window-add @0
%layout-change @0 b25d,80x24,0,0{0}
%output %0 \033[?2004h\033[1;1H\033(B\033[0;7m...prompt output...\033[0m
```

Then for a `list-sessions` command written to stdin:

```
list-sessions
%begin 1700000000 1 0
pocketshell: 1 windows (created Thu Jun 12 10:00:00 2026) [80x24]
%end 1700000000 1 0
```

Then for `detach-client`:

```
detach-client
%begin 1700000001 2 0
%end 1700000001 2 0
%exit
```

After `%exit`, the tmux process closes the control channel, and the reader
loop sees EOF.

---

## Appendix B: Session List Parsing

### tmux list-sessions Output Formats

**Structured format (4 fields, tab or `::` separated):**
```
<name>\t<created_epoch>\t<last_activity_epoch>\t<attached_count>
<name>::<created_epoch>::<last_activity_epoch>::<attached_count>
```

**Extended format (5 fields, adds session path):**
```
<name>\t<created_epoch>\t<last_activity_epoch>\t<attached_count>\t<session_path>
```

**Fallback format (plain tmux output):**
```
<name>: <num> windows (created ...) [WxH] [attached]
```

### Pocketshell sessions list Output

```
IDX  <name>                        YYYY-MM-DD HH:MM:SS
```

Where IDX is a numeric index, name may contain spaces, and the timestamp
is anchored for parsing.

---

## Appendix C: Constants and Defaults

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_SESSION_NAME` | `"pocketshell"` | Default tmux session name |
| `DEFAULT_COMMAND_TIMEOUT_MS` | `10_000` | Per-command response timeout |
| `BEST_EFFORT_LATE_RESPONSE_DRAIN_MS` | `1_000` | Late-response drain window |
| `EVENT_BUFFER` | `256` | Global event bus buffer capacity |
| `OUTPUT_BACKLOG_EVENTS` | `4_096` | Per-pane output channel capacity |
| `DEFAULT_LINE_BUFFER_BYTES` | `4_096` | Initial line accumulation buffer |
| `READ_CHUNK_BYTES` | `8_192` | stdout read granularity |
| `LF_BYTE` | `0x0A` | Line delimiter |
| `CR_BYTE` | `0x0D` | Trailing CR to trim |
