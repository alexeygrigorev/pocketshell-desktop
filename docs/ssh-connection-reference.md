# SSH Connection Management Reference

Source: PocketShell Android (`/home/alexey/git/pocketshell/`). This document
is the authoritative spec for the TypeScript (ssh2 + Electron) reimplementation
in PocketShell Desktop.

---

## 1. Host Data Model

### 1.1 HostEntity (Room `hosts` table)

```kotlin
// shared/core-storage/.../entity/HostEntity.kt
@Entity(
    tableName = "hosts",
    foreignKeys = [ForeignKey(
        entity = SshKeyEntity::class,
        parentColumns = ["id"],
        childColumns = ["keyId"],
        onDelete = ForeignKey.CASCADE,   // deleting a key cascades to its hosts
    )],
    indices = [Index("keyId")],
)
data class HostEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val name: String,                    // display label
    val hostname: String,                // IP or DNS name
    val port: Int = 22,                  // SSH port
    val username: String,                // remote login user
    val keyId: Long,                     // FK -> SshKeyEntity.id

    // Auto-forward defaults (port-fwd model lives in core-portfwd)
    val maxAutoPort: Int = 10000,
    val skipPortsBelow: Int = 1000,
    val scanIntervalSec: Int = 5,
    val enabled: Boolean = false,

    // Timestamps
    val createdAt: Long = System.currentTimeMillis(),
    val lastConnectedAt: Long? = null,   // updated on successful connect

    // Bootstrap / setup cache (probed on first connect, cached here)
    val tmuxInstalled: Boolean? = null,           // null = never probed
    val lastBootstrapAt: Long? = null,
    val pocketshellInstalled: Boolean? = null,
    val pocketshellLastDetectedAt: Long? = null,
    val pocketshellCliVersion: String? = null,
    val pocketshellExpectedCliVersion: String? = null,
    val pocketshellVersionCompatible: Boolean? = null,
    val pocketshellDaemonRunning: Boolean? = null,
    val pocketshellDaemonEnabled: Boolean? = null,
    val usageCommandOverride: String? = null,

    // Per-host agent profile config (JSON-encoded lists)
    val claudeProfilesJson: String? = null,       // [{name, configDir}]
    val codexProfilesJson: String? = null,         // [{name, configDir}]
)
```

### 1.2 SshKeyEntity (Room `ssh_keys` table)

```kotlin
// shared/core-storage/.../entity/SshKeyEntity.kt
@Entity(tableName = "ssh_keys")
data class SshKeyEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val name: String,                    // display name / filename
    val privateKeyPath: String,          // absolute path to on-disk PEM file
    val fingerprint: String = "",        // "sha256:<hex>" of trimmed key content
    val hasPassphrase: Boolean = false,
    val createdAt: Long = System.currentTimeMillis(),
)
```

### 1.3 SessionEntity (Room `sessions` table, tmux session cache)

```kotlin
// shared/core-storage/.../entity/SessionEntity.kt
@Entity(
    tableName = "sessions",
    foreignKeys = [ForeignKey(entity = HostEntity::class, ...)],
    indices = [Index(value = ["hostId", "name"], unique = true)],
)
data class SessionEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val hostId: Long,
    val name: String,
    val lastSeenAt: Long,
    val tags: String,  // comma-separated
)
```

### 1.4 Desktop TypeScript Equivalent (Proposal)

```typescript
interface Host {
  id: number;
  name: string;
  hostname: string;
  port: number;           // default 22
  username: string;
  keyId: number;          // FK -> SshKey.id

  // Port-forwarding defaults
  maxAutoPort: number;    // default 10000
  skipPortsBelow: number; // default 1000
  scanIntervalSec: number;// default 5
  enabled: boolean;       // default false

  // Timestamps
  createdAt: number;      // epoch ms
  lastConnectedAt: number | null;

  // Bootstrap cache (nullable = never probed)
  tmuxInstalled: boolean | null;
  lastBootstrapAt: number | null;
  pocketshellInstalled: boolean | null;
  pocketshellCliVersion: string | null;
  pocketshellVersionCompatible: boolean | null;

  // Agent profiles (JSON strings)
  claudeProfilesJson: string | null;
  codexProfilesJson: string | null;
}

interface SshKey {
  id: number;
  name: string;
  privateKeyPath: string;
  fingerprint: string;    // "sha256:<hex>"
  hasPassphrase: boolean;
  createdAt: number;      // epoch ms
}
```

