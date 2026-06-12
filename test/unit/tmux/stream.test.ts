/**
 * Stream framer unit tests
 *
 * Tests %begin/%end/%error framing, command correlation,
 * and payload handling.
 */

import { describe, it, expect } from 'vitest';
import { TmuxEventStream, type StreamReader } from '../../../src/tmux/stream';
import type { ControlEvent } from '../../../src/tmux/events';

// ---------------------------------------------------------------------------
// Mock StreamReader
// ---------------------------------------------------------------------------

class MockStreamReader implements StreamReader {
  private chunks: Buffer[];
  private idx = 0;

  constructor(lines: (string | Buffer)[]) {
    this.chunks = lines.map(l =>
      typeof l === 'string' ? Buffer.from(l + '\n', 'utf-8') : l,
    );
  }

  async read(): Promise<Buffer | null> {
    if (this.idx >= this.chunks.length) return null;
    return this.chunks[this.idx++];
  }
}

/** Collects events emitted by a stream run */
async function collectEvents(stream: TmuxEventStream): Promise<ControlEvent[]> {
  const events: ControlEvent[] = [];
  stream.on('event', (e: ControlEvent) => events.push(e));
  await stream.run();
  return events;
}

// ---------------------------------------------------------------------------
// Single command response
// ---------------------------------------------------------------------------

describe('TmuxEventStream — single command response', () => {
  it('emits begin and end events and resolves command', async () => {
    const reader = new MockStreamReader([
      '%session-changed $0 main',
      '%begin 1700000000 1 0',
      'session data line 1',
      'session data line 2',
      '%end 1700000000 1 0',
    ]);

    const stream = new TmuxEventStream(reader);
    const cmdPromise = stream.enqueueCommand();
    const events = await collectEvents(stream);

    // Should have: session-changed, begin, end
    expect(events.map(e => e.type)).toEqual([
      'session-changed', 'begin', 'end',
    ]);

    const response = await cmdPromise;
    expect(response.number).toBe(1);
    expect(response.output).toEqual(['session data line 1', 'session data line 2']);
    expect(response.isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error response
// ---------------------------------------------------------------------------

describe('TmuxEventStream — error response', () => {
  it('resolves command with isError=true on %error', async () => {
    const reader = new MockStreamReader([
      '%begin 1700000000 2 0',
      'error: unknown command',
      '%error 1700000000 2 0',
    ]);

    const stream = new TmuxEventStream(reader);
    const cmdPromise = stream.enqueueCommand();
    const events = await collectEvents(stream);

    expect(events.map(e => e.type)).toEqual(['begin', 'error']);

    const response = await cmdPromise;
    expect(response.number).toBe(2);
    expect(response.output).toEqual(['error: unknown command']);
    expect(response.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Multiple commands in sequence
// ---------------------------------------------------------------------------

describe('TmuxEventStream — multiple commands', () => {
  it('correlates two sequential command responses', async () => {
    const reader = new MockStreamReader([
      '%begin 1700000000 1 0',
      'first output',
      '%end 1700000000 1 0',
      '%begin 1700000001 2 0',
      'second output',
      '%end 1700000001 2 0',
    ]);

    const stream = new TmuxEventStream(reader);
    const cmd1 = stream.enqueueCommand();
    const cmd2 = stream.enqueueCommand();
    const events = await collectEvents(stream);

    expect(events.filter(e => e.type === 'begin').length).toBe(2);
    expect(events.filter(e => e.type === 'end').length).toBe(2);

    const [resp1, resp2] = await Promise.all([cmd1, cmd2]);
    expect(resp1.number).toBe(1);
    expect(resp1.output).toEqual(['first output']);
    expect(resp2.number).toBe(2);
    expect(resp2.output).toEqual(['second output']);
  });
});

// ---------------------------------------------------------------------------
// Payload lines that look like control events
// ---------------------------------------------------------------------------

describe('TmuxEventStream — payload opacity', () => {
  it('treats payload lines starting with % as payload, not events', async () => {
    const reader = new MockStreamReader([
      '%begin 1700000000 5 0',
      '%output %0 fake output',
      '%session-changed $0 fake',
      '%end 1700000000 5 0',
    ]);

    const stream = new TmuxEventStream(reader);
    const cmdPromise = stream.enqueueCommand();
    const events = await collectEvents(stream);

    // Only begin and end — payload lines are not emitted
    expect(events.map(e => e.type)).toEqual(['begin', 'end']);

    const response = await cmdPromise;
    expect(response.output).toEqual([
      '%output %0 fake output',
      '%session-changed $0 fake',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Mismatched command numbers
// ---------------------------------------------------------------------------

describe('TmuxEventStream — mismatched command numbers', () => {
  it('treats %end with wrong number as payload', async () => {
    const reader = new MockStreamReader([
      '%begin 1700000000 5 0',
      'some payload',
      '%end 1700000000 99 0',  // wrong command number
      '%end 1700000000 5 0',   // correct command number
    ]);

    const stream = new TmuxEventStream(reader);
    const cmdPromise = stream.enqueueCommand();
    const events = await collectEvents(stream);

    // The wrong-numbered %end is treated as an event (it's outside our block matching)
    // Actually — inside a block (openBlock=5), %end with number 99 doesn't match,
    // so it's payload. The %end with number 5 matches and closes the block.
    const response = await cmdPromise;
    expect(response.output).toEqual([
      'some payload',
      '%end 1700000000 99 0',  // treated as payload
    ]);
  });
});

// ---------------------------------------------------------------------------
// EOF with pending commands
// ---------------------------------------------------------------------------

describe('TmuxEventStream — EOF handling', () => {
  it('rejects pending commands on EOF', async () => {
    const reader = new MockStreamReader([
      '%begin 1700000000 1 0',
      // No %end — stream closes mid-block
    ]);

    const stream = new TmuxEventStream(reader);
    const cmdPromise = stream.enqueueCommand();
    const events = await collectEvents(stream);

    expect(events.map(e => e.type)).toEqual(['begin']);

    await expect(cmdPromise).rejects.toThrow('tmux control stream closed');
  });

  it('rejects queued commands that never got a %begin', async () => {
    const reader = new MockStreamReader([
      '%begin 1700000000 1 0',
      '%end 1700000000 1 0',
      // Second command never gets a response
    ]);

    const stream = new TmuxEventStream(reader);
    const cmd1 = stream.enqueueCommand();
    const cmd2 = stream.enqueueCommand();

    const events = await collectEvents(stream);

    const resp1 = await cmd1;
    expect(resp1.number).toBe(1);

    await expect(cmd2).rejects.toThrow('tmux control stream closed');
  });
});

// ---------------------------------------------------------------------------
// Notifications outside blocks
// ---------------------------------------------------------------------------

describe('TmuxEventStream — notifications', () => {
  it('emits notifications between command blocks', async () => {
    const reader = new MockStreamReader([
      '%session-changed $0 main',
      '%window-add @0',
      '%output %0 hello',
      '%layout-change @0 b25d,80x24,0,0,0',
    ]);

    const stream = new TmuxEventStream(reader);
    const events = await collectEvents(stream);

    expect(events.map(e => e.type)).toEqual([
      'session-changed',
      'window-add',
      'output',
      'layout-change',
    ]);

    // Verify output event data
    const outputEvent = events.find(e => e.type === 'output');
    expect(outputEvent).toBeDefined();
    if (outputEvent && outputEvent.type === 'output') {
      expect(outputEvent.paneId).toBe('%0');
      expect(Buffer.from(outputEvent.data).toString('utf-8')).toBe('hello');
    }
  });
});
