import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KnownHosts } from '@main/ssh-config/KnownHosts';

const KEY_A = 'AAAAC3NzaC1lZDI1NTE5AAAAIaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_B = 'AAAAC3NzaC1lZDI1NTE5AAAAIbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ED25519 = 'ssh-ed25519';

describe('KnownHosts', () => {
  it('parses a literal hostname entry', () => {
    const kh = KnownHosts.fromText(`dev.example.com ${ED25519} ${KEY_A}\n`);
    expect(kh.size).toBe(1);
  });

  it('reports trusted for a matching host + key', () => {
    const kh = KnownHosts.fromText(`dev.example.com ${ED25519} ${KEY_A}\n`);
    const result = kh.verify('dev.example.com', ED25519, KEY_A);
    expect(result.trusted).toBe(true);
    expect(result.mismatch).toBe(false);
    expect(result.unknown).toBe(false);
  });

  it('reports mismatch when the host matches but the key differs', () => {
    const kh = KnownHosts.fromText(`dev.example.com ${ED25519} ${KEY_A}\n`);
    const result = kh.verify('dev.example.com', ED25519, KEY_B);
    expect(result.mismatch).toBe(true);
    expect(result.trusted).toBe(false);
  });

  it('reports unknown for a host with no entry', () => {
    const kh = KnownHosts.fromText(`dev.example.com ${ED25519} ${KEY_A}\n`);
    const result = kh.verify('other.example.com', ED25519, KEY_A);
    expect(result.unknown).toBe(true);
  });

  it('matches a wildcard (*.example.com) across dot-separated labels', () => {
    // OpenSSH: `*` matches any run of characters including dots, so
    // `*.example.com` matches both single- and multi-level subdomains.
    const kh = KnownHosts.fromText(`*.example.com ${ED25519} ${KEY_A}\n`);
    expect(kh.verify('dev.example.com', ED25519, KEY_A).trusted).toBe(true);
    expect(kh.verify('prod.example.com', ED25519, KEY_A).trusted).toBe(true);
    expect(kh.verify('a.b.example.com', ED25519, KEY_A).trusted).toBe(true);
    // a host that does not end in .example.com does not match
    expect(kh.verify('example.com', ED25519, KEY_A).trusted).toBe(false);
    expect(kh.verify('other.org', ED25519, KEY_A).unknown).toBe(true);
  });

  it('matches comma-separated host patterns', () => {
    const kh = KnownHosts.fromText(`a.com,b.com ${ED25519} ${KEY_A}\n`);
    expect(kh.verify('a.com', ED25519, KEY_A).trusted).toBe(true);
    expect(kh.verify('b.com', ED25519, KEY_A).trusted).toBe(true);
    expect(kh.verify('c.com', ED25519, KEY_A).unknown).toBe(true);
  });

  it('ignores comments, blank lines, and @revoked markers', () => {
    const text = `
# comment
@revoked evil.com ${ED25519} ${KEY_A}
@cert-authority *.ca.com ${ED25519} ${KEY_A}

good.com ${ED25519} ${KEY_A}
`;
    const kh = KnownHosts.fromText(text);
    expect(kh.size).toBe(1);
    expect(kh.verify('good.com', ED25519, KEY_A).trusted).toBe(true);
    expect(kh.verify('evil.com', ED25519, KEY_A).unknown).toBe(true);
    expect(kh.verify('x.ca.com', ED25519, KEY_A).unknown).toBe(true);
  });

  it('only matches when the key type agrees', () => {
    const kh = KnownHosts.fromText(`dev.com ${ED25519} ${KEY_A}\n`);
    // Same key bytes but different type label -> unknown (no matching type entry)
    const result = kh.verify('dev.com', 'ssh-rsa', KEY_A);
    expect(result.unknown).toBe(true);
  });

  it('add() then verify() trusts the new host', () => {
    const kh = KnownHosts.fromText('');
    expect(kh.verify('new.com', ED25519, KEY_A).unknown).toBe(true);
    kh.add('new.com', ED25519, KEY_A); // in-memory; path '' means no file write
    expect(kh.verify('new.com', ED25519, KEY_A).trusted).toBe(true);
    // A different key now mismatches (because the host is known)
    expect(kh.verify('new.com', ED25519, KEY_B).mismatch).toBe(true);
  });

  it('handles a hashed host entry (|1|salt|hash)', () => {
    // Generate a valid hashed entry for 'dev.example.com'.
    const salt = randomBytes(20);
    const hmac = createHmac('sha1', salt);
    hmac.update('dev.example.com');
    const hash = hmac.digest();
    const token = `|1|${salt.toString('base64')}|${hash.toString('base64')}`;
    const kh = KnownHosts.fromText(`${token} ${ED25519} ${KEY_A}\n`);
    expect(kh.verify('dev.example.com', ED25519, KEY_A).trusted).toBe(true);
    expect(kh.verify('other.example.com', ED25519, KEY_A).unknown).toBe(true);
  });
});
