/**
 * Terminal module for PocketShell Desktop.
 *
 * Public API for the SSH terminal subsystem.
 */

export { SshTerminalBackend } from './ssh-terminal-backend';
export type { Event } from './ssh-terminal-backend';
export { TerminalManager, resetIdCounter } from './terminal-manager';
export { PtyAdapter } from './pty-adapter';
export type { TerminalOptions, SshTerminal } from './types';
