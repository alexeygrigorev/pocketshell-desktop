/**
 * tmux -CC Control Mode Stream Framer
 *
 * Ported from PocketShell Android: ControlEventStream.kt
 * Reference: docs/tmux-protocol-reference.md sections 7, 6
 *
 * Handles %begin/%end/%error framing over a byte stream,
 * correlating response blocks with command numbers.
 * Emits events via EventEmitter and collects command responses.
 */

import { EventEmitter } from 'events';
import { parseLine } from './parser';
import type { ControlEvent, CommandResponse } from './events';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LF = 0x0A;
const CR = 0x0D;
const DEFAULT_LINE_BUFFER = 4096;
const READ_CHUNK_SIZE = 8192;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StreamReader {
  read(): Promise<Buffer | null>;
}

export interface PendingCommand {
  number: number | null;
  resolve: (response: CommandResponse) => void;
  reject: (error: Error) => void;
  output: string[];
}

// ---------------------------------------------------------------------------
// TmuxEventStream
// ---------------------------------------------------------------------------

/**
 * Reads raw bytes from an SSH shell stdout stream, frames tmux -CC lines,
 * handles %begin/%end/%error response block correlation, and emits parsed
 * ControlEvents.
 *
 * Reference: section 7
 */
export class TmuxEventStream extends EventEmitter {
  private reader: StreamReader;
  private openBlock: number | null = null;
  private currentPayload: string[] = [];
  private pendingQueue: PendingCommand[] = [];
  private inflight: PendingCommand | null = null;
  private lineBuffer: Buffer;
  private running = false;

  constructor(reader: StreamReader) {
    super();
    this.reader = reader;
    this.lineBuffer = Buffer.alloc(DEFAULT_LINE_BUFFER);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Start reading from the stream. Emits 'event' for each ControlEvent
   * and resolves pending command promises when response blocks complete.
   *
   * Reference: section 7.2
   */
  async run(): Promise<void> {
    this.running = true;

    try {
      let bufferPos = 0;

      while (this.running) {
        const chunk = await this.reader.read();
        if (chunk === null) {
          // EOF — process any remaining partial line
          if (bufferPos > 0) {
            this.processLine(Buffer.from(this.lineBuffer.subarray(0, bufferPos)));
          }
          break;
        }

        let chunkOffset = 0;
        while (chunkOffset < chunk.length) {
          // Find next LF in chunk
          let lfIdx = -1;
          for (let i = chunkOffset; i < chunk.length; i++) {
            if (chunk[i] === LF) {
              lfIdx = i;
              break;
            }
          }

          if (lfIdx === -1) {
            // No LF in remaining chunk — append to line buffer
            this.ensureBufferCapacity(bufferPos + (chunk.length - chunkOffset));
            chunk.copy(this.lineBuffer, bufferPos, chunkOffset);
            bufferPos += chunk.length - chunkOffset;
            break;
          }

          // Append bytes up to (but not including) LF to line buffer
          const lineLen = lfIdx - chunkOffset;
          this.ensureBufferCapacity(bufferPos + lineLen);
          chunk.copy(this.lineBuffer, bufferPos, chunkOffset, lfIdx);
          bufferPos += lineLen;

          // Trim trailing CR if present
          if (bufferPos > 0 && this.lineBuffer[bufferPos - 1] === CR) {
            bufferPos--;
          }

          // Process the complete line
          // Must copy the line data since parseLine returns views into the buffer,
          // and the buffer will be overwritten by the next line.
          if (bufferPos > 0) {
            const lineCopy = Buffer.from(this.lineBuffer.subarray(0, bufferPos));
            this.processLine(lineCopy);
          }
          bufferPos = 0;

          // Skip the LF
          chunkOffset = lfIdx + 1;
        }
      }
    } finally {
      this.running = false;
      this.drainPendingOnClose();
      this.emit('end');
    }
  }

  /**
   * Stop the stream reader.
   */
  stop(): void {
    this.running = false;
  }

  /**
   * Register a pending command to be resolved when its response block arrives.
   * Returns a promise that resolves with the CommandResponse.
   */
  enqueueCommand(number?: number): Promise<CommandResponse> {
    return new Promise<CommandResponse>((resolve, reject) => {
      this.pendingQueue.push({
        number: number ?? null,
        resolve,
        reject,
        output: [],
      });
    });
  }

  // -----------------------------------------------------------------------
  // Line processing (state machine from section 7.2)
  // -----------------------------------------------------------------------

  private processLine(line: Buffer): void {
    // Inside a %begin/%end block
    if (this.openBlock !== null) {
      // Try to parse as event (might be %end or %error closing this block)
      const event = parseLine(line);

      if (event !== null) {
        if ((event.type === 'end' || event.type === 'error') && event.number === this.openBlock) {
          // Block close with matching command number
          const isError = event.type === 'error';
          this.openBlock = null;

          // Resolve the pending command
          if (this.inflight) {
            const response: CommandResponse = {
              number: event.number,
              output: this.currentPayload,
              isError,
            };
            this.inflight.resolve(response);
            this.inflight = null;
          }
          this.currentPayload = [];

          // Also emit the end/error event
          this.emit('event', event);
          return;
        }
      }

      // Otherwise this is payload — not an event
      // Reference: section 7.3 — payload lines are opaque
      const decoded = line.toString('utf-8');
      this.currentPayload.push(decoded);

      // Also feed to inflight command
      if (this.inflight) {
        this.inflight.output.push(decoded);
      }
      return;
    }

    // Outside a block — parse normally
    const event = parseLine(line);
    if (event === null) return;

    if (event.type === 'begin') {
      // Start of a new response block
      this.openBlock = event.number;
      this.currentPayload = [];

      // Dequeue the next pending command
      if (this.pendingQueue.length > 0) {
        this.inflight = this.pendingQueue.shift()!;
        this.inflight.number = event.number;
        this.inflight.output = [];
      }
    }

    // Emit all events (including begin)
    this.emit('event', event);
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private ensureBufferCapacity(needed: number): void {
    if (needed <= this.lineBuffer.length) return;
    let newSize = this.lineBuffer.length;
    while (newSize < needed) newSize *= 2;
    const newBuffer = Buffer.alloc(newSize);
    this.lineBuffer.copy(newBuffer);
    this.lineBuffer = newBuffer;
  }

  private drainPendingOnClose(): void {
    const err = new Error('tmux control stream closed');
    if (this.inflight) {
      this.inflight.reject(err);
      this.inflight = null;
    }
    for (const pending of this.pendingQueue) {
      pending.reject(err);
    }
    this.pendingQueue = [];
  }
}
