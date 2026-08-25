import { describe, expect, it, vi } from 'vitest';
import type { SshService } from '@main/ssh/SshService';
import type { ForwardService } from '@main/portfwd/ForwardService';
import type { ForwardState } from '@main/portfwd/Forwarder';
import { ServeService, ServeError } from '@main/portfwd/ServeService';

/**
 * The orchestration: what is refused before a channel is opened, what happens
 * when the bind races, and — the part that matters on a live box — that
 * stopping kills the SERVER and not merely its tunnel.
 *
 * Nothing here talks to a host. `SshService` is a double whose PTY replays a
 * canned server transcript, and `ForwardService` is a double that records the
 * calls the service makes against it.
 */

const CONN = 'conn-1';

interface Script {
  python?: string;
  version?: string;
  dir?: string;
  listening?: number[];
  /** Output the fake server emits, per launch attempt, in order. */
  transcripts: string[];
}

class FakeSsh {
  closed: string[] = [];
  commands: string[] = [];
  private attempt = 0;
  /** shellId -> the onExit handed to openTrackedShell. */
  private exits = new Map<string, () => void>();

  constructor(private readonly script: Script) {}

  onCloseConnection(): () => void {
    return () => {};
  }

  exec(_id: string, _command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const ss = ['State  Recv-Q Send-Q Local Address:Port  Peer Address:Port']
      .concat(
        (this.script.listening ?? []).map(
          (p) => `LISTEN 0      4096   127.0.0.1:${p}      0.0.0.0:*`,
        ),
      )
      .join('\n');
    const stdout = [
      '<<<PS_SERVE_PY>>>',
      this.script.python ?? '/usr/bin/python3',
      '<<<PS_SERVE_VER>>>',
      this.script.version ?? 'Python 3.12.3',
      '<<<PS_SERVE_DIR>>>',
      this.script.dir ?? 'ok',
      '<<<PS_SS_TLN>>>',
      ss,
      '<<<PS_SS_TLNP>>>',
      '<<<PS_NETSTAT_TLNP>>>',
      '<<<PS_NETSTAT_TLN>>>',
      '',
    ].join('\n');
    return Promise.resolve({ stdout, stderr: '', exitCode: 0 });
  }

  openTrackedShell(
    _id: string,
    opts: { command?: string; onData: (b: Buffer) => void; onExit?: () => void },
  ): Promise<string> {
    const shellId = `shell-${this.attempt}`;
    this.commands.push(opts.command ?? '');
    const transcript = this.script.transcripts[this.attempt] ?? '';
    this.attempt += 1;
    if (opts.onExit) this.exits.set(shellId, opts.onExit);
    // Delivered after the promise resolves, the way a real channel does.
    queueMicrotask(() => opts.onData(Buffer.from(transcript, 'utf8')));
    return Promise.resolve(shellId);
  }

  shellClose(shellId: string): void {
    this.closed.push(shellId);
  }

  /** Simulate the remote server dying on its own. */
  killShell(shellId: string): void {
    this.exits.get(shellId)?.();
  }

  asService(): SshService {
    return this as unknown as SshService;
  }
}

class FakeForwards {
  names: [number, string | null][] = [];
  intents: [number, string | null][] = [];
  removed: string[] = [];
  /** Local port handed back once the "tunnel" is open. Null keeps it shut. */
  localPort: number | null = 8081;

  setName(_id: string, port: number, name: string | null): void {
    this.names.push([port, name]);
  }
  async setIntent(_id: string, port: number, intent: string | null): Promise<void> {
    this.intents.push([port, intent]);
  }
  async remove(_id: string, key: string): Promise<void> {
    this.removed.push(key);
  }
  async refresh(): Promise<void> {}
  list(): ForwardState[] {
    if (this.localPort === null) return [];
    const open = this.intents.some(([, i]) => i === 'force-on');
    if (!open) return [];
    const port = this.intents.find(([, i]) => i === 'force-on')![0];
    return [
      {
        key: `local:${this.localPort}->127.0.0.1:${port}`,
        kind: 'local',
        listenHost: '127.0.0.1',
        listenPort: this.localPort,
        destHost: '127.0.0.1',
        destPort: port,
        origin: 'manual',
        active: true,
        bytesIn: 0,
        bytesOut: 0,
        rateIn: 0,
        rateOut: 0,
        name: null,
        process: null,
        cwd: null,
        remapped: false,
      },
    ];
  }

  asService(): ForwardService {
    return this as unknown as ForwardService;
  }
}

const READY = 'Serving HTTP on 127.0.0.1 port 8081 (http://127.0.0.1:8081/) ...\n';
const BUSY = 'OSError: [Errno 98] Address already in use\n';

function make(script: Script): { ssh: FakeSsh; fwd: FakeForwards; serve: ServeService } {
  const ssh = new FakeSsh(script);
  const fwd = new FakeForwards();
  // The real waits are seconds long by design; nothing here is testing the
  // clock, so they are dialled down rather than slept through.
  const serve = new ServeService(ssh.asService(), fwd.asService(), {
    readyTimeoutMs: 50,
    forwardTimeoutMs: 50,
    forwardPollMs: 5,
  });
  return { ssh, fwd, serve };
}

