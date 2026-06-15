import { describe, expect, it } from 'vitest';
import {
  PortForwardError,
  buildPortForwardPanelModel,
  formatLocalUrl,
  normalizePortForwardOpenArgs,
  renderPortForwardHtml,
  resolveActivePortForwardLocalUrl,
  validatePortForwardInput,
  type ActivePortForward,
  type SavedPortForwardPanelMapping,
} from '../../../src/port-forwarding';

const host = {
  id: 7,
  name: 'Dev Host',
  hostname: 'dev.example.com',
  username: 'alex',
  port: 22,
};

describe('port forwarding panel model', () => {
  it('merges saved mappings with active tunnels for the selected host', () => {
    const saved: SavedPortForwardPanelMapping[] = [
      {
        id: 'web',
        hostId: 7,
        name: 'Web',
        localHost: '127.0.0.1',
        remoteHost: '127.0.0.1',
        remotePort: 3000,
      },
      {
        id: 'api',
        hostId: 7,
        name: 'API',
        localHost: '127.0.0.1',
        localPort: 9000,
        remoteHost: '127.0.0.1',
        remotePort: 9000,
      },
    ];
    const active = [
      activeForward({ id: 'web', hostId: 7, name: 'Web', localPort: 43000, remotePort: 3000 }),
      activeForward({ id: 'unsaved', hostId: 7, localPort: 4545, remotePort: 4545 }),
      activeForward({ id: 'other-host', hostId: 8, localPort: 8080, remotePort: 8080 }),
    ];

    const model = buildPortForwardPanelModel({
      host,
      savedForwards: saved,
      activeForwards: active,
    });

    expect(model.rows.map((row) => row.rowId)).toEqual(['web', 'unsaved', 'api']);
    expect(model.rows[0]).toMatchObject({
      savedId: 'web',
      activeId: 'web',
      statusLabel: 'Listening',
      localUrl: 'http://127.0.0.1:43000',
      canStart: false,
      canStop: true,
      canEdit: true,
    });
    expect(model.rows[1]).toMatchObject({
      savedId: undefined,
      activeId: 'unsaved',
      canEdit: false,
      canDelete: false,
      canStop: true,
    });
    expect(model.rows[2]).toMatchObject({
      savedId: 'api',
      activeId: undefined,
      statusLabel: 'Saved',
      canStart: true,
      canStop: false,
    });
  });

  it('uses saved values for edit forms when a saved auto-port mapping is active', () => {
    const model = buildPortForwardPanelModel({
      host,
      savedForwards: [
        {
          id: 'web',
          hostId: 7,
          name: 'Web',
          localHost: '127.0.0.1',
          remoteHost: '127.0.0.1',
          remotePort: 3000,
        },
      ],
      activeForwards: [
        activeForward({ id: 'web', localPort: 49152, remotePort: 3000 }),
      ],
    });

    expect(model.rows[0]).toMatchObject({
      localPort: 49152,
      localUrl: 'http://127.0.0.1:49152',
      editForm: {
        id: 'web',
        name: 'Web',
        localHost: '127.0.0.1',
        localPort: undefined,
        remoteHost: '127.0.0.1',
        remotePort: 3000,
      },
    });

    const html = renderPortForwardHtml(model);
    expect(html).toContain('setForm(row.editForm ?? {})');
    expect(html).toContain('vscode.postMessage({ action, savedId: row.savedId, activeId: row.activeId })');
    expect(html).not.toContain('url: row.localUrl');
  });

  it('formats local URLs only once the tunnel is listening', () => {
    expect(formatLocalUrl(activeForward({ localHost: '0.0.0.0', localPort: 3000 }))).toBe('http://localhost:3000');
    expect(formatLocalUrl(activeForward({ localPort: 8443 }), 'https')).toBe('https://127.0.0.1:8443');
    expect(formatLocalUrl(activeForward({ localHost: '::1', localPort: 3000 }))).toBe('http://[::1]:3000');
    expect(formatLocalUrl(activeForward({ state: 'starting', localPort: 3000 }))).toBeUndefined();
    expect(formatLocalUrl(activeForward({ localPort: 0 }))).toBeUndefined();
  });

  it('derives local URLs from active tunnel state and host ownership', () => {
    const active = [
      activeForward({ id: 'web', hostId: 7, localPort: 3000 }),
      activeForward({ id: 'other-host', hostId: 8, localPort: 4000 }),
      activeForward({ id: 'starting', hostId: 7, state: 'starting', localPort: 5000 }),
    ];

    expect(resolveActivePortForwardLocalUrl(active, 7, 'web')).toBe('http://127.0.0.1:3000');
    expect(resolveActivePortForwardLocalUrl(active, 7, 'other-host')).toBeUndefined();
    expect(resolveActivePortForwardLocalUrl(active, 7, 'starting')).toBeUndefined();
    expect(resolveActivePortForwardLocalUrl(active, 7, undefined)).toBeUndefined();
  });

  it('validates and normalizes saved mapping input', () => {
    const valid = validatePortForwardInput({
      id: ' web ',
      name: '  Web UI ',
      remoteHost: ' 127.0.0.1 ',
      remotePort: '3000',
      localHost: '127.0.0.1',
      localPort: '',
    }, 7);

    expect(valid.ok).toBe(true);
    expect(valid.value).toEqual({
      id: 'web',
      hostId: 7,
      name: 'Web UI',
      localHost: '127.0.0.1',
      localPort: undefined,
      remoteHost: '127.0.0.1',
      remotePort: 3000,
    });

    const invalid = validatePortForwardInput({
      remoteHost: '',
      remotePort: 70000,
      localHost: '',
      localPort: 'abc',
    }, 7);
    expect(invalid.ok).toBe(false);
    expect(invalid.errors).toEqual([
      'Remote host is required.',
      'Local host is required.',
      'Remote port must be between 1 and 65535.',
      'Local port must be blank or between 1 and 65535.',
    ]);
  });

  it('normalizes remote-port prefill command arguments', () => {
    expect(normalizePortForwardOpenArgs({
      hostId: 7,
      remotePort: '5173',
      localPort: '3000',
      name: 'Vite',
      start: true,
      openInBrowser: true,
      openProtocol: 'https',
    })).toEqual({
      hostId: 7,
      start: true,
      openInBrowser: true,
      openProtocol: 'https',
      prefill: {
        id: undefined,
        name: 'Vite',
        localHost: '127.0.0.1',
        localPort: 3000,
        remoteHost: '127.0.0.1',
        remotePort: 5173,
      },
    });

    expect(normalizePortForwardOpenArgs({
      prefill: {
        port: 8080,
        remoteHost: 'localhost',
        protocol: 'ftp',
      },
      openBrowser: true,
    }).prefill).toMatchObject({
      remoteHost: 'localhost',
      remotePort: 8080,
    });
    expect(normalizePortForwardOpenArgs({ openProtocol: 'ftp' }).openProtocol).toBeUndefined();
  });

  it('exposes status and error rendering data', () => {
    const error = new PortForwardError('CHANNEL_FAILED', 'remote refused', { tunnelId: 'web' });
    const model = buildPortForwardPanelModel({
      host,
      savedForwards: [],
      activeForwards: [
        activeForward({ id: 'web', state: 'error', error }),
      ],
      status: { tone: 'error', message: 'Forward failed.' },
    });

    expect(model.status).toEqual({ tone: 'error', message: 'Forward failed.' });
    expect(model.rows[0]).toMatchObject({
      statusLabel: 'Error',
      statusTone: 'error',
      errorText: 'remote refused',
      canStart: false,
      canStop: false,
    });

    const html = renderPortForwardHtml(model, {
      cspSource: 'vscode-webview://1234',
      nonce: 'test-nonce',
    });
    expect(html).toContain('Forward failed.');
    expect(html).toContain('remote refused');
    expect(html).toContain('default-src &#39;none&#39;');
    expect(html).not.toContain('unsafe-inline');
  });
});

function activeForward(patch: Partial<ActivePortForward> = {}): ActivePortForward {
  return {
    id: 'web',
    hostId: 7,
    name: undefined,
    localHost: '127.0.0.1',
    localPort: 43000,
    remoteHost: '127.0.0.1',
    remotePort: 3000,
    state: 'listening',
    createdAt: 1,
    startedAt: 2,
    activeChannels: 0,
    ...patch,
  };
}