---

## 2. SSH Key Types

```kotlin
// shared/core-ssh/.../SshKey.kt
sealed interface SshKey {
    data class Path(val file: File) : SshKey      // on-disk file
    data class Pem(val content: String) : SshKey  // in-memory PEM string
}
```

The SSH connection layer accepts both variants. sshj auto-detects the format
(classic PEM `BEGIN RSA PRIVATE KEY`, OpenSSH `BEGIN OPENSSH PRIVATE KEY`,
PKCS8, PuTTY PPK).

### Desktop equivalent

```typescript
type SshKey =
  | { type: "path"; file: string }       // filesystem path
  | { type: "pem"; content: string };    // in-memory PEM/OpenSSH string
```

---

## 3. Known Hosts Policy

```kotlin
// shared/core-ssh/.../KnownHostsPolicy.kt
sealed interface KnownHostsPolicy {
    data object AcceptAll : KnownHostsPolicy
        // PromiscuousVerifier — tests only

    data class KnownHostsFile(val file: File) : KnownHostsPolicy
        // OpenSSH known_hosts format verification
}
```

### Desktop equivalent

```typescript
type KnownHostsPolicy =
  | { type: "acceptAll" }
  | { type: "knownHostsFile"; file: string };
```

---

## 4. Connection Lifecycle (SshConnection)

### 4.1 Connect Entry Point

```kotlin
// shared/core-ssh/.../SshConnection.kt
object SshConnection {
    const val DEFAULT_TIMEOUT_MS = 30_000       // TCP + auth timeout
    const val DEFAULT_KEEP_ALIVE_SECONDS = 15    // keepalive interval
    const val DEFAULT_MAX_ALIVE_COUNT = 4        // tolerance window = 15s * 4 = 60s

    suspend fun connect(
        host: String,
        port: Int,
        user: String,
        key: SshKey,
        passphrase: CharArray? = null,
        knownHosts: KnownHostsPolicy = AcceptAll,
        timeoutMs: Int = 30_000,
        keepAliveSeconds: Int = 15,
    ): Result<SshSession>
}
```

### 4.2 Connect Flow (step by step)

1. Install `SshjTransportThreadGuard` (process-wide crash guard for sshj
   background threads).
2. Create `SSHClient` with BouncyCastle provider and `KeepAliveProvider.KEEP_ALIVE`.
3. Apply known-hosts policy (PromiscuousVerifier or load known_hosts file).
4. Configure keep-alive on the client's connection BEFORE `connect()`:
   - `keepAliveInterval = keepAliveSeconds`
   - `maxAliveCount = 4` (for `KeepAliveRunner`)
5. Set `connectTimeout` and `timeout` on the client.
6. `client.connect(host, port)`.
7. Load key provider from `SshKey.Path` or `SshKey.Pem`.
8. `client.authPublickey(user, keyProvider)`.
9. Return `RealSshSession(client)` on success, or `Result.failure(SshException(...))`.

**Cancellation safety**: If the coroutine is cancelled mid-connect, the
half-open client is disconnected in `invokeOnCancellation`.

### 4.3 Desktop equivalent

```typescript
async function connect(params: {
  host: string;
  port: number;
  user: string;
  key: SshKey;
  passphrase?: string;
  knownHosts: KnownHostsPolicy;
  timeoutMs?: number;        // default 30000
  keepAliveSeconds?: number; // default 15
}): Promise<SshSession>;
```

With `ssh2` for Node.js:
- Use `keepaliveInterval` and `keepaliveCountMax` options on `Client.connect()`.
- `ssh2` supports key from Buffer or file path directly.

---

## 5. SshSession Interface

