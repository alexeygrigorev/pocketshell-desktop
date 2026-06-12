/**
 * Unit tests for SSH config parser.
 *
 * Tests with fixture config strings (no file system required).
 */

import { describe, it, expect } from 'vitest';
import { parseSshConfigString, filterConcreteHosts } from '../../../src/ssh/data/ssh-config-parser';

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
