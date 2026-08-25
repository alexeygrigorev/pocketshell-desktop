import { describe, it, expect } from 'vitest';
import {
  choosePort,
  classifyServeOutput,
  parsePythonVersion,
  parseServeProbe,
  pythonIsUsable,
  SERVE_BIND_ADDRESS,
  SERVE_PORT_RANGE,
  serveCommand,
  serveErrorMessage,
  serveLabel,
  serveProbeCommand,
  serveUrl,
  supportsProtocolFlag,
} from '../../src/main/portfwd/serveCommand';

/**
 * Captured shape of one `serveProbeCommand` run: our three sections followed
 * by the four `LISTENER_SCAN_COMMAND` sections it appends verbatim.
 */
function probeOutput(opts: {
  python?: string;
  version?: string;
  dir?: string;
  listening?: number[];
}): string {
  const ss = ['State  Recv-Q Send-Q Local Address:Port  Peer Address:Port']
    .concat((opts.listening ?? []).map((p) => `LISTEN 0      4096   127.0.0.1:${p}      0.0.0.0:*`))
    .join('\n');
  return [
    '<<<PS_SERVE_PY>>>',
    opts.python ?? '',
    '<<<PS_SERVE_VER>>>',
    opts.version ?? '',
    '<<<PS_SERVE_DIR>>>',
    opts.dir ?? 'ok',
    '<<<PS_SS_TLN>>>',
    ss,
    '<<<PS_SS_TLNP>>>',
    '<<<PS_NETSTAT_TLNP>>>',
    '<<<PS_NETSTAT_TLN>>>',
    '',
  ].join('\n');
}

