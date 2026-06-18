import type { SshService } from '../ssh/SshService.js';
import { pathAwareCommand } from '../helper/bootstrap.js';
import {
  parseSsTln,
  parseSsTlnp,
  parseNetstatTlnp,
  type RemotePort,
} from './PortScanner.js';

export type { RemotePort };

/**
 * Scan a remote host for listening TCP ports.
 *
 * Strategy: `ss -tln` is the reliable primary because `ss -tlnp` (with `-p`)
 * HIDES ports whose process info is unreadable as non-root (it filters them
 * out rather than just omitting the process name). We get the full port list
 * from `ss -tln`, then enrich with process names from `ss -tlnp` (and fall
 * back to `netstat -tlnp`) where attribution is available.
 */
export async function scanRemotePorts(
  ssh: SshService,
  connectionId: string,
): Promise<RemotePort[]> {
  // 1. Get the full port list from `ss -tln` (no process filtering).
  const ssTln = await ssh.exec(connectionId, pathAwareCommand('ss -tln'));
  let ports: RemotePort[] = [];
  if (ssTln.exitCode === 0) {
    ports = parseSsTln(ssTln.stdout);
  }
  // Fallback to netstat if ss -tln returned nothing.
  if (ports.length === 0) {
    const netstat = await ssh.exec(connectionId, pathAwareCommand('netstat -tln'));
    if (netstat.exitCode === 0) {
      ports = parseNetstatTlnp(netstat.stdout);
    }
  }
  if (ports.length === 0) return [];

  // 2. Enrich with process names from `ss -tlnp` (best-effort; non-root
  //    hides some ports, so we merge by port number).
  const ssTlnp = await ssh.exec(connectionId, pathAwareCommand('ss -tlnp'));
  if (ssTlnp.exitCode === 0) {
    const withProcs = new Map<number, string>();
    for (const p of parseSsTlnp(ssTlnp.stdout)) {
      if (p.process) withProcs.set(p.port, p.process);
    }
    ports = ports.map((p) =>
      p.process ? p : { ...p, process: withProcs.get(p.port) ?? null },
    );
  }

  return ports;
}
