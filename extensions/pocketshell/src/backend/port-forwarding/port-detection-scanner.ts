export type DetectedPortSource = 'pane-url' | 'remote-listener';
export type DetectedPortProtocol = 'http' | 'https';

export interface LocalhostUrlDetection {
  url: string;
  protocol: DetectedPortProtocol;
  host: string;
  port: number;
  raw: string;
}

export interface RemoteListeningPort {
  protocol: 'tcp' | 'tcp6';
  localAddress: string;
  port: number;
  process?: string;
  pid?: number;
  raw: string;
  score: number;
}

export interface DetectedPortCandidate {
  source: DetectedPortSource;
  remoteHost: string;
  remotePort: number;
  protocol?: DetectedPortProtocol;
  label: string;
  description?: string;
  detail?: string;
  process?: string;
  pid?: number;
  score: number;
}

const LOCALHOST_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
]);

const DEV_PORTS = new Set([
  3000,
  3001,
  4200,
  4321,
  5000,
  5173,
  5174,
  5432,
  6379,
  8000,
  8080,
  8081,
  9000,
]);

const INTERESTING_PROCESSES = [
  'node',
  'npm',
  'vite',
  'next',
  'python',
  'uvicorn',
  'gunicorn',
  'django',
  'flask',
  'rails',
  'ruby',
  'java',
  'go',
  'dotnet',
  'php',
  'deno',
  'bun',
];

