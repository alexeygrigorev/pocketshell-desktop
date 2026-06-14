/**
 * Agent hooks module for PocketShell Desktop.
 *
 * Manages git hooks that trigger agent actions on remote repositories
 * via the `pocketshell hooks` CLI over SSH exec.
 */

export { HookManager } from './hook-manager';
export { HookType } from './types';
export type {
	AgentType,
	HookStatus,
	AgentHook,
	HookConfig,
} from './types';
