import { describe, expect, it } from 'vitest';
import { APP_TITLE, windowTitle } from '../../src/shared/windowTitle';

describe('windowTitle', () => {
  it('is the bare app name when no host is connected', () => {
    expect(windowTitle(null)).toBe('PocketShell');
    expect(windowTitle(undefined)).toBe('PocketShell');
  });

  it('reads name · user@hostname — app for a named host', () => {
    expect(
      windowTitle({ name: 'hetzner', user: 'alexey', hostname: '135.181.114.209' }),
    ).toBe('hetzner · alexey@135.181.114.209 — PocketShell');
  });

  it('drops the user half when the config entry has none', () => {
    // ~/.ssh/config entries without `User` parse to '' (HostEntry.user is a
    // plain string), and `@host` with nothing before it is not an address.
    expect(windowTitle({ name: 'hetzner', user: '', hostname: '135.181.114.209' })).toBe(
      'hetzner · 135.181.114.209 — PocketShell',
    );
    expect(windowTitle({ name: 'hetzner', hostname: '135.181.114.209' })).toBe(
      'hetzner · 135.181.114.209 — PocketShell',
    );
  });

  it('does not say the address twice when the name IS the address', () => {
    // A manually-entered host gets a generated name — usually its hostname or
    // its full endpoint. Either way the name adds nothing over the endpoint.
    expect(
      windowTitle({ name: '135.181.114.209', user: 'alexey', hostname: '135.181.114.209' }),
    ).toBe('alexey@135.181.114.209 — PocketShell');
    expect(
      windowTitle({
        name: 'alexey@135.181.114.209',
        user: 'alexey',
        hostname: '135.181.114.209',
      }),
    ).toBe('alexey@135.181.114.209 — PocketShell');
  });

  it('treats a blank name as no name', () => {
    expect(windowTitle({ name: '   ', user: 'alexey', hostname: 'example.com' })).toBe(
      'alexey@example.com — PocketShell',
    );
  });

  it('exports the app title main falls back to', () => {
    expect(APP_TITLE).toBe('PocketShell');
  });
});
