/**
 * Host bootstrap probe — the sequence the Android `HostBootstrapper` runs on
 * connect to detect the `pocketshell` helper, `tmux`, and the uv/pipx
 * installer, plus daemon status.
 *
 * The probe runs each check as a single SSH exec, wrapping commands in a
 * PATH-aware shell so user-bin locations ($HOME/.local/bin etc.) are on PATH
 * even under a non-login sshd.
 */

import type { SshService } from '../ssh/SshService.js';
import type { BootstrapResult, ToolState } from '../../shared/types.js';
import { parseCommandV } from './parsers.js';

/** The user-bin dirs prepended before probing, matching the Android app. */
const DEFAULT_USER_BIN = '$HOME/.local/bin:$HOME/bin:$HOME/.cargo/bin';

/**
 * Wrap a command so it runs under the user's full PATH: source the login
 * shell rc, prepend the standard user-bin dirs, then run the command. Mirrors
 * the Android `pathAwareCommand` wrapper.
 */
export function pathAwareCommand(command: string): string {
  return `/bin/sh -lc 'export PATH="${DEFAULT_USER_BIN}:$PATH"; ${command.replace(/'/g, "'\\''")}'`;
}

/** Probe one tool: `command -v <binary>` under the path-aware shell. */
async function probeTool(
  ssh: SshService,
  connectionId: string,
  binary: string,
): Promise<ToolState> {
  const res = await ssh.exec(connectionId, pathAwareCommand(`command -v ${binary}`));
  const path = parseCommandV(res.stdout, res.exitCode);
  if (!path) return { installed: false, path: null, version: null };
  // Best-effort version probe (cheap; ignored if it fails).
  const versionRes = await ssh.exec(connectionId, pathAwareCommand(`${binary} --version`));
  const version = versionRes.exitCode === 0 ? versionRes.stdout.trim().split(/\r?\n/)[0] : null;
  return { installed: true, path, version: version ?? null };
}

/** Detect the python installer: `command -v uv` then `command -v pipx`. */
async function detectInstaller(
  ssh: SshService,
  connectionId: string,
): Promise<'uv' | 'pipx' | null> {
  for (const binary of ['uv', 'pipx'] as const) {
    const res = await ssh.exec(connectionId, pathAwareCommand(`command -v ${binary}`));
    if (parseCommandV(res.stdout, res.exitCode)) return binary;
  }
  return null;
}

/**
 * Run the full bootstrap probe against a connected host.
 *
 * Never throws — missing tools are reported as `installed: false`, not errors.
 */
export async function runBootstrap(
  ssh: SshService,
  connectionId: string,
): Promise<BootstrapResult> {
  const [pocketshell, tmux, installer] = await Promise.all([
    probeTool(ssh, connectionId, 'pocketshell'),
    probeTool(ssh, connectionId, 'tmux'),
    detectInstaller(ssh, connectionId),
  ]);

  let daemonRunning: boolean | null = null;
  let daemonEnabled: boolean | null = null;
  if (pocketshell.installed) {
    // systemctl is required for the daemon check; if absent, both stay null.
    const systemctlRes = await ssh.exec(connectionId, pathAwareCommand('command -v systemctl'));
    if (parseCommandV(systemctlRes.stdout, systemctlRes.exitCode)) {
      const active = await ssh.exec(
        connectionId,
        systemdUserCommand('systemctl --user is-active pocketshell-jobs.service'),
      );
      daemonRunning = active.exitCode === 0;
      const enabled = await ssh.exec(
        connectionId,
        systemdUserCommand('systemctl --user is-enabled pocketshell-jobs.service'),
      );
      daemonEnabled = enabled.exitCode === 0;
    }
  }

  return {
    pocketshell,
    tmux,
    installer,
    daemonRunning,
    daemonEnabled,
    resolvedPath: '',
  };
}

/** Wrap a `systemctl --user` command with the env vars systemd needs over SSH. */
function systemdUserCommand(command: string): string {
  const env =
    `XDG_RUNTIME_DIR=\${XDG_RUNTIME_DIR:-/run/user/$(id -u)} ` +
    `DBUS_SESSION_BUS_ADDRESS=unix:path=\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bus`;
  return pathAwareCommand(`export ${env}; ${command}`);
}
