import { describe, expect, it } from 'vitest';
import { parseSsTlnp, parseNetstatTlnp, parseSsTln } from '@main/portfwd/PortScanner';

describe('PortScanner', () => {
  it('parses ss -tlnp output with process names', () => {
    const stdout = [
      'State   Recv-Q  Send-Q  Local Address:Port  Peer Address:Port  Process',
      'LISTEN  0       128     0.0.0.0:22          0.0.0.0:*          users:(("sshd",pid=1,fd=3))',
      'LISTEN  0       128     127.0.0.1:8000      0.0.0.0:*          users:(("python",pid=42,fd=5))',
      'LISTEN  0       128     [::]:5432           [::]:*             users:(("postgres",pid=7,fd=7))',
    ].join('\n');
    const ports = parseSsTlnp(stdout);
    expect(ports).toEqual([
      { port: 22, process: 'sshd' },
      { port: 5432, process: 'postgres' },
      { port: 8000, process: 'python' },
    ]);
  });

  it('dedupes and sorts by port', () => {
    const stdout = [
      'LISTEN 0 128 0.0.0.0:8000 0.0.0.0:* users:(("python",pid=42,fd=5))',
      'LISTEN 0 128 127.0.0.1:8000 0.0.0.0:* users:(("python3",pid=43,fd=5))',
      'LISTEN 0 128 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=8,fd=3))',
    ].join('\n');
    const ports = parseSsTlnp(stdout);
    expect(ports.map((p) => p.port)).toEqual([3000, 8000]);
    expect(ports.find((p) => p.port === 8000)!.process).toBe('python');
  });

  it('parses netstat -tlnp output', () => {
    const stdout = [
      'Proto Recv-Q Send-Q Local Address Foreign Address State PID/Program',
      'tcp 0 128 0.0.0.0:22 0.0.0.0:* LISTEN 1/sshd',
      'tcp 0 128 127.0.0.1:6379 0.0.0.0:* LISTEN 9/redis-server',
    ].join('\n');
    const ports = parseNetstatTlnp(stdout);
    expect(ports).toEqual([
      { port: 22, process: 'sshd' },
      { port: 6379, process: 'redis-server' },
    ]);
  });

  it('parses ss -tln (no process info)', () => {
    const stdout = [
      'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
      'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*',
      'LISTEN 0 128 *:8080 *:*',
    ].join('\n');
    const ports = parseSsTln(stdout);
    expect(ports).toEqual([
      { port: 22, process: null },
      { port: 8080, process: null },
    ]);
  });

  it('skips header and blank lines', () => {
    expect(parseSsTlnp('State Recv-Q\n\n')).toEqual([]);
    expect(parseNetstatTlnp('Proto Recv-Q\n')).toEqual([]);
  });

  it('handles IPv6 [::]:port addresses', () => {
    const ports = parseSsTlnp('LISTEN 0 128 [::]:9090 [::]:* users:(("prom",pid=1,fd=3))');
    expect(ports[0]).toEqual({ port: 9090, process: 'prom' });
  });
});
