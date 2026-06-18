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
}

/** Connection state surfaced to the UI. */
export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'lost';
