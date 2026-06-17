/**
 * SSH config usability helpers.
 *
 * Historically this module implemented an "import plan" that COPIED hosts from
 * `~/.ssh/config` into a separate SQLite store. That import-copy flow has been
 * removed: `~/.ssh/config` is now the single source of truth, and the live
 * host list is produced by `ssh-host-resolver.ts`.
 *
 * This file remains as the home for the host-usability / skip-reason logic and
 * re-exports the resolver helpers so existing callers can migrate without a
 * broken import path. New code should import directly from
 * `./ssh-host-resolver`.
 */

import type { SshConfigHost } from './ssh-config-parser';
import {
  getHostSkipReason,
  resolveHostForAlias,
  collectConcreteAliases,
  type SkipReasonOptions,
} from './ssh-host-resolver';

export { getHostSkipReason, resolveHostForAlias, collectConcreteAliases };
export type { SkipReasonOptions };

/**
 * Return the reason a parsed SSH config entry (looked up by alias) cannot be
 * used as a PocketShell host, or `undefined` if it is usable.
 *
 * Convenience wrapper around the resolver that resolves the alias first.
 */
export function explainHostUsability(
  alias: string,
  parsedHosts: SshConfigHost[],
  options: SkipReasonOptions = {},
): string | undefined {
  const source = parsedHosts.find(p => {
    const patterns = p.patterns && p.patterns.length > 0 ? p.patterns : [p.host];
    return patterns.some(
      pat => !pat.startsWith('!') && pat.toLowerCase() === alias.toLowerCase(),
    );
  });
  if (!source) {
    return `no Host block matches alias "${alias}"`;
  }
  const resolved = resolveHostForAlias(alias, parsedHosts, source);
  return getHostSkipReason(alias, resolved, options);
}