describe('ServeService.start', () => {
  it('serves a folder and reports a local URL', async () => {
    const { ssh, fwd, serve } = make({ transcripts: [READY] });
    const rec = await serve.start(CONN, '/srv/site');

    expect(rec.state).toBe('running');
    expect(rec.remotePort).toBe(8081);
    expect(rec.localPort).toBe(8081);
    expect(rec.url).toBe('http://127.0.0.1:8081/');
    // The server was told to bind loopback, and the tunnel was expressed as
    // an intent on the EXISTING engine rather than as a second kind of tunnel.
    expect(ssh.commands[0]).toContain('--bind 127.0.0.1');
    expect(fwd.intents).toContainEqual([8081, 'force-on']);
    expect(fwd.names[0]).toEqual([8081, 'Serving site/']);
  });

  it('refuses before opening a channel when the host has no python', async () => {
    const { ssh, serve } = make({ python: '', version: '', transcripts: [] });
    await expect(serve.start(CONN, '/srv/site')).rejects.toBeInstanceOf(ServeError);
    expect(ssh.commands).toHaveLength(0);
  });

  it('refuses a python too old for --directory', async () => {
    const { ssh, serve } = make({ version: 'Python 3.6.9', transcripts: [] });
    await expect(serve.start(CONN, '/srv/site')).rejects.toThrow(/too old/i);
    expect(ssh.commands).toHaveLength(0);
  });

  it.each([
    ['missing', /not there/i],
    ['not-a-directory', /a file/i],
    ['unreadable', /not readable/i],
  ])('refuses a %s directory with a sentence about it', async (verdict, pattern) => {
    const { ssh, serve } = make({ dir: verdict, transcripts: [] });
    await expect(serve.start(CONN, '/srv/site')).rejects.toThrow(pattern);
    expect(ssh.commands).toHaveLength(0);
  });

  it('skips ports the host is already listening on', async () => {
    const { ssh, serve } = make({ listening: [8081, 8082], transcripts: [READY] });
    const rec = await serve.start(CONN, '/srv/site');
    expect(rec.remotePort).toBe(8083);
    expect(ssh.commands[0]).toContain('http.server 8083');
  });

  it('retries the NEXT port when the bind races, and closes the loser', async () => {
    const { ssh, serve } = make({ transcripts: [BUSY, READY] });
    const rec = await serve.start(CONN, '/srv/site');
    expect(rec.remotePort).toBe(8082);
    expect(ssh.commands).toHaveLength(2);
    // The channel from the failed attempt must not be left holding a shell.
    expect(ssh.closed).toContain('shell-0');
    expect(ssh.closed).not.toContain('shell-1');
  });

  it('does NOT retry a failure that every port would share', async () => {
    const { ssh, serve } = make({
      transcripts: ["PermissionError: [Errno 13] Permission denied: '/srv/site'"],
    });
    await expect(serve.start(CONN, '/srv/site')).rejects.toThrow(/cannot read/i);
    expect(ssh.commands).toHaveLength(1);
  });

  it('tears everything down rather than returning a record with no URL', async () => {
    const { ssh, fwd, serve } = make({ transcripts: [READY] });
    fwd.localPort = null; // the tunnel never opens
    await expect(serve.start(CONN, '/srv/site')).rejects.toThrow(/tunnel/i);
    expect(ssh.closed).toContain('shell-0');
    expect(serve.list(CONN)).toEqual([]);
  });

  it('is idempotent for a folder already being served', async () => {
    const { ssh, serve } = make({ transcripts: [READY, READY] });
    const first = await serve.start(CONN, '/srv/site');
    const second = await serve.start(CONN, '/srv/site');
    expect(second).toEqual(first);
    expect(ssh.commands).toHaveLength(1);
  });
});

describe('ServeService.stop', () => {
  it('kills the server FIRST, then removes the forward, then clears the intent', async () => {
    const { ssh, fwd, serve } = make({ transcripts: [READY] });
    await serve.start(CONN, '/srv/site');
    await serve.stop(CONN, 8081);

    // The order is the whole point: removing the forward while the server ran
    // would leave a python process serving a directory on the host.
    expect(ssh.closed).toEqual(['shell-0']);
    expect(fwd.removed).toEqual(['local:8081->127.0.0.1:8081']);
    // Cleared, not left at the `force-off` that `remove` sets — otherwise
    // serving the same folder again would be silently refused next time.
    expect(fwd.intents[fwd.intents.length - 1]).toEqual([8081, null]);
    expect(fwd.names[fwd.names.length - 1]).toEqual([8081, null]);
    expect(serve.list(CONN)).toEqual([]);
  });

  it('notifies listeners so a stopped row cannot linger', async () => {
    const { serve } = make({ transcripts: [READY] });
    const seen = vi.fn();
    serve.onChanged(seen);
    await serve.start(CONN, '/srv/site');
    await serve.stop(CONN, 8081);
    expect(seen).toHaveBeenLastCalledWith(CONN, []);
  });
});

describe('a server that dies on its own', () => {
  it('is reported as failed and takes its tunnel with it', async () => {
    const { ssh, fwd, serve } = make({ transcripts: [READY] });
    await serve.start(CONN, '/srv/site');

    const seen: unknown[] = [];
    serve.onChanged((_id, served) => seen.push(served.map((s) => s.state)));
    ssh.killShell('shell-0');
    await Promise.resolve();

    expect(serve.list(CONN)[0]?.state).toBe('failed');
    expect(serve.list(CONN)[0]?.error).toMatch(/stopped/i);
    expect(fwd.removed).toEqual(['local:8081->127.0.0.1:8081']);
  });
});

describe('connection lifetime', () => {
  it('drops its bookkeeping when the connection goes, without closing shells', async () => {
    const { ssh, serve } = make({ transcripts: [READY] });
    await serve.start(CONN, '/srv/site');
    ssh.closed = [];

    serve.evict(CONN);

    expect(serve.list(CONN)).toEqual([]);
    // Nothing to close: the transport dying is what hangs up the pty, which is
    // what kills the server. Calling shellClose on a dead channel would be
    // theatre, and relying on it would be the bug.
    expect(ssh.closed).toEqual([]);
  });
});
