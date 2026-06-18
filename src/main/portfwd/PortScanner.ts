/**
 * Pure parser for remote port-scan output (ss / netstat). Used by the
 * AutoForwarder to discover listening services to mirror to localhost.
 *
 * Three strategies (first non-blank wins), matching the Android PortScanner:
 *   1. `ss -tlnp`      -> `<addr> users:(("name",...))`
 *   2. `netstat -tlnp` -> `<addr> LISTEN <pid/name>`
 *   3. `ss -tln`       -> `<addr>` (no process name)
 *
 * The address is `IP:PORT`, `[IPv6]:PORT`, or `*:PORT`.
 */

export interface RemotePort {
  port: number;
  /** Process name when available; otherwise null. */
  process: string | null;
}

/** Parse `ss -tlnp` output. Skips the header line. */
export function parseSsTlnp(stdout: string): RemotePort[] {
  const out: RemotePort[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('State') || line.startsWith('Netid')) continue;
    // Format: State Recv-Q Send-Q LocalAddress:Port PeerAddress:Port Process
    // We only need LocalAddress + Process. Tokenise on whitespace; the 4th
    // token is the local addr, the 6th+ is "users:(("name",pid=...))".
    const tokens = line.split(/\s+/);
    if (tokens.length < 4) continue;
    const addr = tokens[3]!;
    const port = extractPort(addr);
    if (!port) continue;
    let process: string | null = null;
    const rest = tokens.slice(5).join(' ');
    const match = /users:\(\("([^"]+)"/.exec(rest);
    if (match && match[1]) process = match[1];
    out.push({ port, process });
  }
  return dedupe(out);
}

/** Parse `netstat -tlnp` output. Looks for LISTEN lines. */
export function parseNetstatTlnp(stdout: string): RemotePort[] {
  const out: RemotePort[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !/LISTEN/i.test(line)) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length < 4) continue;
    const addr = tokens[3]!;
    const port = extractPort(addr);
    if (!port) continue;
    let process: string | null = null;
    const last = tokens[tokens.length - 1];
    if (last && last.includes('/')) {
      process = last.split('/')[1] ?? null;
    }
    out.push({ port, process });
  }
  return dedupe(out);
}

/** Parse `ss -tln` (no process info). */
export function parseSsTln(stdout: string): RemotePort[] {
  const out: RemotePort[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('State') || line.startsWith('Netid')) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length < 4) continue;
    const port = extractPort(tokens[3] ?? '');
    if (port) out.push({ port, process: null });
  }
  return dedupe(out);
}

function extractPort(addr: string): number | null {
  // `[::1]:8080` | `127.0.0.1:8080` | `*:8080` | `0.0.0.0:22`
  if (!addr) return null;
  if (addr.startsWith('[')) {
    const close = addr.lastIndexOf(']');
    const after = addr.slice(close + 2);
    const n = Number.parseInt(after, 10);
    return Number.isFinite(n) ? n : null;
  }
  const colon = addr.lastIndexOf(':');
  if (colon < 0) return null;
  const n = Number.parseInt(addr.slice(colon + 1), 10);
  return Number.isFinite(n) ? n : null;
}

function dedupe(ports: RemotePort[]): RemotePort[] {
  const seen = new Map<number, RemotePort>();
  for (const p of ports) {
    const existing = seen.get(p.port);
    if (!existing || (!existing.process && p.process)) {
      seen.set(p.port, existing ? { ...existing, process: p.process ?? existing.process } : p);
    }
  }
  return [...seen.values()].sort((a, b) => a.port - b.port);
}