```kotlin
// shared/core-ssh/.../SshSession.kt
interface SshSession : AutoCloseable {
    val isConnected: Boolean

    suspend fun exec(command: String): ExecResult
        // Runs command on a single exec channel, returns stdout/stderr/exitCode

    fun tail(path: String, onLine: (String) -> Unit): Job
        // Streams `tail -F <path>`, calls onLine per line. Returns cancellable Job.

    fun openLocalPortForward(remoteHost: String, remotePort: Int, localPort: Int): SshPortForward

    fun startShell(): SshShell
        // Allocates PTY (xterm-256color, 80x24), starts login shell

    suspend fun uploadFile(file: File, remotePath: String): String
    suspend fun uploadStream(input: InputStream, length: Long, name: String, remotePath: String): String
    suspend fun downloadFile(remotePath: String, maxBytes: Long): ByteArray
    suspend fun listDirectory(remotePath: String, maxEntries: Int = 5000): RemoteListing

    override fun close()
        // Idempotent. Swallows all teardown exceptions.
}
```

### 5.1 ExecResult

```kotlin
data class ExecResult(val stdout: String, val stderr: String, val exitCode: Int)
```

### 5.2 SshShell

```kotlin
// shared/core-ssh/.../SshShell.kt
interface SshShell : AutoCloseable {
    val stdin: OutputStream
    val stdout: InputStream
    val stderr: InputStream
    fun resizePty(columns: Int, rows: Int)
    override fun close()   // idempotent; does NOT close parent SshSession
}
```

PTY allocation details:
- TERM = `xterm-256color`
- Initial size = 80 x 24
- Resized to actual terminal dimensions after first layout

### 5.3 SshPortForward

```kotlin
// shared/core-ssh/.../SshPortForward.kt
interface SshPortForward : AutoCloseable {
    val localPort: Int
    val remoteHost: String
    val remotePort: Int
    val isActive: Boolean
    val bytesForwarded: Long
    val bytesReceived: Long
    override fun close()
}
```

### 5.4 RemoteEntry / RemoteListing

```kotlin
// shared/core-ssh/.../RemoteEntry.kt
data class RemoteEntry(
    val name: String,
    val type: Type,           // DIRECTORY, FILE, SYMLINK, OTHER
    val sizeBytes: Long,
    val modifiedEpochSec: Long?,
)

data class RemoteListing(
    val entries: List<RemoteEntry>,
    val truncated: Boolean,   // true if capped at maxEntries
)
```

### 5.5 SshException Hierarchy

```kotlin
open class SshException(message: String, cause: Throwable? = null) : Exception(...)
class SshFileNotFoundException(remotePath: String, ...) : SshException(...)
class SshFileTooLargeException(remotePath: String, val sizeBytes: Long, val maxBytes: Long, ...) : SshException(...)
class SshNotADirectoryException(remotePath: String, ...) : SshException(...)
class SshPermissionDeniedException(remotePath: String, ...) : SshException(...)
```

---

## 6. Connection Pooling (SshLeaseManager)

The lease manager is an app-scoped singleton that pools SSH transports keyed by
host identity. Multiple callers share one TCP connection to the same host.

### 6.1 Key Types

```kotlin
data class SshLeaseKey(
    val host: String,
    val port: Int,
    val user: String,
    val credentialId: String,       // unique ID for the credential
    val knownHostsId: String = "accept-all",
)

data class SshLeaseTarget(
    val leaseKey: SshLeaseKey,
    val key: SshKey,
    val passphrase: CharArray? = null,
    val knownHosts: KnownHostsPolicy = AcceptAll,
    val timeoutMs: Int = 30_000,
    val keepAliveSeconds: Int = 15,
)
```

### 6.2 Public API

```kotlin
class SshLeaseManager(connector: SshLeaseConnector, ...) : AutoCloseable {
    suspend fun acquire(target: SshLeaseTarget): Result<SshLease>
    suspend fun disconnect(key: SshLeaseKey)
    suspend fun evictIdle(key: SshLeaseKey): Boolean
    suspend fun hasLiveLease(key: SshLeaseKey): Boolean
    suspend fun hasLiveOrConnectingLease(key: SshLeaseKey): Boolean
    suspend fun onProcessStopped()   // close idle leases when app backgrounds
    suspend fun onProcessStarted()
    override fun close()             // close ALL leases

    val stateEvents: SharedFlow<SshLeaseStateEvent>
}
```

### 6.3 SshLease

```kotlin
class SshLease(
    val key: SshLeaseKey,
    val session: SshSession,
    val isNewConnection: Boolean,
    ...
) {
    suspend fun release()   // idempotent
}
```

