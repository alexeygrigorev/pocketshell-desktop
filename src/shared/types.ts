/**
 * Shared types crossing the main/renderer IPC boundary.
 *
 * These are the ONLY values that ever leave the main process. Private keys
 * and passphrases never appear here — the renderer holds opaque
 * {@link ConnectionId}s and parsed results only.
 */

/** Opaque handle for a live SSH connection in the main process. */
export type ConnectionId = string;

/** Opaque handle for a live PTY shell opened on a connection. */
export type ShellId = string;

/** A host parsed from ~/.ssh/config or entered manually. */
export interface HostEntry {
  /** Friendly name from the `Host` directive, or a generated one. */
  name: string;
  hostname: string;
  port: number;
  user: string;
  /** Absolute path to the private key, or null for agent/default. */
  identityFile: string | null;
  /** Jump host alias, if `ProxyJump` was set. */
  proxyJump: string | null;
  /** ForwardAgent yes/no. */
  forwardAgent: boolean;
  /** Raw `LocalForward`/`RemoteForward` lines, parsed lazily. */
  localForwards: ForwardSpec[];
  remoteForwards: ForwardSpec[];
  /** True if this entry came from ~/.ssh/config (vs manual entry). */
  fromConfig: boolean;
}

/** A single port-forward rule. */
export interface ForwardSpec {
  kind: 'local' | 'remote' | 'dynamic';
  /** Listening side. For local/dynamic: this machine; remote: the host. */
  listenHost: string;
  listenPort: number;
  /** Destination for -L/-R. Empty for dynamic (SOCKS). */
  destHost: string;
  destPort: number;
}

/** Result of an exec over SSH. Never thrown on non-zero exit. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Outcome of a connect attempt. Never throws. */
export interface ConnectResult {
  ok: boolean;
  connectionId?: ConnectionId;
  error?: string;
  /** Host-key verification outcome for an unknown host (TOFU prompt). */
  unknownHostKey?: HostKeyFingerprint;
}

/** A host key fingerprint shown to the user for a TOFU accept/reject. */
export interface HostKeyFingerprint {
  algorithm: string;
  /** e.g. SHA256:base64... */
  fingerprint: string;
}

/** Bootstrap probe result for a connected host. */
export interface BootstrapResult {
  pocketshell: ToolState;
  tmux: ToolState;
  installer: 'uv' | 'pipx' | null;
  daemonRunning: boolean | null;
  daemonEnabled: boolean | null;
  /** Resolved PATH the helper/tools were found under. */
  resolvedPath: string;
}

export interface ToolState {
  installed: boolean;
  /** Absolute path from `command -v`, when installed. */
  path: string | null;
  version: string | null;
}

/**
 * How a tmux session is classified — the desktop mirror of the phone's
 * `SessionAgentKind` (shared/ui-kit/.../model/SessionAgentKind.kt).
 *
 * Epic #821: the durable answer lives **host-side** as the per-session tmux
 * user option `@ps_agent_kind`, written by the `pocketshell agent` wrapper at
 * launch (`record_agent_kind` in the helper's `agents.py`). Reading that
 * option back is therefore the *authoritative* classification — no process
 * sniffing, no output parsing, and it survives reconnect / app restart
 * because tmux session options live for the life of the session.
 *
 * `probing` / `exited` are the phone's transient detector states. The desktop
 * runs no detector, so nothing in the main process emits them today; they are
 * listed so the renderer's badge switch is exhaustive against the same enum
 * the phone renders.
 */
export type SessionAgentKind =
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'grok'
  | 'shell'
  | 'probing'
  | 'exited'
  | 'unknown';

/** A tmux session row from `pocketshell sessions list`. */
export interface SessionSummary {
  name: string;
  /** Epoch seconds of creation. */
  created: number;
  /** Epoch seconds of last activity. */
  activity: number;
  attached: boolean;
  /** Working directory if reported, else null. */
  path: string | null;
  /**
   * Recorded agent kind from the host-side `@ps_agent_kind` tmux user option,
   * or null when the option is absent/unrecognised — a session we did not
   * launch (the phone surfaces those as "Unknown" plus a kind picker).
   *
   * Optional so a host that yields no companion data at all (tmux missing,
   * probe failed) still produces valid rows.
   */
  agentKind?: SessionAgentKind | null;
}

/**
 * One item to stage as a prompt attachment.
 *
 * The two variants are the two ways a user attaches something: a
 * clipboard paste (bytes already in memory) and a picked or dropped
 * file (a local path we can stream from). Both land in the same remote
 * directory under the same naming scheme — see AttachmentStager.
 */
export type AttachmentSource =
  | {
      kind: 'bytes';
      /** Raw file bytes. Structured-cloned across the IPC boundary. */
      data: Uint8Array;
      /** Suggested filename, when the clipboard offered one. */
      name?: string | null;
      /** Mime type, e.g. 'image/png'. Used only to default a missing extension. */
      mimeType?: string | null;
    }
  | {
      kind: 'file';
      /** Absolute path on this machine; streamed to the remote, never read into memory. */
      path: string;
      /** Overrides the path's basename as the display name, when set. */
      name?: string | null;
      mimeType?: string | null;
    };

/**
 * Outcome of staging a batch of attachments. Never thrown.
 *
 * A partial failure resolves with `ok: false` AND a populated `paths` —
 * those files DID upload and must still be attached (Android issue
 * #570). Only an empty `paths` means nothing landed.
 */
export interface StageAttachmentsResult {
  /** True only when every source uploaded. */
  ok: boolean;
  /** Tilde-form remote paths, e.g. `~/.pocketshell/attachments/main/20260824-101500-01-shot.png`. */
  paths: string[];
  /** How many sources failed. */
  failedCount: number;
  /** Present whenever `ok` is false; safe to show to the user. */
  error?: string;
}

/** Connection state surfaced to the UI. */
export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'lost';
