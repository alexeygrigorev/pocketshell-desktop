/**
 * Unit tests for the pure ~/.ssh/config editing helpers.
 */

import { describe, it, expect } from 'vitest';
import { formatHostStanza, patchIdentityFileForAlias } from '../../../src/ssh/data/ssh-config-writer';
import type { NewHost } from '../../../src/ssh/data/host-store';

function newHost(over: Partial<NewHost> = {}): NewHost {
  return {
    name: 'prod',
    hostname: 'prod.example.com',
    port: 22,
    username: 'deploy',
    keyPath: '~/.ssh/id_rsa',
    maxAutoPort: 10000,
    skipPortsBelow: 1000,
    scanIntervalSec: 5,
    enabled: true,
    ...over,
  };
}

describe('formatHostStanza', () => {
  it('formats a Host stanza with all connection fields', () => {
    const stanza = formatHostStanza(newHost());
    expect(stanza).toContain('Host prod');
    expect(stanza).toContain('HostName prod.example.com');
    expect(stanza).toContain('Port 22');
    expect(stanza).toContain('User deploy');
    expect(stanza).toContain('IdentityFile ~/.ssh/id_rsa');
  });

  it('uses the hostname as the alias when no name is given', () => {
    const stanza = formatHostStanza(newHost({ name: '' }));
    expect(stanza).toContain('Host prod.example.com');
  });
});

describe('patchIdentityFileForAlias', () => {
  it('updates an existing IdentityFile in the matching block only', () => {
    const config = `Host prod
  HostName prod.example.com
  IdentityFile ~/.ssh/old

Host staging
  HostName staging.example.com
  IdentityFile ~/.ssh/staging
`;
    const patched = patchIdentityFileForAlias(config, 'prod', '/managed/keys/prod');
    expect(patched).toContain('IdentityFile /managed/keys/prod');
    // The other host is untouched.
    expect(patched).toContain('IdentityFile ~/.ssh/staging');
    expect(patched).not.toContain('~/.ssh/old');
  });

  it('inserts an IdentityFile when the block has none', () => {
    const config = `Host prod
  HostName prod.example.com
  User deploy
`;
    const patched = patchIdentityFileForAlias(config, 'prod', '~/.ssh/new');
    expect(patched.split('\n')[1].trim()).toBe('IdentityFile ~/.ssh/new');
  });

  it('returns the text unchanged when no matching block exists', () => {
    const config = `Host other
  IdentityFile ~/.ssh/other
`;
    expect(patchIdentityFileForAlias(config, 'prod', '~/.ssh/x')).toBe(config);
  });

  it('does not match wildcard or negated patterns', () => {
    const config = `Host *.example.com
  IdentityFile ~/.ssh/wild
`;
    expect(patchIdentityFileForAlias(config, 'prod.example.com', '~/.ssh/x')).toBe(config);
  });
});
