/**
 * Client integration tests with mock stream
 *
 * Uses event-driven coordination instead of setTimeout for reliability.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TmuxClient, containsLineBreak, buildBracketedPasteHex, buildBracketedPasteHexChunks, type SshChannel } from '../../../src/tmux/client';
import type { StreamReader } from '../../../src/tmux/stream';

// ---------------------------------------------------------------------------
// Mock SSH channel
// ---------------------------------------------------------------------------

class MockStdoutReader implements StreamReader {
  private chunks: (Buffer | null)[] = [];
  private idx = 0;
  private waiting: ((chunk: Buffer | null) => void)[] = [];

  /** Push a line (auto-appends LF) */
  pushLine(line: string): void {
    this.pushChunk(Buffer.from(line + '\n', 'utf-8'));
  }

  /** Push raw bytes */
  pushChunk(chunk: Buffer | null): void {
    if (this.waiting.length > 0) {
      const resolve = this.waiting.shift()!;
      resolve(chunk);
    } else {
      this.chunks.push(chunk);
    }
  }

  /** Signal EOF */
  pushEof(): void {
    this.pushChunk(null);
  }

  async read(): Promise<Buffer | null> {
    if (this.chunks.length > 0) {
      return this.chunks.shift()!;
    }
    return new Promise<Buffer | null>((resolve) => {
      this.waiting.push(resolve);
    });
  }
}

class MockSshChannel implements SshChannel {
  stdoutReader = new MockStdoutReader();
  written: Buffer[] = [];
  closed = false;
  private writeWaiters: (() => void)[] = [];

  async write(data: Buffer): Promise<void> {
    this.written.push(data);
    // Notify any waiters
    for (const w of this.writeWaiters) w();
    this.writeWaiters = [];
  }

  getStdoutReader(): StreamReader {
    return this.stdoutReader;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stdoutReader.pushEof();
  }

