/**
 * Terminal module for PocketShell Desktop.
 *
 * Manages the lifecycle of SSH terminal sessions (creation, tracking,
 * and destruction) via the TerminalManager. Each session is backed by
 * an SshTerminalBackend bridging xterm.js with a remote SSH PTY.
 */

export { TerminalManager, resetIdCounter } from './terminal-manager';
export { SshTerminalBackend } from './ssh-terminal-backend';
export { PtyAdapter } from './pty-adapter';
export type { Event } from './ssh-terminal-backend';
export type { TerminalOptions, SshTerminal } from './types';
