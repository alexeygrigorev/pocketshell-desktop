/**
 * Unit tests for SSH config parser.
 *
 * Tests with fixture config strings (no file system required).
 */

import { describe, it, expect } from 'vitest';
import { parseSshConfigString, filterConcreteHosts } from '../../../src/ssh/data/ssh-config-parser';
import {
  resolveHostsFromConfig,
  resolveHostForConnection,
  getHostSkipReason,
  collectConcreteAliases,
  resolveHostForAlias,
  hostIdentityForAlias,
  stableHostIdFromAlias,
} from '../../../src/ssh/data/ssh-host-resolver';

describe('parseSshConfigString', () => {
  it('parses a simple Host block', () => {
    const config = `
Host myserver
  HostName 192.168.1.100
  Port 2222
  User admin
  IdentityFile ~/.ssh/id_rsa
`;
    const hosts = parseSshConfigString(config);

    expect(hosts).toHaveLength(1);
    expect(hosts[0].host).toBe('myserver');
    expect(hosts[0].hostname).toBe('192.168.1.100');
    expect(hosts[0].port).toBe(2222);
    expect(hosts[0].user).toBe('admin');
    expect(hosts[0].identityFile).toContain('.ssh/id_rsa');
  });

  it('parses multiple Host blocks', () => {
    const config = `
Host server1
  HostName 10.0.0.1
  User alice

Host server2
  HostName 10.0.0.2
  User bob
  Port 2222
`;
    const hosts = parseSshConfigString(config);

    expect(hosts).toHaveLength(2);
    expect(hosts[0].host).toBe('server1');
    expect(hosts[0].user).toBe('alice');
    expect(hosts[1].host).toBe('server2');
    expect(hosts[1].port).toBe(2222);
  });

  it('handles = separator', () => {
    const config = `
Host myhost
  HostName = example.com
  Port = 22
`;
    const hosts = parseSshConfigString(config);

    expect(hosts).toHaveLength(1);
    expect(hosts[0].hostname).toBe('example.com');
    expect(hosts[0].port).toBe(22);
  });

  it('handles quoted values', () => {
    const config = `
Host myhost
  HostName "example.com"
  IdentityFile "~/.ssh/my key"
`;
    const hosts = parseSshConfigString(config);

    expect(hosts).toHaveLength(1);
    expect(hosts[0].hostname).toBe('example.com');
    expect(hosts[0].identityFile).toContain('my key');
  });

  it('ignores comments and empty lines', () => {
    const config = `
# This is a comment

Host myhost
  # Inline comment
  HostName example.com  # end-of-line comment
  User testuser
`;
    const hosts = parseSshConfigString(config);

    expect(hosts).toHaveLength(1);
    expect(hosts[0].hostname).toBe('example.com');
    expect(hosts[0].user).toBe('testuser');
  });

  it('parses ProxyCommand', () => {
    const config = `
Host bastion
  HostName bastion.example.com
  ProxyCommand ssh -W %h:%p jumphost
`;
    const hosts = parseSshConfigString(config);

    expect(hosts).toHaveLength(1);
    expect(hosts[0].proxyCommand).toBe('ssh -W %h:%p jumphost');
  });

  it('parses ProxyJump', () => {
    const config = `
Host target
  HostName target.internal
  ProxyJump bastion
`;
    const hosts = parseSshConfigString(config);

    expect(hosts).toHaveLength(1);
    expect(hosts[0].proxyJump).toBe('bastion');
  });

  it('captures unknown directives in extra', () => {
    const config = `
Host myhost
  HostName example.com
  ServerAliveInterval 60
  ServerAliveCountMax 3
  AddKeysToAgent yes
`;
    const hosts = parseSshConfigString(config);

    expect(hosts).toHaveLength(1);
    expect(hosts[0].extra['serveraliveinterval']).toBe('60');
    expect(hosts[0].extra['serveralivecountmax']).toBe('3');
    expect(hosts[0].extra['addkeystoagent']).toBe('yes');
  });

  it('handles wildcard hosts', () => {
    const config = `
Host *
  ServerAliveInterval 60
  User defaultuser

Host *.example.com
  User wildcarduser
`;
    const hosts = parseSshConfigString(config);

    expect(hosts).toHaveLength(2);
    expect(hosts[0].host).toBe('*');
    expect(hosts[0].extra['serveraliveinterval']).toBe('60');
    expect(hosts[1].host).toBe('*.example.com');
    expect(hosts[1].user).toBe('wildcarduser');
  });

  it('splits multiple Host patterns', () => {
    const config = `
Host web api *.internal
  HostName shared.example.com
  User deploy
  IdentityFile ~/.ssh/deploy
`;
    const hosts = parseSshConfigString(config);

    expect(hosts).toHaveLength(1);
    expect(hosts[0].host).toBe('web api *.internal');
    expect(hosts[0].patterns).toEqual(['web', 'api', '*.internal']);
  });

  it('keeps all IdentityFile directives in order', () => {
    const config = `
Host myhost
  IdentityFile ~/.ssh/first
  IdentityFile ~/.ssh/second
`;
    const hosts = parseSshConfigString(config);

    expect(hosts[0].identityFiles).toHaveLength(2);
    expect(hosts[0].identityFile).toContain('.ssh/first');
    expect(hosts[0].identityFiles?.[1]).toContain('.ssh/second');
  });

  it('returns empty array for empty input', () => {
    expect(parseSshConfigString('')).toEqual([]);
    expect(parseSshConfigString('# only comments')).toEqual([]);
    expect(parseSshConfigString('\n\n\n')).toEqual([]);
  });

  it('ignores directives before first Host block', () => {
    const config = `
ServerAliveInterval 60

Host myhost
  HostName example.com
`;
    const hosts = parseSshConfigString(config);

    expect(hosts).toHaveLength(1);
    expect(hosts[0].hostname).toBe('example.com');
  });

  it('expands ~ in IdentityFile paths', () => {
    const config = `
Host myhost
  IdentityFile ~/.ssh/custom_key
`;
    const hosts = parseSshConfigString(config);

    expect(hosts[0].identityFile).not.toContain('~');
    expect(hosts[0].identityFile).toContain('.ssh/custom_key');
  });

  it('strictly rejects invalid Port values', () => {
    const hosts = parseSshConfigString(`
Host partial
  Port 22abc

Host zero
  Port 0

Host negative
  Port -1

Host too-high
  Port 65536
`);

    expect(hosts.map(host => host.invalidPort)).toEqual(['22abc', '0', '-1', '65536']);
    expect(hosts.map(host => host.port)).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe('resolveHostsFromConfig (live host list)', () => {
  it('builds usable hosts from concrete SSH config entries, no copy', () => {
    const parsed = parseSshConfigString(`
Host prod
  HostName prod.example.com
  Port 2222
  User deploy
  IdentityFile ~/.ssh/prod
`);
    const { hosts, skipped } = resolveHostsFromConfig(parsed, { defaultUsername: 'local' });

    expect(skipped).toEqual([]);
    expect(hosts).toHaveLength(1);
    expect(hosts[0].host).toMatchObject({
      name: 'prod',
      hostname: 'prod.example.com',
      port: 2222,
      username: 'deploy',
      keyPath: expect.stringContaining('.ssh/prod'),
      maxAutoPort: 10000,
      skipPortsBelow: 1000,
      scanIntervalSec: 5,
      enabled: true,
    });
    expect(hosts[0].alias).toBe('prod');
    expect(hosts[0].identity).toBe(hostIdentityForAlias('prod'));
  });

  it('uses alias as hostname and default username/port when OpenSSH would', () => {
    const parsed = parseSshConfigString(`
Host staging
  IdentityFile ~/.ssh/staging
`);
    const { hosts } = resolveHostsFromConfig(parsed, { defaultUsername: 'alice' });

    expect(hosts[0].host).toMatchObject({
      name: 'staging',
      hostname: 'staging',
      port: 22,
      username: 'alice',
    });
  });

  it('merges matching Host blocks using OpenSSH first-value-wins semantics', () => {
    const parsed = parseSshConfigString(`
Host prod
  HostName prod.example.com

Host *
  User deploy
  IdentityFile ~/.ssh/id_ed25519
`);
    const { hosts, skipped } = resolveHostsFromConfig(parsed, { defaultUsername: 'local' });

    expect(hosts).toHaveLength(1);
    expect(hosts[0].host).toMatchObject({
      name: 'prod',
      hostname: 'prod.example.com',
      port: 22,
      username: 'deploy',
    });
    expect(hosts[0].host.keyPath).toContain('.ssh/id_ed25519');
    // The wildcard block is reported as skipped, not silently dropped.
    expect(skipped.map(s => s.alias)).toContain('*');
  });

  it('keeps earlier host-specific scalars before later wildcard defaults', () => {
    const parsed = parseSshConfigString(`
Host prod
  HostName prod.example.com
  User root
  Port 2200

Host *
  HostName fallback.example.com
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_ed25519
`);
    const { hosts } = resolveHostsFromConfig(parsed, { defaultUsername: 'local' });

    expect(hosts[0].host).toMatchObject({
      name: 'prod',
      hostname: 'prod.example.com',
      port: 2200,
      username: 'root',
    });
  });

  it('reports wildcard, missing-key, proxy, token, bad-port, and none entries as skipped', () => {
    const parsed = parseSshConfigString(`
Host *.example.com
  IdentityFile ~/.ssh/id_ed25519

Host no-key
  HostName no-key.example.com
  User user

Host via-bastion
  HostName private.example.com
  User user
  IdentityFile ~/.ssh/private
  ProxyJump bastion

Host token-key
  HostName token.example.com
  User user
  IdentityFile ~/.ssh/%h

Host bad-port
  HostName bad.example.com
  Port not-a-number
  User user
  IdentityFile ~/.ssh/bad

Host no-identity
  HostName disabled.example.com
  User user
  IdentityFile none
`);
    const { hosts, skipped } = resolveHostsFromConfig(parsed, { defaultUsername: 'local' });

    expect(hosts).toEqual([]);
    expect(skipped.map(s => s.alias)).toEqual([
      '*.example.com',
      'no-key',
      'via-bastion',
      'token-key',
      'bad-port',
      'no-identity',
    ]);
    expect(skipped.map(s => s.reason)).toEqual([
      expect.stringContaining('wildcard'),
      expect.stringContaining('IdentityFile is required'),
      expect.stringContaining('ProxyJump is not supported'),
      expect.stringContaining('percent tokens'),
      expect.stringContaining('Port is invalid'),
      expect.stringContaining('IdentityFile none'),
    ]);
  });

  it('skips hosts with invalid effective Port values', () => {
    const parsed = parseSshConfigString(`
Host partial
  Port 22abc
  User user
  IdentityFile ~/.ssh/partial

Host zero
  Port 0
  User user
  IdentityFile ~/.ssh/zero

Host negative
  Port -1
  User user
  IdentityFile ~/.ssh/negative

Host too-high
  Port 65536
  User user
  IdentityFile ~/.ssh/too-high
`);
    const { hosts, skipped } = resolveHostsFromConfig(parsed, { defaultUsername: 'local' });

    expect(hosts).toEqual([]);
    expect(skipped.map(s => s.alias)).toEqual([
      'partial',
      'zero',
      'negative',
      'too-high',
    ]);
    expect(skipped.map(s => s.reason)).toEqual([
      'Port is invalid (22abc)',
      'Port is invalid (0)',
      'Port is invalid (-1)',
      'Port is invalid (65536)',
    ]);
  });

  it('does not duplicate a host that appears twice (alias de-dup)', () => {
    const parsed = parseSshConfigString(`
Host first
  HostName same.example.com
  User deploy
  IdentityFile ~/.ssh/same

Host second
  HostName same.example.com
  User deploy
  IdentityFile ~/.ssh/same
`);
    const { hosts } = resolveHostsFromConfig(parsed, { defaultUsername: 'local' });

    // Both aliases are distinct concrete hosts (different aliases), so both
    // appear - the live model keys by alias, not by connection tuple.
    expect(hosts.map(h => h.alias)).toEqual(['first', 'second']);
  });

  it('merges stored metadata into the live host', () => {
    const parsed = parseSshConfigString(`
Host prod
  HostName prod.example.com
  User deploy
  IdentityFile ~/.ssh/prod
`);
    const metadata = new Map([
      [
        hostIdentityForAlias('prod'),
        {
          identity: hostIdentityForAlias('prod'),
          alias: 'prod',
          maxAutoPort: 33333,
          skipPortsBelow: 200,
          scanIntervalSec: 9,
          enabled: false,
          createdAt: 123,
          lastConnectedAt: 456,
          tmuxInstalled: true,
          lastBootstrapAt: null,
          pocketshellInstalled: null,
          pocketshellLastDetectedAt: null,
          pocketshellCliVersion: '1.2.3',
          pocketshellExpectedCliVersion: null,
          pocketshellVersionCompatible: null,
          pocketshellDaemonRunning: null,
          pocketshellDaemonEnabled: null,
          usageCommandOverride: null,
          claudeProfilesJson: null,
          codexProfilesJson: null,
        },
      ],
    ]);

    const { hosts } = resolveHostsFromConfig(parsed, { defaultUsername: 'local', metadata });
    expect(hosts[0].host).toMatchObject({
      maxAutoPort: 33333,
      skipPortsBelow: 200,
      scanIntervalSec: 9,
      enabled: false,
      lastConnectedAt: 456,
      tmuxInstalled: true,
      pocketshellCliVersion: '1.2.3',
    });
    // Connection details still come from the config, not the store.
    expect(hosts[0].host.hostname).toBe('prod.example.com');
    expect(hosts[0].host.username).toBe('deploy');
  });
});

describe('host identity + stability', () => {
  it('stable ids are deterministic and positive for the same alias', () => {
    const a = stableHostIdFromAlias('prod');
    const b = stableHostIdFromAlias('prod');
    const c = stableHostIdFromAlias('staging');
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
    expect(a).not.toBe(c);
  });

  it('collectConcreteAliases separates concrete aliases from wildcards', () => {
    const parsed = parseSshConfigString(`
Host prod
  HostName prod.example.com
Host *
  User deploy
`);
    const { aliases, wildcards } = collectConcreteAliases(parsed);
    expect(aliases.map(a => a.alias)).toEqual(['prod']);
    expect(wildcards).toHaveLength(1);
  });
});

describe('resolveHostForConnection (connect-time resolution)', () => {
  it('resolves a usable alias live from the config', () => {
    const parsed = parseSshConfigString(`
Host prod
  HostName prod.example.com
  Port 2222
  User deploy
  IdentityFile ~/.ssh/prod
`);
    const host = resolveHostForConnection('prod', parsed, { defaultUsername: 'local' });
    expect(host).toMatchObject({
      name: 'prod',
      hostname: 'prod.example.com',
      port: 2222,
      username: 'deploy',
    });
    expect(host.id).toBe(stableHostIdFromAlias('prod'));
  });

  it('throws for an absent alias', () => {
    const parsed = parseSshConfigString(`Host prod
  HostName prod.example.com
  IdentityFile ~/.ssh/prod
`);
    expect(() => resolveHostForConnection('ghost', parsed)).toThrow(/not present/);
  });

  it('throws with the skip reason for an unusable alias', () => {
    const parsed = parseSshConfigString(`Host via-bastion
  HostName private.example.com
  IdentityFile ~/.ssh/private
  ProxyJump bastion
`);
    expect(() => resolveHostForConnection('via-bastion', parsed)).toThrow(/ProxyJump/);
  });
});

describe('getHostSkipReason (preserved usability helper)', () => {
  it('returns undefined for a fully-specified host', () => {
    const parsed = parseSshConfigString(`Host ok
  HostName ok.example.com
  User user
  IdentityFile ~/.ssh/ok
`);
    const resolved = resolveHostForAlias('ok', parsed, parsed[0]);
    expect(getHostSkipReason('ok', resolved, { defaultUsername: 'local' })).toBeUndefined();
  });
});

describe('filterConcreteHosts', () => {
  it('filters out wildcard hosts', () => {
    const config = `
Host *
  User default

Host server1
  HostName 10.0.0.1

Host *.example.com
  User wildcard

Host server2
  HostName 10.0.0.2
`;
    const hosts = parseSshConfigString(config);
    const concrete = filterConcreteHosts(hosts);

    expect(concrete).toHaveLength(2);
    expect(concrete[0].host).toBe('server1');
    expect(concrete[1].host).toBe('server2');
  });

  it('returns all hosts if none use wildcards', () => {
    const config = `
Host server1
  HostName 10.0.0.1

Host server2
  HostName 10.0.0.2
`;
    const hosts = parseSshConfigString(config);
    const concrete = filterConcreteHosts(hosts);

    expect(concrete).toHaveLength(2);
  });

  it('returns empty array for all-wildcard config', () => {
    const config = `
Host *
  User default
`;
    const hosts = parseSshConfigString(config);
    const concrete = filterConcreteHosts(hosts);

    expect(concrete).toHaveLength(0);
  });
});
