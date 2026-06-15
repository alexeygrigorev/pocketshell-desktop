import { describe, expect, it } from 'vitest';
import {
  buildRemoteListeningPortsCommand,
  detectPortsFromPaneOutput,
  extractLocalhostUrls,
  mergeDetectedPortCandidates,
  parseRemoteListeningPorts,
  remoteListeningPortsToCandidates,
} from '../../../src/port-forwarding';

describe('port detection scanner', () => {
  it('extracts localhost URLs with valid ports from pane output', () => {
    const output = [
      'Local: http://localhost:5173/',
      'Network: http://192.168.1.5:5173/',
      'Docs: https://127.0.0.1:8443/path?q=1',
      'IPv6: http://[::1]:3000',
      'bad: http://localhost:99999',
      'again: http://localhost:5173/',
    ].join('\n');

    expect(extractLocalhostUrls(output)).toEqual([
      {
        url: 'http://localhost:5173',
        protocol: 'http',
        host: 'localhost',
        port: 5173,
        raw: 'http://localhost:5173/',
      },
      {
        url: 'https://127.0.0.1:8443',
        protocol: 'https',
        host: '127.0.0.1',
        port: 8443,
        raw: 'https://127.0.0.1:8443/path?q=1',
      },
      {
        url: 'http://[::1]:3000',
        protocol: 'http',
        host: '::1',
        port: 3000,
        raw: 'http://[::1]:3000',
      },
    ]);
  });

  it('parses and ranks ss listening-port output', () => {
    const output = [
      'State  Recv-Q Send-Q Local Address:Port Peer Address:PortProcess',
      'LISTEN 0      4096       127.0.0.1:5173      0.0.0.0:*    users:(("node",pid=123,fd=22))',
      'LISTEN 0      128          0.0.0.0:22        0.0.0.0:*    users:(("sshd",pid=1,fd=3))',
      'LISTEN 0      511              [::1]:3000         [::]:*    users:(("python",pid=456,fd=7))',
      'LISTEN 0      80             0.0.0.0:8080      0.0.0.0:*',
    ].join('\n');

    const ports = parseRemoteListeningPorts(output);

    expect(ports.map((port) => port.port)).toEqual([3000, 5173, 8080, 22]);
    expect(ports[0]).toMatchObject({
      protocol: 'tcp6',
      localAddress: '::1',
      port: 3000,
      process: 'python',
      pid: 456,
    });
    expect(remoteListeningPortsToCandidates(ports).map((candidate) => candidate.remotePort)).toEqual([3000, 5173, 8080]);
  });

  it('parses netstat listening-port output', () => {
    const output = [
      'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name',
      'tcp        0      0 127.0.0.1:8000          0.0.0.0:*               LISTEN      321/python',
      'tcp6       0      0 :::9000                 :::*                    LISTEN      -',
    ].join('\n');

    expect(parseRemoteListeningPorts(output)).toMatchObject([
      { protocol: 'tcp', localAddress: '127.0.0.1', port: 8000, process: 'python', pid: 321 },
      { protocol: 'tcp6', localAddress: '::', port: 9000 },
    ]);
  });

  it('merges pane URL detections ahead of matching listener detections', () => {
    const pane = detectPortsFromPaneOutput('Started at https://localhost:8443');
    const listeners = remoteListeningPortsToCandidates(parseRemoteListeningPorts(
      'LISTEN 0 511 127.0.0.1:8443 0.0.0.0:* users:(("node",pid=9,fd=1))',
    ));

    expect(mergeDetectedPortCandidates([...listeners, ...pane])).toEqual([
      expect.objectContaining({
        source: 'pane-url',
        remoteHost: '127.0.0.1',
        remotePort: 8443,
        protocol: 'https',
      }),
    ]);
  });

  it('builds an ss command with a netstat fallback', () => {
    const command = buildRemoteListeningPortsCommand();
    expect(command).toContain('ss -ltnp');
    expect(command).toContain('netstat -ltnp');
  });
});