### 6.4 Configuration Defaults

| Constant | Value | Meaning |
|----------|-------|---------|
| `DEFAULT_IDLE_TTL_MILLIS` | 60,000 | How long a released lease stays warm |
| `DEFAULT_MAX_IDLE_LEASES` | 2 | Max simultaneous idle leases |
| `DEFAULT_CONNECT_TIMEOUT_MILLIS` | 35,000 | Hard cap on a single cold connect |

### 6.5 Coalescing Behavior

Concurrent `acquire()` calls for the same `SshLeaseKey` share ONE SSH
handshake (CompletableDeferred pattern). The first caller "owns" the connect;
subsequent callers await the shared result and reuse the entry.

### 6.6 Acquire Decision Tree

```
acquire(key)
  |-- [live entry exists?]
  |     YES -> Reuse: increment refCount, return SshLease
  |     NO  -> remove stale entry
  |           |-- [in-flight connect for this key?]
  |           |     YES -> Await: park on CompletableDeferred
  |           |     NO  -> Own: create deferred, start bounded connect
  |
  runOwnedConnect:
    boundedConnect(target)  // 35s hard cap
      |-- success -> register entry, emit Connected
      |-- failure -> retract Connecting hint, fail acquire
```

### 6.7 Release Behavior

```
release(key, entryId)
  |-- decrement refCount
  |-- [refCount > 0?] -> done (other holders still active)
  |-- [session disconnected OR process stopped OR idleTtl == 0 OR maxIdle == 0?]
  |     YES -> close immediately, emit Closed
  |     NO  -> start idle timer (60s), emit Idle
  |           |-- timer fires -> closeIfStillIdle -> close, emit IdleExpired
  |           |-- trimIdleLocked -> if > maxIdleLeases, close oldest
```

### 6.8 Close Reasons

```kotlin
enum class SshLeaseCloseReason {
    IdleExpired,         // idle timer fired
    IdleTrimmed,         // evicted to stay under maxIdleLeases
    ProcessStopped,      // app went to background
    ExplicitDisconnect,  // caller called disconnect()
    ManagerClosed,       // manager itself shut down
    Disconnected,        // transport dropped
    ForceRefresh,        // evictIdle() for network handoff
}
```

### 6.9 Lease State Events

```kotlin
enum class SshLeaseConnectionState {
    Connecting,   // cold connect in progress
    Connected,    // actively leased
    Idle,         // released but warm
    Closed,       // transport torn down
}
```

---

## 7. Connection State Machine

The connection lifecycle is managed by `ConnectionController`, a pure-JVM
synchronous reducer. It handles app foreground/background, transport drops,
and reconnect logic.

### 7.1 States

```kotlin
sealed interface ConnectionState {
    data object Idle : ConnectionState

    data class Connecting(host: HostKey, targetId: SessionId) : ConnectionState
        // Cold dial. Full-screen overlay allowed.

    data class Attaching(host: HostKey, targetId: SessionId) : ConnectionState
        // Warm: lease up, opening select-window + seeding. NO overlay.

    data class Live(host: HostKey, targetId: SessionId) : ConnectionState
        // Attached, input enabled.

    data class Backgrounded(host: HostKey, targetId: SessionId, sinceMs: Long) : ConnectionState
        // App backgrounded. Lease stays warm for grace window.

    data class Reattaching(host: HostKey, targetId: SessionId) : ConnectionState
        // Transient drop or within-grace resume. Silent heal, NO error band.

    data class Reconnecting(host: HostKey, targetId: SessionId, attempt: Int) : ConnectionState
        // Beyond grace / heal exhausted. Silent auto-reconnect. NO manual button.

    data class Gone(host: HostKey, targetId: SessionId) : ConnectionState
        // Target session deleted elsewhere. Do NOT auto-create.

    data class Unreachable(host: HostKey, targetId: SessionId) : ConnectionState
        // Only honest error state. After max reconnect attempts exhausted.
}
```

### 7.2 Events

