/**
 * Agents module for PocketShell Desktop.
 *
 * Exposes AI coding-agent detection over SSH. The conversation submodule
 * (`./conversation`) is re-exported separately from its own barrel.
 */

export { AgentDetector, parseVersion } from './agent-detector';
export { AgentType, AGENT_METADATA } from './types';
export type { DetectedAgent } from './types';