describe('serveProbeCommand', () => {
  it('quotes the directory as data, not as shell', () => {
    const cmd = serveProbeCommand("/home/x/wei'rd $(touch /tmp/PWNED)");
    // The substitution text is present but INERT: every occurrence sits inside
    // single quotes, where POSIX sh expands nothing, and the embedded quote is
    // closed-escaped-reopened rather than ending the word early.
    expect(cmd).toContain(`'/home/x/wei'\\''rd $(touch /tmp/PWNED)'`);
    // The breakout to check for is an ODD quote: that is what would leave the
    // rest of the command outside quotes and the substitution live.
    expect((cmd.match(/'/g) ?? []).length % 2).toBe(0);
  });

  it('keeps a leading ~ expandable', () => {
    expect(serveProbeCommand('~/git/site')).toContain("$HOME/'git/site'");
  });

  it('asks the three questions and appends the shared listener scan', () => {
    const cmd = serveProbeCommand('/srv/site');
    expect(cmd).toContain('<<<PS_SERVE_PY>>>');
    expect(cmd).toContain('<<<PS_SERVE_VER>>>');
    expect(cmd).toContain('<<<PS_SERVE_DIR>>>');
    // Not re-derived: the listener probe is the same text scanRemotePorts uses.
    expect(cmd).toContain('<<<PS_SS_TLN>>>');
    expect(cmd).toContain('ss -tln');
  });
});

describe('parseServeProbe', () => {
  it('reads python, version, dir verdict and the taken ports', () => {
    const probe = parseServeProbe(
      probeOutput({
        python: '/usr/bin/python3',
        version: 'Python 3.12.3',
        dir: 'ok',
        listening: [22, 8081, 8082],
      }),
    );
    expect(probe.python).toBe('/usr/bin/python3');
    expect(probe.versionLine).toBe('Python 3.12.3');
    expect(probe.dir).toBe('ok');
    expect(probe.taken).toEqual(expect.arrayContaining([22, 8081, 8082]));
  });

  it('reports a host with no python as null rather than empty string', () => {
    const probe = parseServeProbe(probeOutput({ python: '', version: '' }));
    expect(probe.python).toBeNull();
    expect(probe.versionLine).toBeNull();
  });

  it('carries each directory verdict through', () => {
    for (const verdict of ['missing', 'not-a-directory', 'unreadable'] as const) {
      expect(parseServeProbe(probeOutput({ dir: verdict })).dir).toBe(verdict);
    }
  });

  it('calls an unrecognised verdict unknown rather than guessing ok', () => {
    expect(parseServeProbe(probeOutput({ dir: 'sh: bad substitution' })).dir).toBe('unknown');
  });
});

describe('python version gates', () => {
  it('parses the version line', () => {
    expect(parsePythonVersion('Python 3.12.3')).toEqual([3, 12]);
    expect(parsePythonVersion('Python 2.7.18')).toEqual([2, 7]);
    expect(parsePythonVersion(null)).toBeNull();
    expect(parsePythonVersion('bash: python3: command not found')).toBeNull();
  });

  it('needs 3.7 for --directory, and refuses python 2 outright', () => {
    expect(pythonIsUsable('Python 3.12.3')).toBe(true);
    expect(pythonIsUsable('Python 3.7.0')).toBe(true);
    expect(pythonIsUsable('Python 3.6.9')).toBe(false);
    expect(pythonIsUsable('Python 2.7.18')).toBe(false);
    expect(pythonIsUsable(null)).toBe(false);
  });

  it('only asks for --protocol where argparse will accept it', () => {
    expect(supportsProtocolFlag('Python 3.11.0')).toBe(true);
    expect(supportsProtocolFlag('Python 3.12.3')).toBe(true);
    expect(supportsProtocolFlag('Python 3.10.12')).toBe(false);
    expect(supportsProtocolFlag(null)).toBe(false);
  });
});

describe('choosePort', () => {
  it('takes the first free port in the range', () => {
    expect(choosePort([8081, 8082])).toBe(8083);
  });

  it('ignores listeners outside the range', () => {
    expect(choosePort([22, 80, 443, 3000, 9999])).toBe(SERVE_PORT_RANGE[0]);
  });

  it('returns null rather than a port outside the range when it is full', () => {
    const full: number[] = [];
    for (let p = SERVE_PORT_RANGE[0]; p <= SERVE_PORT_RANGE[1]; p++) full.push(p);
    expect(choosePort(full)).toBeNull();
  });

  it('stays inside the auto-forward window (1024..10000)', () => {
    expect(SERVE_PORT_RANGE[0]).toBeGreaterThanOrEqual(1024);
    expect(SERVE_PORT_RANGE[1]).toBeLessThanOrEqual(10_000);
  });
});

describe('serveCommand', () => {
  const base = { python: '/usr/bin/python3', dir: '/srv/site', port: 8081 };

  it('binds loopback and nothing else', () => {
    const cmd = serveCommand({ ...base, versionLine: 'Python 3.12.3' });
    expect(SERVE_BIND_ADDRESS).toBe('127.0.0.1');
    expect(cmd).toContain('--bind 127.0.0.1');
    // The regression that matters. `http.server` binds ALL interfaces when
    // --bind is omitted; on an internet-facing box that publishes the folder.
    expect(cmd).not.toContain('0.0.0.0');
    expect(cmd).not.toMatch(/--bind\s+(?!127\.0\.0\.1)/);
  });

  it('execs, so closing the channel hangs up on the server itself', () => {
    const cmd = serveCommand({ ...base, versionLine: 'Python 3.12.3' });
    expect(cmd).toMatch(/\bexec\b/);
    expect(cmd).toContain('stty -echo');
  });

  it('serves the directory it was given, quoted', () => {
    const cmd = serveCommand({ ...base, dir: "/srv/my site's", versionLine: null });
    expect(cmd).toContain(`--directory '/srv/my site'\\''s'`);
  });

  it('adds --protocol only on a python that knows it', () => {
    expect(serveCommand({ ...base, versionLine: 'Python 3.12.3' })).toContain(
      '--protocol HTTP/1.1',
    );
    expect(serveCommand({ ...base, versionLine: 'Python 3.9.2' })).not.toContain('--protocol');
  });

  it('puts the port where http.server expects it (positional)', () => {
    expect(serveCommand({ ...base, versionLine: null })).toContain('-m http.server 8081');
  });
});

describe('classifyServeOutput', () => {
  it('reports ready on the line http.server actually prints', () => {
    const out =
      'Serving HTTP on 127.0.0.1 port 8081 (http://127.0.0.1:8081/) ...\n';
    expect(classifyServeOutput(out)).toEqual({ kind: 'ready' });
  });

  it('recognises a lost bind race by words, not errno', () => {
    const linux = 'OSError: [Errno 98] Address already in use';
    const mac = 'OSError: [Errno 48] Address already in use';
    expect(classifyServeOutput(linux)).toEqual({ kind: 'port-taken' });
    expect(classifyServeOutput(mac)).toEqual({ kind: 'port-taken' });
  });

  it('recognises the directory failures', () => {
    expect(classifyServeOutput('PermissionError: [Errno 13] Permission denied')).toEqual({
      kind: 'permission-denied',
    });
    expect(
      classifyServeOutput("FileNotFoundError: [Errno 2] No such file or directory: '/srv/x'"),
    ).toEqual({ kind: 'missing-dir' });
  });

  it('recognises a host with no python', () => {
    expect(classifyServeOutput('sh: 1: python3: command not found')).toEqual({ kind: 'no-python' });
    expect(classifyServeOutput('/usr/bin/python3: No module named http.server')).toEqual({
      kind: 'no-python',
    });
  });

  it('reports an unclassified traceback by its exception line', () => {
    const out = [
      'Traceback (most recent call last):',
      '  File "<string>", line 1, in <module>',
      'ValueError: something specific',
    ].join('\n');
    expect(classifyServeOutput(out)).toEqual({
      kind: 'failed',
      message: 'ValueError: something specific',
    });
  });

  it('says nothing while there is nothing to say', () => {
    expect(classifyServeOutput('')).toBeNull();
    expect(classifyServeOutput('alexey@hetzner:~$ ')).toBeNull();
  });

  it('is read against the accumulated buffer, so a split traceback still lands', () => {
    let buf = '';
    for (const chunk of ['OSError: [Errno 98] Addr', 'ess already in use\n']) {
      buf += chunk;
    }
    expect(classifyServeOutput(buf)).toEqual({ kind: 'port-taken' });
  });
});

describe('messages and URLs', () => {
  it('builds a loopback URL on the LOCAL port with a trailing slash', () => {
    expect(serveUrl(8081)).toBe('http://127.0.0.1:8081/');
  });

  it('labels a served folder by its basename', () => {
    expect(serveLabel('/home/alexey/git/site/dist')).toBe('Serving dist/');
    expect(serveLabel('/')).toBe('Serving //');
  });

  it('turns every outcome into a sentence naming the folder', () => {
    expect(serveErrorMessage({ kind: 'missing-dir' }, '/srv/x')).toContain('/srv/x');
    expect(serveErrorMessage({ kind: 'permission-denied' }, '/srv/x')).toContain('/srv/x');
    expect(serveErrorMessage({ kind: 'no-python' }, '/srv/x')).toMatch(/python/i);
    expect(serveErrorMessage({ kind: 'port-taken' }, '/srv/x')).toContain(
      String(SERVE_PORT_RANGE[0]),
    );
    expect(serveErrorMessage({ kind: 'failed', message: 'boom' }, '/srv/x')).toBe('boom');
  });
});