```kotlin
sealed interface ConnectionEvent {
    data class Enter(host: HostKey, targetId: SessionId)     // user opened host/session
    data class Switch(targetId: SessionId)                   // same-host session switch
    data object Foreground                                   // app came to foreground
    data object Background                                   // app went to background
    data class TransportDropped(reason: String)              // transport died
    data object TransportLive                                // transport healed
    data class NetworkChanged(validatedHandoff: Boolean)     // network change
    data class TargetGone(targetId: SessionId)               // session deleted remotely
    data class SeedLanded(targetId: SessionId, paneId: String) // pane capture done
}
```

### 7.3 State Transitions

```
                    ┌─────────────────────────────────────┐
                    │              Idle                    │
                    └────────┬────────────────────────────┘
                             │ Enter (cold host)
                             v
                    ┌──────────────────┐
                    │   Connecting      │◄─── TransportLive
                    │   (overlay OK)    │        (-> Attaching)
                    └────┬─────────────┘
                         │ Enter (warm host) / TransportLive from Connecting
                         v
                ┌──────────────────┐   Switch (same host, new target)
                │   Attaching      │◄──────────────────┐
                │   (NO overlay)   │                    │
                └────┬─────────────┘                    │
                     │ SeedLanded                       │
                     v                                   │
                ┌──────────────────┐                     │
                │      Live        │── Switch ───────────┘
                │  (input enabled) │
                └────┬─────────────┘
                     │ Background
                     v
                ┌──────────────────┐
                │  Backgrounded    │
                │  (grace = 60s)   │
                └────┬─────────────┘
                     │ Foreground
                     ├─ within grace + warm ──> Reattaching
                     └─ beyond grace ─────────> Reconnecting(attempt=1)

    TransportDropped from:
        Live/Attaching/Connecting ──> Reattaching
        Reattaching               ──> Reconnecting(1)
        Reconnecting(attempt=N)   ──> Reconnecting(N+1) or Unreachable (if N > 4)

    TransportLive from:
        Reattaching  ──> Live
        Reconnecting ──> Live
        Connecting   ──> Attaching

    NetworkChanged(validated=true) from Live ──> Reconnecting(1)
        (proactive silent reconnect on validated network handoff)

    TargetGone ──> Gone (never auto-creates)
```

### 7.4 Key Constants

| Constant | Value | Meaning |
|----------|-------|---------|
| `DEFAULT_GRACE_MS` | 60,000 | Single grace window = sshj keepalive 15s x 4 |
| `DEFAULT_MAX_RECONNECT_ATTEMPTS` | 4 | Max silent reconnect tries before Unreachable |

### 7.5 Reveal Gate

```kotlin
sealed interface RevealDecision {
    data object None : RevealDecision                       // Idle
    data class Hold(targetId: SessionId) : RevealDecision   // Don't paint yet
    data class Reveal(targetId: SessionId, inputEnabled: Boolean) : RevealDecision
        // Show content, enable input
}
```

Only `Live` state triggers `Reveal`. All other non-idle states trigger `Hold`.

### 7.6 Port Interfaces (dependency inversion)

The controller does not perform IO directly. It depends on:

```kotlin
interface TransportPort {
    suspend fun ensureLease(host: HostKey): LeaseHandle
    fun isWarm(host: HostKey): Boolean
    suspend fun evictStale(host: HostKey)
    val transportEvents: Flow<TransportUpDown>
}

interface TmuxPort {
    suspend fun attach(targetId: SessionId)
    suspend fun selectWindow(targetId: SessionId)
    suspend fun seedActivePane(targetId: SessionId): Seed
    suspend fun detachCleanly()
    val disconnected: Flow<Boolean>
}

interface Clock {
    fun nowMs(): Long
}
```

---

## 8. SSH Key Management

### 8.1 Key Import

```kotlin
// app/.../hosts/SshKeyStorage.kt
object SshKeyStorage {
    suspend fun persistKey(
        context: Context,
        sshKeyDao: SshKeyDao,
        name: String,
        content: String,
        hasPassphrase: Boolean = hasPrivateKeyPassphrase(content),
    ): SshKeyEntity
}
```

Import flow:
1. Trim key content, validate it looks like a private key.
2. Compute SHA-256 fingerprint of trimmed content: `"sha256:<hex>"`.
3. Check if a key with this fingerprint already exists. If so, return the
   existing entity (re-import dedup).
4. Write private key file to `<appPrivateDir>/ssh-keys/<name>` with restricted
   permissions (owner read/write only).
