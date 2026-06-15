/**
 * Unit tests for SSH config parser.
 *
 * Tests with fixture config strings (no file system required).
 */

import { describe, it, expect } from 'vitest';
import { parseSshConfigString, filterConcreteHosts } from '../../../src/ssh/data/ssh-config-parser';
import { createSshConfigImportPlan } from '../../../src/ssh/data/ssh-config-import';

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

describe('createSshConfigImportPlan', () => {
  it('creates PocketShell hosts from concrete SSH config entries', () => {
    const parsed = parseSshConfigString(`
Host prod
  HostName prod.example.com
  Port 2222
  User deploy
  IdentityFile ~/.ssh/prod
`);
    const plan = createSshConfigImportPlan(parsed, [], { defaultUsername: 'local' });

    expect(plan.skipped).toEqual([]);
    expect(plan.importable).toHaveLength(1);
    expect(plan.importable[0].host).toMatchObject({
      name: 'prod',
      hostname: 'prod.example.com',
      port: 2222,
      username: 'deploy',
      maxAutoPort: 10000,
      skipPortsBelow: 1000,
      scanIntervalSec: 5,
      enabled: true,
    });
    expect(plan.importable[0].host.keyPath).toContain('.ssh/prod');
  });

  it('uses alias, default port, and default username when OpenSSH would', () => {
    const parsed = parseSshConfigString(`
Host staging
  IdentityFile ~/.ssh/staging
`);
    const plan = createSshConfigImportPlan(parsed, [], { defaultUsername: 'alice' });

    expect(plan.importable[0].host).toMatchObject({
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
    const plan = createSshConfigImportPlan(parsed, [], { defaultUsername: 'local' });

    expect(plan.importable).toHaveLength(1);
    expect(plan.importable[0].host).toMatchObject({
      name: 'prod',
      hostname: 'prod.example.com',
      port: 22,
      username: 'deploy',
    });
    expect(plan.importable[0].host.keyPath).toContain('.ssh/id_ed25519');
    expect(plan.skipped.map(entry => entry.alias)).toEqual(['*']);
  });

  it('keeps earlier host-specific scalar values before later wildcard defaults', () => {
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
    const plan = createSshConfigImportPlan(parsed, [], { defaultUsername: 'local' });

    expect(plan.importable[0].host).toMatchObject({
      name: 'prod',
      hostname: 'prod.example.com',
      port: 2200,
      username: 'root',
    });
  });

  it('skips wildcard entries, missing keys, proxy entries, and tokenized keys clearly', () => {
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
    const plan = createSshConfigImportPlan(parsed, [], { defaultUsername: 'local' });

    expect(plan.importable).toEqual([]);
    expect(plan.skipped.map(entry => entry.alias)).toEqual([
      '*.example.com',
      'no-key',
      'via-bastion',
      'token-key',
      'bad-port',
      'no-identity',
    ]);
    expect(plan.skipped.map(entry => entry.reason)).toEqual([
      expect.stringContaining('wildcard'),
      expect.stringContaining('IdentityFile is required'),
      expect.stringContaining('ProxyJump is not supported'),
      expect.stringContaining('percent tokens'),
      expect.stringContaining('Port is invalid'),
      expect.stringContaining('IdentityFile none'),
    ]);
    expect(plan.skipped[2].proxyMetadata).toBe('ProxyJump bastion');
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
    const plan = createSshConfigImportPlan(parsed, [], { defaultUsername: 'local' });

    expect(plan.importable).toEqual([]);
    expect(plan.skipped.map(entry => entry.alias)).toEqual(['partial', 'zero', 'negative', 'too-high']);
    expect(plan.skipped.map(entry => entry.reason)).toEqual([
      'Port is invalid (22abc)',
      'Port is invalid (0)',
      'Port is invalid (-1)',
      'Port is invalid (65536)',
    ]);
  });

  it('skips duplicate existing hosts by connection tuple or name', () => {
    const parsed = parseSshConfigString(`
Host same-connection
  HostName existing.example.com
  User deploy
  IdentityFile ~/.ssh/existing

Host existing-name
  HostName other.example.com
  User deploy
  IdentityFile ~/.ssh/other

Host new-host
  HostName new.example.com
  User deploy
  IdentityFile ~/.ssh/new
`);
    const existing = [
      {
        name: 'existing-name',
        hostname: 'existing.example.com',
        port: 22,
        username: 'deploy',
        keyPath: parsed[0].identityFile!,
      },
    ];
    const plan = createSshConfigImportPlan(parsed, existing, { defaultUsername: 'local' });

    expect(plan.importable.map(entry => entry.alias)).toEqual(['new-host']);
    expect(plan.skipped.map(entry => entry.alias)).toEqual(['same-connection', 'existing-name']);
    expect(plan.skipped[0].reason).toContain('same hostname');
    expect(plan.skipped[1].reason).toContain('same host name');
  });

  it('skips duplicate hosts within the same config file', () => {
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
    const plan = createSshConfigImportPlan(parsed, [], { defaultUsername: 'local' });

    expect(plan.importable.map(entry => entry.alias)).toEqual(['first']);
    expect(plan.skipped.map(entry => entry.alias)).toEqual(['second']);
    expect(plan.skipped[0].reason).toContain('same hostname');
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