export function extractLocalhostUrls(output: string): LocalhostUrlDetection[] {
  const seen = new Set<string>();
  const result: LocalhostUrlDetection[] = [];
  const pattern = /\b(https?):\/\/((?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)):(\d{1,5})(?:[/?#][^\s"'<>)]*)?/gi;

  for (const match of output.matchAll(pattern)) {
    const protocol = match[1].toLowerCase() as DetectedPortProtocol;
    const host = normalizeDetectedHost(match[2]);
    const port = Number(match[3]);
    if (!isValidPort(port) || !isLocalhostHost(host)) {
      continue;
    }

    const url = `${protocol}://${host.includes(':') ? `[${host}]` : host}:${port}`;
    const key = `${protocol}:${host}:${port}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ url, protocol, host, port, raw: match[0] });
  }

  return result;
}

export function parseRemoteListeningPorts(output: string): RemoteListeningPort[] {
  const seen = new Set<string>();
  const result: RemoteListeningPort[] = [];

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^(State|Proto)\b/i.test(trimmed)) {
      continue;
    }

    const parsed = parseSsLine(trimmed) ?? parseNetstatLine(trimmed);
    if (!parsed || !isValidPort(parsed.port)) {
      continue;
    }

    const key = `${parsed.protocol}:${parsed.localAddress}:${parsed.port}:${parsed.process ?? ''}:${parsed.pid ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({
      ...parsed,
      raw: trimmed,
      score: scoreListeningPort(parsed),
    });
  }

  return result.sort((a, b) => b.score - a.score || a.port - b.port || a.localAddress.localeCompare(b.localAddress));
}

export function detectPortsFromPaneOutput(output: string): DetectedPortCandidate[] {
  return extractLocalhostUrls(output).map((url) => ({
    source: 'pane-url',
    remoteHost: remoteHostForLocalAddress(url.host),
    remotePort: url.port,
    protocol: url.protocol,
    label: `${url.protocol}://localhost:${url.port}`,
    description: 'pane output',
    detail: url.raw,
    score: 200 + (url.protocol === 'https' ? 5 : 0) + scorePortNumber(url.port),
  }));
}

export function remoteListeningPortsToCandidates(ports: readonly RemoteListeningPort[]): DetectedPortCandidate[] {
  return ports
    .filter((port) => port.score > 0)
    .map((port) => ({
      source: 'remote-listener',
      remoteHost: remoteHostForLocalAddress(port.localAddress),
      remotePort: port.port,
      label: `${remoteHostForLocalAddress(port.localAddress)}:${port.port}`,
      description: port.process ? `${port.process}${port.pid ? ` pid ${port.pid}` : ''}` : 'listening TCP port',
      detail: port.raw,
      process: port.process,
      pid: port.pid,
      score: port.score,
    }));
}

export function mergeDetectedPortCandidates(
  candidates: readonly DetectedPortCandidate[],
): DetectedPortCandidate[] {
  const byKey = new Map<string, DetectedPortCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.remoteHost}:${candidate.remotePort}`;
    const existing = byKey.get(key);
    if (!existing || candidate.score > existing.score || existing.source !== 'pane-url') {
      byKey.set(key, candidate);
    }
  }
  return Array.from(byKey.values())
    .sort((a, b) => b.score - a.score || a.remotePort - b.remotePort || a.remoteHost.localeCompare(b.remoteHost));
}

export function buildRemoteListeningPortsCommand(): string {
  return [
    'sh -lc',
    quoteShellArg(
      'if command -v ss >/dev/null 2>&1; then ' +
      'ss -ltnp 2>/dev/null || ss -ltn 2>/dev/null; ' +
      'elif command -v netstat >/dev/null 2>&1; then ' +
      'netstat -ltnp 2>/dev/null || netstat -ltn 2>/dev/null; ' +
      'else exit 127; fi',
    ),
  ].join(' ');
}

function parseSsLine(line: string): Omit<RemoteListeningPort, 'raw' | 'score'> | undefined {
  if (!/^LISTEN\b/i.test(line)) {
    return undefined;
  }
  const parts = line.split(/\s+/);
  if (parts.length < 4) {
    return undefined;
  }
  const endpoint = parseEndpoint(parts[3]);
  if (!endpoint) {
    return undefined;
  }
  const process = parseSsProcess(line);
  return {
    protocol: endpoint.address.includes(':') && endpoint.address !== '0.0.0.0' ? 'tcp6' : 'tcp',
    localAddress: endpoint.address,
    port: endpoint.port,
    process: process.process,
    pid: process.pid,
  };
}

function parseNetstatLine(line: string): Omit<RemoteListeningPort, 'raw' | 'score'> | undefined {
  const parts = line.split(/\s+/);
  if (!/^tcp6?$/i.test(parts[0] ?? '') || !parts.includes('LISTEN')) {
    return undefined;
  }
  const endpoint = parseEndpoint(parts[3]);
  if (!endpoint) {
    return undefined;
  }
  const program = parts[6] && parts[6] !== '-' ? parts[6] : undefined;
  const match = program?.match(/^(\d+)\/(.+)$/);
  return {
    protocol: parts[0].toLowerCase() === 'tcp6' ? 'tcp6' : 'tcp',
    localAddress: endpoint.address,
    port: endpoint.port,
    process: match?.[2] ?? program,
    pid: match ? Number(match[1]) : undefined,
  };
}

function parseEndpoint(value: string): { address: string; port: number } | undefined {
  const bracketed = value.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracketed) {
    return { address: bracketed[1], port: Number(bracketed[2]) };
  }

  const lastColon = value.lastIndexOf(':');
  if (lastColon < 0) {
    return undefined;
  }
  const rawAddress = value.slice(0, lastColon) || '*';
  const rawPort = value.slice(lastColon + 1);
  if (!/^\d+$/.test(rawPort)) {
    return undefined;
  }

  return {
    address: normalizeListeningAddress(rawAddress),
    port: Number(rawPort),
  };
}

function parseSsProcess(line: string): { process?: string; pid?: number } {
  const match = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
  if (!match) {
    return {};
  }
  return { process: match[1], pid: Number(match[2]) };
}

function scoreListeningPort(port: Pick<RemoteListeningPort, 'localAddress' | 'port' | 'process'>): number {
  let score = scorePortNumber(port.port);
  const address = port.localAddress;
  if (address === '127.0.0.1' || address === '::1' || address === 'localhost') {
    score += 45;
  } else if (address === '0.0.0.0' || address === '::' || address === '*') {
    score += 25;
  }
  if (port.process && INTERESTING_PROCESSES.some((name) => port.process!.toLowerCase().includes(name))) {
    score += 35;
  }
  if (port.port === 22) {
    score -= 100;
  }
  if (port.port < 1024) {
    score -= 25;
  }
  return score;
}

function scorePortNumber(port: number): number {
  if (DEV_PORTS.has(port)) {
    return 45;
  }
  if (port >= 3000 && port <= 9999) {
    return 25;
  }
  if (port >= 10000) {
    return 10;
  }
  return 0;
}

function remoteHostForLocalAddress(host: string): string {
  if (host === '::1') {
    return '::1';
  }
  return '127.0.0.1';
}

function normalizeDetectedHost(host: string): string {
  return host.replace(/^\[|\]$/g, '').toLowerCase();
}

function normalizeListeningAddress(address: string): string {
  if (address === '*' || address === '0.0.0.0') {
    return '0.0.0.0';
  }
  if (address === ':::' || address === '::') {
    return '::';
  }
  if (address.startsWith('::ffff:')) {
    return address.slice('::ffff:'.length);
  }
  return address.replace(/^\[|\]$/g, '');
}

function isLocalhostHost(host: string): boolean {
  return LOCALHOST_HOSTS.has(host) || LOCALHOST_HOSTS.has(`[${host}]`);
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