5. Insert `SshKeyEntity` row and return it.

### 8.2 Key Validation

```kotlin
fun looksLikePrivateKey(content: String): Boolean
    // Checks for "-----BEGIN" + "PRIVATE KEY" + closing "-----END"

fun hasPrivateKeyPassphrase(content: String): Boolean
    // Detects:
    //   - "Proc-Type: 4,ENCRYPTED"
    //   - "DEK-Info:" header
    //   - "BEGIN ENCRYPTED PRIVATE KEY"
    //   - OpenSSH encrypted format (parses binary to check cipher != "none")
```

### 8.3 Key Generation

The app generates RSA-3072 keys on-device (RSA chosen because Ed25519
requires BouncyCastle on Android). The private key is written in PKCS#8 PEM
format, named `generated-<timestamp>`.

### 8.4 Key Deletion

1. Delete the on-disk file first.
2. Delete the database row.
3. Associated hosts are cascade-deleted via the FK constraint.

### 8.5 QR Import (PocketShell Config Transfer)

```kotlin
// app/.../hosts/SshImportPayloadCodec.kt
data class SshImportConfig(
    val name: String,
    val host: String,
    val port: Int,          // defaults to 22
    val username: String,
    val auth: SshImportAuth,
)

sealed interface SshImportAuth {
    data class PrivateKey(val name: String, val privateKeyPem: String, val passphraseRequired: Boolean) : SshImportAuth
    data class KeyReference(val name: String) : SshImportAuth
}
```

Format: JSON with `"type": "pocketshell.ssh-import.v1"`, max 12KB.

---

## 9. Error Classification

```kotlin
// app/.../sessions/HostConnectError.kt
enum class HostConnectErrorReason {
    ConnectionRefused,
    UnknownHost,
    TimedOut,
    AuthFailed,        // sshj UserAuthException
    Unknown,
}

data class HostConnectErrorSummary(
    val reason: HostConnectErrorReason,
    val shortReason: String,       // e.g. "Connection refused."
    val details: String,           // full exception chain
)
```

Classification walks the cause chain matching:
- `UnknownHostException` or message containing "UnknownHostException" -> `UnknownHost`
- `SocketTimeoutException` or "timed out" -> `TimedOut`
- `ConnectException` or "ECONNREFUSED" / "Connection refused" -> `ConnectionRefused`
- sshj `UserAuthException` (by class name) -> `AuthFailed`

---

## 10. DAO API Surface (CRUD)

### HostDao

```kotlin
@Dao
interface HostDao {
    @Query("SELECT * FROM hosts ORDER BY name")
    fun getAll(): Flow<List<HostEntity>>          // reactive

    @Query("SELECT * FROM hosts WHERE id = :id")
    suspend fun getById(id: Long): HostEntity?

    @Query("SELECT * FROM hosts WHERE enabled = 1")
    fun getEnabled(): Flow<List<HostEntity>>      // reactive

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(host: HostEntity): Long

    @Update
    suspend fun update(host: HostEntity)

    @Delete
    suspend fun delete(host: HostEntity)

    @Query("DELETE FROM hosts WHERE id = :id")
    suspend fun deleteById(id: Long)
}
```

### SshKeyDao

```kotlin
@Dao
interface SshKeyDao {
    @Query("SELECT * FROM ssh_keys ORDER BY name")
    fun getAll(): Flow<List<SshKeyEntity>>

    @Query("SELECT * FROM ssh_keys WHERE id = :id")
    suspend fun getById(id: Long): SshKeyEntity?

    @Query("SELECT * FROM ssh_keys WHERE name = :name LIMIT 1")
    suspend fun getByName(name: String): SshKeyEntity?

    @Query("SELECT * FROM ssh_keys WHERE fingerprint = :fingerprint ORDER BY id LIMIT 1")
    suspend fun getByFingerprint(fingerprint: String): SshKeyEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(key: SshKeyEntity): Long

    @Delete
    suspend fun delete(key: SshKeyEntity)

    @Query("DELETE FROM ssh_keys WHERE id = :id")
    suspend fun deleteById(id: Long)
}
```

### SessionDao