  /** Wait until at least N writes have occurred */
  async waitForWrites(n: number, timeoutMs = 2000): Promise<void> {
    if (this.written.length >= n) return;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${n} writes`)), timeoutMs);
      const check = () => {
        if (this.written.length >= n) {
          clearTimeout(timer);
          resolve();
        } else {
          // Only re-register if not already registered
          if (!this.writeWaiters.includes(check)) {
            this.writeWaiters.push(check);
          }
        }
      };
      check();
    });
  }
}

/**
 * Helper: wait for a condition to become true, checking after each tick.
 */
async function waitFor(
  condition: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise(r => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TmuxClient', () => {
  let channel: MockSshChannel;
  let client: TmuxClient;

  beforeEach(() => {
    channel = new MockSshChannel();
    client = new TmuxClient({
      sessionName: 'test-session',
      commandTimeoutMs: 2000,
    });
  });

  it('connects and sends spawn command', async () => {
    const connectPromise = client.connect(channel);

    // Push initial tmux notifications
    channel.stdoutReader.pushLine('%session-changed $0 test-session');
    channel.stdoutReader.pushLine('%window-add @0');
    channel.stdoutReader.pushLine('%layout-change @0 b25d,80x24,0,0,0');
    channel.stdoutReader.pushLine('%output %0 hello');

    await connectPromise;

    // Wait for events to be processed
    await waitFor(() => client.getState().activeSessionId === '$0');

    // Verify spawn command was written
    expect(channel.written.length).toBe(1);
    const written = channel.written[0].toString('utf-8');
    expect(written).toContain("tmux -CC new-session -A -s 'test-session'");
    expect(written.endsWith('\n')).toBe(true);

    // Verify state was updated
    const state = client.getState();
    expect(state.activeSessionId).toBe('$0');
    expect(state.sessions.get('$0')!.name).toBe('test-session');
    expect(state.sessions.get('$0')!.windows.has('@0')).toBe(true);

    await client.close();
  });

  it('sends a command and receives response', async () => {
    await client.connect(channel);

    // Simulate initial notifications
    channel.stdoutReader.pushLine('%session-changed $0 test-session');
    channel.stdoutReader.pushLine('%window-add @0');

    // Wait for initial state
    await waitFor(() => client.getState().activeSessionId === '$0');

    // Send command
    const cmdPromise = client.listSessions();

    // Wait for the command write to go out
    await channel.waitForWrites(2); // spawn + list-sessions

    // Push response
    channel.stdoutReader.pushLine('%begin 1700000000 1 0');
    channel.stdoutReader.pushLine('test-session: 1 windows (created ...) [80x24]');
    channel.stdoutReader.pushLine('%end 1700000000 1 0');

    const response = await cmdPromise;
    expect(response.number).toBe(1);
    expect(response.output.length).toBe(1);
    expect(response.output[0]).toContain('test-session');
    expect(response.isError).toBe(false);

    await client.close();
  });

  it('subscribes to pane output', async () => {
    await client.connect(channel);

    const received: Uint8Array[] = [];
    const sub = client.onOutput('%0', (data) => {
      received.push(data);
    });

    channel.stdoutReader.pushLine('%session-changed $0 test-session');
    channel.stdoutReader.pushLine('%window-add @0');

    // Push output events
    channel.stdoutReader.pushLine('%output %0 hello');
    channel.stdoutReader.pushLine('%output %0 world');

    // Wait for output events to be processed
    await waitFor(() => received.length >= 2, 2000);

    expect(received.length).toBe(2);
    expect(Buffer.from(received[0]).toString('utf-8')).toBe('hello');
    expect(Buffer.from(received[1]).toString('utf-8')).toBe('world');

    sub.unsubscribe();

    // After unsubscribe, should not receive more
    channel.stdoutReader.pushLine('%output %0 more');
    await new Promise(r => setTimeout(r, 50));

    expect(received.length).toBe(2);

    await client.close();
  });

  it('subscribes to state changes', async () => {
    await client.connect(channel);

    const states: unknown[] = [];
    const sub = client.onStateChange((state) => {
      states.push(state);
    });

    channel.stdoutReader.pushLine('%session-changed $0 test-session');
    await waitFor(() => states.length >= 1);

    channel.stdoutReader.pushLine('%window-add @0');
    await waitFor(() => states.length >= 2);

    expect(states.length).toBeGreaterThanOrEqual(2);

    sub.unsubscribe();
    await client.close();
  });

  it('uses the active pane from the active client window when refreshing all panes', async () => {
    await client.connect(channel);

    channel.stdoutReader.pushLine('%session-changed $0 test-session');
    channel.stdoutReader.pushLine('%window-add @0');
    channel.stdoutReader.pushLine('%window-add @1');
    await waitFor(() => client.getState().activeSessionId === '$0');

    const refresh = client.refreshState();
    await channel.waitForWrites(2);

    channel.stdoutReader.pushLine('%begin 1700000000 1 0');
    channel.stdoutReader.pushLine('%0\t@0\t$0\t80\t24\teditor\t0\t/work/editor\ttest-session\teditor\t0\t0\t1\t1');
    channel.stdoutReader.pushLine('%1\t@1\t$0\t80\t24\tbuild\t0\t/work/build\ttest-session\tbuild\t0\t0\t0\t1');
    channel.stdoutReader.pushLine('%2\t@2\t$1\t80\t24\tlogs\t0\t/work/logs\tother\tlogs\t0\t0\t1\t1');
    channel.stdoutReader.pushLine('%end 1700000000 1 0');

    const state = await refresh;

    expect(state.activeSessionId).toBe('$0');
    expect(state.activeWindowId).toBe('@0');
    expect(state.activePaneId).toBe('%0');
    expect(state.sessions.get('$0')?.windows.get('@1')?.panes.has('%1')).toBe(true);
    expect(state.sessions.get('$1')?.windows.get('@2')?.panes.has('%2')).toBe(true);

    await client.close();
  });

  it('switches session and window before selecting a pane from another session', async () => {
    await client.connect(channel);

    const selected = client.selectPane('%9', '$1', '@4');
    await channel.waitForWrites(2);

    expect(channel.written[1].toString('utf-8')).toBe(
      'switch-client -t "\\$1" ; select-window -t "@4" ; select-pane -t "%9"\n',
    );

    channel.stdoutReader.pushLine('%begin 1700000000 1 0');
    channel.stdoutReader.pushLine('%end 1700000000 1 0');
    await expect(selected).resolves.toMatchObject({ isError: false });

    await client.close();
  });

  it('escapes session names with single quotes', async () => {
    const quotedClient = new TmuxClient({
      sessionName: "it's here",
      commandTimeoutMs: 2000,
    });

    await quotedClient.connect(channel);

    // Push initial notifications so the stream processes something
    channel.stdoutReader.pushLine("%session-changed $0 it's here");
    await waitFor(() => quotedClient.getState().activeSessionId === '$0');

    const written = channel.written[0].toString('utf-8');
    expect(written).toContain("it'\\''s here");

    await quotedClient.close();
  });

  it('can start a fresh session with an initial command in the first pane', async () => {
    const initialCommandClient = new TmuxClient({
      sessionName: 'agent session',
      startDir: "/srv/prod app",
      initialCommand: "pocketshell agent claude --dir '/srv/prod app'",
      commandTimeoutMs: 2000,
    });

    await initialCommandClient.connect(channel);

    const written = channel.written[0].toString('utf-8');
    expect(written).toBe("tmux -CC new-session -A -s 'agent session' -c '/srv/prod app' 'pocketshell agent claude --dir '\\''/srv/prod app'\\'''\n");

    await initialCommandClient.close();
  });

  it('serializes commands (one at a time)', async () => {
    await client.connect(channel);

    channel.stdoutReader.pushLine('%session-changed $0 test-session');
    await waitFor(() => client.getState().activeSessionId === '$0');

    // Send two commands — they queue because client serializes
    const cmd1 = client.sendCommand('list-sessions');
    const cmd2 = client.sendCommand('list-windows');

    // Only the first command should be written immediately
    await channel.waitForWrites(2); // spawn + list-sessions

    // Respond to first
    channel.stdoutReader.pushLine('%begin 1700000000 1 0');
    channel.stdoutReader.pushLine('session data');
    channel.stdoutReader.pushLine('%end 1700000000 1 0');

    const resp1 = await cmd1;
    expect(resp1.output).toEqual(['session data']);

    // Now second command should be written
    await channel.waitForWrites(3); // spawn + list-sessions + list-windows

    // Respond to second
    channel.stdoutReader.pushLine('%begin 1700000001 2 0');
    channel.stdoutReader.pushLine('window data');
    channel.stdoutReader.pushLine('%end 1700000001 2 0');

    const resp2 = await cmd2;
    expect(resp2.output).toEqual(['window data']);

    await client.close();
  });

  it('refreshes pane cwd from extended list-panes output', async () => {
    await client.connect(channel);

    channel.stdoutReader.pushLine('%session-changed $0 test-session');
    channel.stdoutReader.pushLine('%window-add @0');
    await waitFor(() => client.getState().sessions.get('$0')?.windows.has('@0') === true);

    const refresh = client.refreshState();
    await channel.waitForWrites(2);

    const written = channel.written[1].toString('utf-8');
    expect(written).toContain('#{pane_current_path}');
    expect(written).toContain('#{pane_tty}');
    expect(written).toContain('#{pane_current_command}');
    expect(written).toContain('#{pane_pid}');
    expect(written).toContain('#{session_name}');
    expect(written).toContain('#{window_activity}');
    expect(written).toContain('#{pane_active}');

    channel.stdoutReader.pushLine('%begin 1700000000 1 0');
    channel.stdoutReader.pushLine('%1\t@0\t$0\t120\t40\tserver\t0\t/home/alice/git/api\ttest-session\tmain\t1710000000\t1710000300\t1\t1\t/dev/pts/7\tnode\t12345');
    channel.stdoutReader.pushLine('%end 1700000000 1 0');

    const state = await refresh;
    const pane = state.sessions.get('$0')?.windows.get('@0')?.panes.get('%1');
    expect(pane?.cwd).toBe('/home/alice/git/api');
    expect(pane?.tty).toBe('/dev/pts/7');
    expect(pane?.currentCommand).toBe('node');
    expect(pane?.pid).toBe(12345);
    expect(state.activeWindowId).toBe('@0');
    expect(state.activePaneId).toBe('%1');

    await client.close();
  });

  it('sends validated tmux key names to a quoted pane target', async () => {
    await client.connect(channel);

    const command = client.sendKeyNames('%1', ['Enter', 'C-c', 'PageDown']);
    await channel.waitForWrites(2);

    const written = channel.written[1].toString('utf-8');
    expect(written).toBe('send-keys -t "%1" Enter C-c PageDown\n');

    channel.stdoutReader.pushLine('%begin 1700000000 1 0');
    channel.stdoutReader.pushLine('%end 1700000000 1 0');
    await expect(command).resolves.toMatchObject({ isError: false });

    await client.close();
  });

  it('rejects unsafe tmux key names before writing a command', async () => {
    await client.connect(channel);

    await expect(client.sendKeyNames('%1', ['Enter', ';', 'display-message'])).rejects.toThrow('Unsafe tmux key name');
    expect(channel.written).toHaveLength(1);

    await client.close();
  });

  it('notifies state subscribers when refreshState changes the active pane', async () => {
    await client.connect(channel);

    channel.stdoutReader.pushLine('%session-changed $0 test-session');
    channel.stdoutReader.pushLine('%window-add @0');
    await waitFor(() => client.getState().sessions.get('$0')?.windows.has('@0') === true);

    const seedRefresh = client.refreshState();
    await channel.waitForWrites(2);

    channel.stdoutReader.pushLine('%begin 1700000000 1 0');
    channel.stdoutReader.pushLine('%1\t@0\t$0\t120\t40\tserver\t0\t/home/alice/git/api\ttest-session\tmain\t1710000000\t1710000300\t1\t1');
    channel.stdoutReader.pushLine('%2\t@0\t$0\t120\t40\teditor\t0\t/home/alice/git/api\ttest-session\tmain\t1710000000\t1710000300\t1\t0');
    channel.stdoutReader.pushLine('%end 1700000000 1 0');

    await seedRefresh;
    expect(client.getState().activePaneId).toBe('%1');

    const states: unknown[] = [];
    const sub = client.onStateChange((state) => {
      states.push(state);
    });

    const refresh = client.refreshState();
    await channel.waitForWrites(3);

    channel.stdoutReader.pushLine('%begin 1700000001 2 0');
    channel.stdoutReader.pushLine('%1\t@0\t$0\t120\t40\tserver\t0\t/home/alice/git/api\ttest-session\tmain\t1710000000\t1710000300\t1\t0');
    channel.stdoutReader.pushLine('%2\t@0\t$0\t120\t40\teditor\t0\t/home/alice/git/api\ttest-session\tmain\t1710000000\t1710000300\t1\t1');
    channel.stdoutReader.pushLine('%end 1700000001 2 0');

    const state = await refresh;
    expect(state.activePaneId).toBe('%2');
    expect(states).toHaveLength(1);
    expect((states[0] as { activePaneId: string }).activePaneId).toBe('%2');

    sub.unsubscribe();
    await client.close();
  });

  it('quotes rename-session targets with tmux-parser-safe double quotes', async () => {
    await client.connect(channel);

    const command = client.renameSession('prod session:1', 'new "prod"\\session');
    await channel.waitForWrites(2);

    const written = channel.written[1].toString('utf-8');
    expect(written).toBe('rename-session -t "prod session:1" "new \\"prod\\"\\\\session"\n');

    channel.stdoutReader.pushLine('%begin 1700000000 1 0');
    channel.stdoutReader.pushLine('%end 1700000000 1 0');
    await expect(command).resolves.toMatchObject({ isError: false });

    await client.close();
  });

  it('leaves apostrophes literal in tmux command arguments', async () => {
    await client.connect(channel);

    const command = client.renameSession('$0', "new prod's session");
    await channel.waitForWrites(2);

    const written = channel.written[1].toString('utf-8');
    expect(written).toBe('rename-session -t "\\$0" "new prod\'s session"\n');

    channel.stdoutReader.pushLine('%begin 1700000000 1 0');
    channel.stdoutReader.pushLine('%end 1700000000 1 0');
    await expect(command).resolves.toMatchObject({ isError: false });

    await client.close();
  });

  it('quotes new-window targets while preserving tmux id targets', async () => {
    await client.connect(channel);

    const command = client.newWindow('$1', 'dev shell', "/srv/prod app");
    await channel.waitForWrites(2);

    const written = channel.written[1].toString('utf-8');
    expect(written).toBe('new-window -t "\\$1" -n "dev shell" -c "/srv/prod app"\n');

    channel.stdoutReader.pushLine('%begin 1700000000 1 0');
    channel.stdoutReader.pushLine('%end 1700000000 1 0');
    await expect(command).resolves.toMatchObject({ isError: false });

    await client.close();
  });

  it('can create a new window while printing the new pane id', async () => {
    await client.connect(channel);

    const command = client.newWindowWithPaneId('$1', 'claude', "/srv/prod app");
    await channel.waitForWrites(2);

    const written = channel.written[1].toString('utf-8');
    expect(written).toBe('new-window -P -F "#{pane_id}" -t "\\$1" -n "claude" -c "/srv/prod app"\n');

    channel.stdoutReader.pushLine('%begin 1700000000 1 0');
    channel.stdoutReader.pushLine('%7');
    channel.stdoutReader.pushLine('%end 1700000000 1 0');
    await expect(command).resolves.toMatchObject({ isError: false, output: ['%7'] });

    await client.close();
  });

  it('sends literal text to quoted targets before pressing Enter', async () => {
    await client.connect(channel);

    const command = client.sendKeysLiteral('prod session:claude', "pocketshell agent claude --dir '/srv/prod app'");
    await channel.waitForWrites(2);

    const written = channel.written[1].toString('utf-8');
    expect(written).toBe('send-keys -t "prod session:claude" -l "pocketshell agent claude --dir \'/srv/prod app\'" ; send-keys -t "prod session:claude" Enter\n');

    channel.stdoutReader.pushLine('%begin 1700000000 1 0');
    channel.stdoutReader.pushLine('%end 1700000000 1 0');
    await expect(command).resolves.toMatchObject({ isError: false });

    await client.close();
  });

  it('sends terminal input as tmux literal data and key names', async () => {
    await client.connect(channel);

    const command = client.sendInput('%1', 'ls -la\r\t\x7f');
    await channel.waitForWrites(2);

    const written = channel.written[1].toString('utf-8');
    expect(written).toBe('send-keys -t "%1" -l "ls -la" ; send-keys -t "%1" Enter ; send-keys -t "%1" Tab ; send-keys -t "%1" BSpace\n');

    channel.stdoutReader.pushLine('%begin 1700000000 1 0');
    channel.stdoutReader.pushLine('%end 1700000000 1 0');
    await expect(command).resolves.toMatchObject({ isError: false });

    await client.close();
  });

  it('reports client size separately from targeted pane resize', async () => {
    await client.connect(channel);

    const clientResize = client.resizeClient(120, 40);
    await channel.waitForWrites(2);
    expect(channel.written[1].toString('utf-8')).toBe('refresh-client -C 120x40\n');
    channel.stdoutReader.pushLine('%begin 1700000000 1 0');
    channel.stdoutReader.pushLine('%end 1700000000 1 0');
    await clientResize;

    const paneResize = client.resizePane('%7', 100, 30);
    await channel.waitForWrites(3);
    expect(channel.written[2].toString('utf-8')).toBe('resize-pane -t "%7" -x 100 -y 30\n');
    channel.stdoutReader.pushLine('%begin 1700000001 2 0');
    channel.stdoutReader.pushLine('%end 1700000001 2 0');
    await paneResize;

    await client.close();
  });

  // -------------------------------------------------------------------------
  // Bracketed paste (app parity: PocketShell Android BracketedPaste.kt)
  // -------------------------------------------------------------------------

  it('wraps multiline paste as separate chunked send-keys -H bracketed-paste commands with no per-line Enter', async () => {
    await client.connect(channel);

    const command = client.sendBracketedPaste('%1', 'line1\nline2');
    // The client serializes commands, so it sends chunk N+1 only after chunk N's
    // response arrives. Interleave: wait for each write, then push its response.
    // Body is tiny (< 1024 bytes) -> 3 chunks: start marker, body, end marker.
    const writes: string[] = [];
    for (let i = 0; i < 3; i++) {
      await channel.waitForWrites(1 + i + 1);
      writes.push(channel.written[1 + i].toString('utf-8'));
      channel.stdoutReader.pushLine(`%begin 1700000000 ${i + 1} 0`);
      channel.stdoutReader.pushLine(`%end 1700000000 ${i + 1} 0`);
    }

    // Three separate commands, one per chunk (paste-start, body, paste-end).
    expect(writes).toHaveLength(3);
    expect(writes[0]).toBe('send-keys -H -t "%1" 1b 5b 32 30 30 7e\n');
    expect(writes[1]).toBe('send-keys -H -t "%1" 6c 69 6e 65 31 0a 6c 69 6e 65 32\n');
    expect(writes[2]).toBe('send-keys -H -t "%1" 1b 5b 32 30 31 7e\n');

    // Concatenating every chunk's hex bytes must equal the single-frame hex for
    // the same input (bytes reaching the pane are unchanged) -- app parity.
    const joinedHex = writes.map((w) => w.slice('send-keys -H -t "%1" '.length, -1)).join(' ');
    expect(joinedHex).toBe(buildBracketedPasteHex('line1\nline2'));

    // The body LF byte (0a) must appear exactly once across all chunks -- no
    // per-line Enter was emitted (the multiline footgun the fix removes).
    const lfCount = writes
      .map((w) => w.slice('send-keys -H -t "%1" '.length, -1).split(' '))
      .flat()
      .filter((b) => b === '0a').length;
    expect(lfCount).toBe(1);
    // No trailing Enter command.
    expect(writes.join('')).not.toContain('Enter');

    await expect(command).resolves.toMatchObject({ isError: false });

    await client.close();
  });

  it('chunked multiline paste >5 KB splits the body into <=1024-byte send-keys -H commands (app parity)', async () => {
    await client.connect(channel);

    // >5 KB of raw text so the body exceeds a single 1024-byte chunk (this is
    // the case where the desktop's old single-command transport failed with
    // tmux "command too long" but the app succeeded -- tmux issue #254).
    const line = 'line-of-text\n'; // 13 source bytes
    const repeats = 600; // 7800 bytes, 600 LF -> body well over one chunk
    const bigText = line.repeat(repeats);
    const bodyBytes = Buffer.from(bigText.replace(/\r\n/g, '\n'), 'utf-8');
    expect(bodyBytes.length).toBeGreaterThan(1024);

    const expectedChunks = buildBracketedPasteHexChunks(bigText);
    // start + ceil(body/1024) body chunks + end >= 4 commands.
    const expectedBodyChunks = Math.ceil(bodyBytes.length / 1024);
    expect(expectedChunks.length).toBe(2 + expectedBodyChunks);
    expect(expectedBodyChunks).toBeGreaterThanOrEqual(2);

    const command = client.sendBracketedPaste('%1', bigText);

    // Commands are serialized: send chunk i, await its response, send chunk i+1.
    const writes: string[] = [];
    for (let i = 0; i < expectedChunks.length; i++) {
      await channel.waitForWrites(1 + i + 1);
      writes.push(channel.written[1 + i].toString('utf-8'));
      channel.stdoutReader.pushLine(`%begin 1700000000 ${i + 1} 0`);
      channel.stdoutReader.pushLine(`%end 1700000000 ${i + 1} 0`);
    }
    expect(writes).toHaveLength(expectedChunks.length);

    // Every chunk command has the same shape and targets the quoted pane.
    for (const w of writes) {
      expect(w.startsWith('send-keys -H -t "%1" ')).toBe(true);
      expect(w.endsWith('\n')).toBe(true);
    }

    // First command carries ONLY the paste-start marker; last ONLY paste-end.
    expect(writes[0]).toBe('send-keys -H -t "%1" 1b 5b 32 30 30 7e\n');
    expect(writes[writes.length - 1]).toBe('send-keys -H -t "%1" 1b 5b 32 30 31 7e\n');

    // Every BODY chunk must be <= 1024 source bytes. Locks the parity fix.
    const bodyWrites = writes.slice(1, -1);
    expect(bodyWrites.length).toBe(expectedBodyChunks);
    for (const w of bodyWrites) {
      const hex = w.slice('send-keys -H -t "%1" '.length, -1);
      // Each hex token is one byte; body chunk carries <= 1024 bytes.
      const byteCount = hex === '' ? 0 : hex.split(' ').length;
      expect(byteCount).toBeGreaterThan(0);
      expect(byteCount).toBeLessThanOrEqual(1024);
    }

    // Concatenated hex of all chunks == single-frame hex (bytes unchanged).
    const joinedHex = writes.map((w) => w.slice('send-keys -H -t "%1" '.length, -1)).join(' ');
    expect(joinedHex).toBe(buildBracketedPasteHex(bigText));

    // All chunk responses were pushed in the interleaved loop above.
    await expect(command).resolves.toMatchObject({ isError: false });

    await client.close();
  });

  it('single-line sendInput is byte-unchanged (no bracketed-paste markers)', async () => {
    await client.connect(channel);

    const command = client.sendInput('%1', 'ls -la\r');
    await channel.waitForWrites(2);

    const written = channel.written[1].toString('utf-8');
    // Exact legacy shape for a single-line input ending in CR: literal + Enter.
    expect(written).toBe('send-keys -t "%1" -l "ls -la" ; send-keys -t "%1" Enter\n');
    expect(written).not.toContain('-H');
    expect(written).not.toContain('1b 5b 32 30 30 7e');

    channel.stdoutReader.pushLine('%begin 1700000000 1 0');
    channel.stdoutReader.pushLine('%end 1700000000 1 0');
    await expect(command).resolves.toMatchObject({ isError: false });

    await client.close();
  });

  it('sendBracketedPaste is a no-op for empty text (no bare markers, no tmux command)', async () => {
    await client.connect(channel);

    // Empty input short-circuits before enqueuing — nothing is written beyond
    // the spawn command, and no tmux response is awaited.
    const emptyRes = await client.sendBracketedPaste('%1', '');
    expect(emptyRes.isError).toBe(false);
    expect(channel.written).toHaveLength(1);

    await client.close();
  });
});

// ---------------------------------------------------------------------------
// Pure bracketed-paste helpers (app parity: BracketedPaste.kt)
// ---------------------------------------------------------------------------

describe('containsLineBreak', () => {
  it('returns true when a line feed is present', () => {
    expect(containsLineBreak('a\nb')).toBe(true);
    expect(containsLineBreak('\n')).toBe(true);
    expect(containsLineBreak('a\r\nb')).toBe(true);
  });

  it('returns false for single-line text and lone CR (matching the app)', () => {
    expect(containsLineBreak('single line')).toBe(false);
    expect(containsLineBreak('')).toBe(false);
    // Lone CR is NOT a paragraph break in the app's containsLineBreak.
    expect(containsLineBreak('a\rb')).toBe(false);
  });
});

describe('buildBracketedPasteHex', () => {
  it('frames multiline content between the start/end markers with normalised LF', () => {
    // line1\nline2 -> 1b5b323030 7e (start) + body + 1b5b323031 7e (end)
    expect(buildBracketedPasteHex('line1\nline2')).toBe(
      '1b 5b 32 30 30 7e 6c 69 6e 65 31 0a 6c 69 6e 65 32 1b 5b 32 30 31 7e',
    );
  });

  it('normalises CRLF to LF inside the paste body (app parity)', () => {
    // "a\r\nb" -> start + 61 0a 62 + end (the \r\n collapses to a single 0a).
    expect(buildBracketedPasteHex('a\r\nb')).toBe(
      '1b 5b 32 30 30 7e 61 0a 62 1b 5b 32 30 31 7e',
    );
  });

  it('passes a lone CR through unchanged (not a paragraph break)', () => {
    // "a\rb" -> start + 61 0d 62 + end (\r stays as 0d, no normalisation).
    expect(buildBracketedPasteHex('a\rb')).toBe(
      '1b 5b 32 30 30 7e 61 0d 62 1b 5b 32 30 31 7e',
    );
  });

  it('encodes multibyte UTF-8 correctly inside the frame', () => {
    // "é\n" -> start + c3 a9 0a + end.
    expect(buildBracketedPasteHex('é\n')).toBe(
      '1b 5b 32 30 30 7e c3 a9 0a 1b 5b 32 30 31 7e',
    );
  });

  it('returns an empty string for empty input (no bare markers)', () => {
    expect(buildBracketedPasteHex('')).toBe('');
  });

  it('never emits a trailing Enter / 0d 0a sequence — only the framed body', () => {
    const hex = buildBracketedPasteHex('first\nsecond\nthird');
    // Only the LF separators (two of them) inside the body; no CRLF, no Enter.
    expect(hex.split(' ').filter((b) => b === '0a')).toHaveLength(2);
    expect(hex).not.toContain('0d 0a');
    expect(hex.endsWith('1b 5b 32 30 31 7e')).toBe(true);
  });
});

describe('buildBracketedPasteHexChunks (app parity: BracketedPaste.hexChunks, BODY_CHUNK_BYTES=1024)', () => {
  it('returns [] for empty input (no bare markers, no commands)', () => {
    expect(buildBracketedPasteHexChunks('')).toEqual([]);
  });

  it('emits paste-start, single body chunk, paste-end as 3 separate entries for a small paste', () => {
    const chunks = buildBracketedPasteHexChunks('line1\nline2');
    expect(chunks).toEqual([
      '1b 5b 32 30 30 7e',
      '6c 69 6e 65 31 0a 6c 69 6e 65 32',
      '1b 5b 32 30 31 7e',
    ]);
  });

  it('slices the body at <= 1024 source bytes per chunk for large input', () => {
    const line = 'x'.repeat(100) + '\n'; // 101 source bytes
    const bigText = line.repeat(50); // 5050 bytes -> 5 body chunks (1024+1024+1024+1024+954)
    const bodyBytes = Buffer.from(bigText.replace(/\r\n/g, '\n'), 'utf-8');
    const chunks = buildBracketedPasteHexChunks(bigText);
    // start + ceil(5050/1024)=5 body chunks + end
    expect(chunks.length).toBe(2 + Math.ceil(bodyBytes.length / 1024));
    const bodyChunks = chunks.slice(1, -1);
    for (const hex of bodyChunks) {
      const byteCount = hex.split(' ').length;
      expect(byteCount).toBeLessThanOrEqual(1024);
    }
  });

  it('joining all chunk hexes with spaces equals the single-frame hex (bytes unchanged)', () => {
    const text = 'first\nsecond\nthird\n'.repeat(400);
    expect(buildBracketedPasteHexChunks(text).join(' ')).toBe(buildBracketedPasteHex(text));
  });

  it('normalises CRLF before slicing (chunk boundaries fall on normalised bytes)', () => {
    // CRLF -> LF shrinks the body; chunking must operate on the normalised form.
    const text = 'a\r\n'.repeat(700); // 700*\r\n -> 700*\n after normalisation
    const bodyBytes = Buffer.from(text.replace(/\r\n/g, '\n'), 'utf-8');
    const chunks = buildBracketedPasteHexChunks(text);
    const bodyByteTotal = chunks
      .slice(1, -1)
      .reduce((n, hex) => n + (hex === '' ? 0 : hex.split(' ').length), 0);
    expect(bodyByteTotal).toBe(bodyBytes.length);
    // Joined == single-frame form (also CRLF-normalised).
    expect(chunks.join(' ')).toBe(buildBracketedPasteHex(text));
  });
});
