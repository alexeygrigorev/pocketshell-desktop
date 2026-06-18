import { describe, expect, it } from 'vitest';
import { parseSshConfigText } from '@main/ssh-config/SshConfigParser';
import type { HostEntry } from '../../src/shared/types';

describe('SshConfigParser', () => {
  it('parses a basic Host block with all common directives', () => {
    const text = `
Host dev
  HostName dev.example.com
  Port 2222
  User alex
  IdentityFile ~/.ssh/dev_key
  ForwardAgent yes
`;
    const hosts = parseSshConfigText(text);
    expect(hosts).toHaveLength(1);
    const dev = hosts[0]!;
    expect(dev.name).toBe('dev');
    expect(dev.hostname).toBe('dev.example.com');
    expect(dev.port).toBe(2222);
    expect(dev.user).toBe('alex');
    expect(dev.identityFile).toMatch(/\.ssh[\\/]dev_key$/);
    expect(dev.forwardAgent).toBe(true);
    expect(dev.fromConfig).toBe(true);
  });

  it('falls back to the Host name as hostname when HostName is absent', () => {
    const hosts = parseSshConfigText('Host mybox\n  User root\n');
    expect(hosts).toHaveLength(1);
    expect(hosts[0]!.hostname).toBe('mybox');
    expect(hosts[0]!.port).toBe(22); // default
    expect(hosts[0]!.user).toBe('root');
  });

  it('expands a Host directive with multiple names into separate entries', () => {
    const hosts = parseSshConfigText('Host a b c\n  HostName h\n');
    expect(hosts.map((h: HostEntry) => h.name)).toEqual(['a', 'b', 'c']);
    expect(hosts.every((h: HostEntry) => h.hostname === 'h')).toBe(true);
  });

  it('ignores comments and blank lines', () => {
    const text = `
# a comment
   # indented comment

Host real
  HostName real.example.com
`;
    const hosts = parseSshConfigText(text);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]!.name).toBe('real');
  });

  it('parses ProxyJump', () => {
    const hosts = parseSshConfigText('Host h\n  ProxyJump jump.example.com\n');
    expect(hosts[0]!.proxyJump).toBe('jump.example.com');
  });

  it('parses LocalForward and RemoteForward (two-token form)', () => {
    const text = `
Host h
  LocalForward 8080 localhost:80
  RemoteForward 9090 remotehost:90
`;
    const h = parseSshConfigText(text)[0]!;
    expect(h.localForwards).toEqual([
      { kind: 'local', listenHost: '127.0.0.1', listenPort: 8080, destHost: 'localhost', destPort: 80 },
    ]);
    expect(h.remoteForwards).toEqual([
      { kind: 'remote', listenHost: '127.0.0.1', listenPort: 9090, destHost: 'remotehost', destPort: 90 },
    ]);
  });

  it('lower-cases directive keys (SSH config is case-insensitive on keys)', () => {
    const hosts = parseSshConfigText('Host H\n  HOSTNAME example.com\n  PORT 23\n');
    expect(hosts[0]!.hostname).toBe('example.com');
    expect(hosts[0]!.port).toBe(23);
  });

  it('handles a malformed port by falling back to 22', () => {
    const hosts = parseSshConfigText('Host h\n  Port notanumber\n');
    expect(hosts[0]!.port).toBe(22);
  });

  it('preserves directive order across multiple Host blocks', () => {
    const text = `
Host first
  HostName first.com
Host second
  HostName second.com
  Port 2200
`;
    const hosts = parseSshConfigText(text);
    expect(hosts.map((h: HostEntry) => h.name)).toEqual(['first', 'second']);
    expect(hosts[1]!.port).toBe(2200);
  });

  it('returns an empty array for empty input', () => {
    expect(parseSshConfigText('')).toEqual([]);
    expect(parseSshConfigText('   \n# only comments\n')).toEqual([]);
  });

  it('parses an IPv6 listen address in a forward', () => {
    const hosts = parseSshConfigText('Host h\n  LocalForward [::1]:8080 localhost:80\n');
    expect(hosts[0]!.localForwards[0]!.listenHost).toBe('::1');
    expect(hosts[0]!.localForwards[0]!.listenPort).toBe(8080);
  });

  it('expands ~ in IdentityFile', () => {
    const hosts = parseSshConfigText('Host h\n  IdentityFile ~/.ssh/id_ed25519\n');
    // Exact path depends on the OS home dir, but it must be absolute and end with the key name.
    expect(hosts[0]!.identityFile).toMatch(/[\\/]id_ed25519$/);
    expect(hosts[0]!.identityFile).not.toContain('~');
  });
});
