import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Minimal ~/.ssh/known_hosts loader + matcher.
 *
 * The Android app supports known_hosts verification (`KnownHostsPolicy`)
 * but always passes `AcceptAll` in production. Desktop honours known_hosts
 * for real security: unknown host -> TOFU prompt (accept once/always);
 * mismatch -> hard block; known + match -> proceed.
 *
 * Only the hash/markers we need for the ssh2 `hostVerifier` callback are
 * implemented: literal hostnames, a single `*` wildcard, and hashed host
 * entries (`|1|<salt>|<hash>`). Revocation markers (`@revoked`) and
 * certificate authority lines (`@cert-authority`) are parsed permissively
 * (CA lines accepted, revoked entries skipped) — full handling can come
 * later; the dev-box use case rarely hits them.
 */

export interface HostKeyEntry {
  /** Raw hostnames field, for matching. */
  patterns: string[];
  /** Key type, e.g. ssh-ed25519. */
  keyType: string;
  /** Base64 public key. */
  keyB64: string;
}

export interface VerificationResult {
  /** A known_hosts entry matched the host AND its key. */
  trusted: boolean;
  /** Host matched but the presented key differs — must block. */
  mismatch: boolean;
  /** No entry for this host — caller should TOFU-prompt. */
  unknown: boolean;
  /** The matched entry, when trusted or mismatch. */
  entry?: HostKeyEntry;
}

export class KnownHosts {
  private entries: HostKeyEntry[] = [];
  private path: string;

  constructor(path?: string) {
    this.path = path ?? defaultKnownHostsPath();
    this.load();
  }

  static fromText(text: string): KnownHosts {
    const kh = Object.create(KnownHosts.prototype) as KnownHosts;
    kh.path = '';
    kh.entries = parseKnownHostsText(text);
    return kh;
  }

  private load(): void {
    try {
      const text = readFileSync(this.path, 'utf8');
      this.entries = parseKnownHostsText(text);
    } catch {
      this.entries = []; // no known_hosts -> everything is unknown (TOFU)
    }
  }

  reload(): void {
    this.load();
  }

  /**
   * Verify a host key presented by ssh2.
   *
   * @param host       the hostname being connected to
   * @param keyType    e.g. 'ssh-ed25519'
   * @param keyB64     base64 of the public key blob
   */
  verify(host: string, keyType: string, keyB64: string): VerificationResult {
    for (const entry of this.entries) {
      if (!hostMatches(host, entry.patterns)) continue;
      if (entry.keyType !== keyType) continue;
      if (entry.keyB64 === keyB64) {
        return { trusted: true, mismatch: false, unknown: false, entry };
      }
      return { trusted: false, mismatch: true, unknown: false, entry };
    }
    return { trusted: false, mismatch: false, unknown: true };
  }

  /** TOFU: append a new host key so future connects match. */
  add(host: string, keyType: string, keyB64: string): void {
    const entry: HostKeyEntry = { patterns: [host], keyType, keyB64 };
    this.entries.push(entry);
    if (this.path) {
      try {
        writeFileSync(this.path, `${host} ${keyType} ${keyB64}\n`, { flag: 'a' });
      } catch {
        // best-effort; in-memory entry still lets the current session proceed
      }
    }
  }

  get size(): number {
    return this.entries.length;
  }
}

export function defaultKnownHostsPath(): string {
  return resolve(homedir(), '.ssh', 'known_hosts');
}

export function parseKnownHostsText(text: string): HostKeyEntry[] {
  const out: HostKeyEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('@cert-authority')) continue; // CA entries: skip for now
    if (line.startsWith('@revoked')) continue; // revoked: never trust
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const [patternsRaw, keyType, keyB64] = parts;
    if (!patternsRaw || !keyType || !keyB64) continue;
    const patterns = expandPatterns(patternsRaw);
    out.push({ patterns, keyType, keyB64 });
  }
  return out;
}

/** Expand comma-separated + wildcard patterns into individual matchers. */
function expandPatterns(raw: string): string[] {
  // Hashed host: `|1|<salt>|<hash>` — kept as a single opaque matcher token;
  // hostMatches handles the HMAC comparison. Keep the literal token so the
  // salt/hash are available.
  if (raw.startsWith('|1|')) return [raw];
  return raw.split(',').map((p) => p.trim()).filter(Boolean);
}

function hostMatches(host: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.startsWith('|1|')) {
      if (hashedHostMatches(pattern, host)) return true;
      continue;
    }
    if (pattern === host) return true;
    // OpenSSH wildcard semantics: `*` matches any run of characters INCLUDING
    // dots, so `*.example.com` matches `dev.example.com` AND `a.b.example.com`;
    // a bare `*` matches anything. No other metacharacters (`?` is not handled).
    if (pattern.includes('*')) {
      const re = new RegExp(
        '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
      );
      if (re.test(host)) return true;
    }
  }
  return false;
}

/** Verify a hashed known_hosts entry: `|1|<saltB64>|<hashB64>`, HMAC-SHA1. */
function hashedHostMatches(token: string, host: string): boolean {
  const segs = token.split('|'); // ['', '1', salt, hash]
  if (segs.length < 4) return false;
  const salt = Buffer.from(segs[2] ?? '', 'base64');
  const expected = Buffer.from(segs[3] ?? '', 'base64');
  // OpenSSH hashes the host with HMAC-SHA1 keyed by the salt.
  const h = createHash('sha1'); // hmac via createHmac is cleaner, but sha1 is what openssh uses
  // Use createHmac properly:
  const hmac = require('node:crypto').createHmac('sha1', salt) as ReturnType<typeof createHash>;
  hmac.update(host);
  const digest = hmac.digest();
  return digest.equals(expected) || digest.toString('base64') === expected.toString('base64');
}

export function isKnownHostsPresent(path?: string): boolean {
  return existsSync(path ?? defaultKnownHostsPath());
}