```kotlin
@Dao
interface SessionDao {
    @Query("SELECT * FROM sessions WHERE hostId = :hostId")
    fun getByHostId(hostId: Long): Flow<List<SessionEntity>>

    @Query("SELECT * FROM sessions")
    fun getAll(): Flow<List<SessionEntity>>

    @Query("SELECT * FROM sessions WHERE id = :id")
    suspend fun getById(id: Long): SessionEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(session: SessionEntity): Long

    @Query("DELETE FROM sessions WHERE id = :id")
    suspend fun deleteById(id: Long)

    @Query("DELETE FROM sessions WHERE hostId = :hostId")
    suspend fun deleteByHostId(hostId: Long)
}
```

---

## 11. App-Level Integration Points

### 11.1 DI Wiring (Dagger/Hilt)

```kotlin
// app/.../di/SshLeaseModule.kt
@Module @InstallIn(SingletonComponent::class)
object SshLeaseModule {
    @Provides @Singleton
    fun provideSshLeaseConnector(): SshLeaseConnector = DefaultSshLeaseConnector()

    @Provides @Singleton
    fun provideSshLeaseManager(connector: SshLeaseConnector): SshLeaseManager
}
```

### 11.2 Process-Wide Singleton

```kotlin
// app/.../sessions/SharedSshLeaseManager.kt
// Non-DI code (assistant executors, etc.) accesses the same pool via this accessor.
```

### 11.3 Lease-Based Exec Helper

```kotlin
// app/.../sessions/LeaseSessionExec.kt
suspend fun <T> withSession(
    leaseManager: SshLeaseManager,
    target: SshLeaseTarget,
    block: suspend (SshSession) -> T,
): T
    // Acquires lease, runs block, releases.
    // On stale-channel symptom, evicts poisoned transport and retries once.
```

---

## 12. SSH Config Parsing

The Android app does **not** parse `~/.ssh/config`. Host entries are created
manually through the UI or imported via QR code (`SshImportPayloadCodec`).

---

## 13. Thread Safety Notes

1. **SshSession** is thread-safe. Multiple coroutines can call `exec`, `tail`,
   `startShell`, etc. concurrently on the same session.

2. **SshLeaseManager** uses a `Mutex` for all state mutations. The `acquire`
   decision is made under the lock; the actual connect runs outside it.

3. **ConnectionController** is a synchronous reducer (no IO inside). All
   transport/tmux effects are injected via port interfaces.

4. **SshjTransportThreadGuard** is a process-wide `UncaughtExceptionHandler`
   that swallows sshj internal thread crashes (transport drops on Reader/KeepAlive
   threads) to prevent process termination. The same disconnect is observed through
   the normal coroutine/channel read path.

5. **close() is idempotent** on `SshSession`, `SshShell`, and `SshPortForward`.
   All teardown exceptions are swallowed per the issue #151 / #239 contract.

---

## 14. File Transfer Implementation Notes

The Android app does **not** use SCP or SFTP for file transfer. It uses
`exec` channels with shell commands for maximum server compatibility:

| Operation | Method | Rationale |
|-----------|--------|-----------|
| Upload | `cat > path` over exec | No scp/sftp-server needed |
| Download | Size probe (`wc -c`) + `cat path` over exec | Binary-safe, busybox-compatible |
| List dir | `find -maxdepth 1` + `stat -c` | Works without sftp subsystem |
| Tail | `tail -F path` over persistent exec | Survives file rotation |

For the Desktop (ssh2-based) implementation, SFTP is available and should be
preferred for file operations, but the exec-based fallback should remain
available for servers without the sftp subsystem.

---

## 15. Implementation Priorities for Desktop

Based on the Android architecture, the Desktop TypeScript implementation should
prioritize:

1. **Host/SshKey data models** -- SQLite via better-sqlite3 or similar
2. **SshConnection connect/disconnect** -- ssh2 `Client` with keepalive
3. **SshSession interface** -- exec, shell (PTY), tail, file ops
4. **SshLeaseManager** -- connection pooling with coalescing, idle TTL
5. **ConnectionController state machine** -- foreground/background, reconnect
6. **Key management** -- import, generate, fingerprint, dedup
7. **QR import** -- same JSON format for cross-platform config transfer
8. **Known hosts** -- OpenSSH known_hosts file verification (production default)
