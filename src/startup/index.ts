/**
 * Public surface of the pure startup-connection decider.
 *
 * Re-exported so consumers (the vscode-aware feature layer, tests) import from
 * a single entry point. Mirrored byte-identical at
 * `extensions/pocketshell/src/backend/startup/index.ts`.
 */

export {
  decideStartupAction,
  type StartupAction,
  type StartupDecisionInput,
  type StartupHost,
} from './decision';
