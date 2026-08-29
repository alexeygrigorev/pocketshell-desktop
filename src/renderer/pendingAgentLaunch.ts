/**
 * One agent launch, parked by whoever CREATED the session and collected by
 * whoever owns a terminal for it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * Launching an agent is two operations that cannot happen in the same place:
 *
 *   1. **create the session** — an IPC call, doable from anywhere;
 *   2. **type the wrapper line into it** — which needs a live PTY, because the
 *      desktop cannot set `@ps_agent_kind` itself; the helper's
 *      `pocketshell agent` wrapper writes it in the process that BECOMES the
 *      agent.
 *
 * Inside a folder workspace those two are one click apart and
 * `FolderWorkspaceView` does both (`createSession` -> `armLaunch`). From the
 * SESSION PANEL they are not: the panel has no terminal, so the session it
 * creates only gets one after a route change into that folder's workspace.
 * Something has to carry the choice across that navigation.
 *
 * This is that something, and it is deliberately the smallest thing that can
 * be: a single slot, written by `NewSessionDialog` and taken by
 * `FolderWorkspaceView` on arrival. It is the same shape as
 * `files.requestReveal` — park a request, let the component that can service it
 * pick it up in its own time — which is the precedent this app already set for
 * "a thing asked for over here, performed over there".
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A REF AND NOT A PLAIN VARIABLE
 * ---------------------------------------------------------------------------
 *
 * The collector cannot poll and cannot rely on a lifecycle hook. Creating a
 * session in the folder that is ALREADY open re-uses the mounted
 * `FolderWorkspaceView` instance — only the route QUERY changes — so neither
 * `onMounted` nor the `folderKey` watch fires. A reactive slot means the
 * collector is one `watch` that covers both arrivals: a fresh mount and a
 * re-used one.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXPIRES
 * ---------------------------------------------------------------------------
 *
 * A parked launch is only collected if the user actually reaches the
 * workspace. They may not — `NewSessionDialog`'s outcome banner is a real stop
 * (a `tmux-fallback` session has no memory cap and the user is meant to read
 * that), and closing the dialog there is a legitimate end to the flow. Without
 * a deadline that stale slot would sit until the window closed and then fire
 * a `claude` into whatever session of that name existed when the user
 * eventually opened the folder — a command typed into a terminal minutes after
 * anyone asked for it. The TTL is generous because the user is expected to
 * READ the banner, not race it; it is a guard against abandonment, not a
 * latency budget. The launch's own PTY deadline
 * (`FolderWorkspaceView.LAUNCH_TIMEOUT_MS`) is a different clock and only
 * starts once this slot has been collected.
 *
 * The slot is keyed by connection AND session name so a collector can never
 * take a launch meant for another host, and so a workspace whose tab bar does
 * not (yet) hold that session leaves it parked rather than arming a launch at
 * a terminal that will never exist.
 */
import { shallowRef } from 'vue';
import type { LaunchChoice } from '../shared/agentLaunch';

/** A launch waiting for a terminal, and when it was asked for. */
export interface ParkedAgentLaunch {
  connectionId: string;
  /** The tmux session the host actually created — never a predicted name. */
  session: string;
  choice: LaunchChoice;
  /** `Date.now()` at park time. See {@link LAUNCH_HANDOFF_TTL_MS}. */
  parkedAt: number;
}

/**
 * How long a parked launch stays collectable.
 *
 * Two minutes: long enough that reading the outcome banner, thinking about it
 * and then pressing Open cannot lose the agent the user picked, short enough
 * that an abandoned flow cannot surprise them later in the session.
 */
export const LAUNCH_HANDOFF_TTL_MS = 120_000;

/**
 * The pending launch, or null.
 *
 * Exported as the ref itself so the collector can watch it. `shallowRef`
 * because the value is replaced wholesale and never mutated in place — nothing
 * reads a field of it reactively.
 */
export const parkedAgentLaunch = shallowRef<ParkedAgentLaunch | null>(null);

/**
 * Remember [choice] for [session] until someone with a terminal can run it.
 *
 * Overwrites any previous slot without ceremony. Two launches parked at once
 * would mean the user created two sessions without visiting either workspace,
 * and in that case the one they asked for LAST is the one they are about to
 * open — the older slot is already the abandoned case the TTL exists for.
 */
export function parkAgentLaunch(
  connectionId: string,
  session: string,
  choice: LaunchChoice,
  now: number = Date.now(),
): void {
  parkedAgentLaunch.value = { connectionId, session, choice, parkedAt: now };
}

/**
 * Take the parked launch if it belongs to [connectionId] and [session],
 * clearing the slot; null otherwise.
 *
 * A miss deliberately leaves the slot ALONE rather than clearing it. The
 * collector runs on every tab-bar change of every workspace on the way to the
 * right one, and a "not mine" answer must not consume a launch that the next
 * workspace is about to claim. Only an expired slot is cleared on a miss,
 * because nothing will ever claim it.
 */
export function takeAgentLaunch(
  connectionId: string | null,
  session: string,
  now: number = Date.now(),
): LaunchChoice | null {
  const parked = parkedAgentLaunch.value;
  if (!parked) return null;
  if (now - parked.parkedAt > LAUNCH_HANDOFF_TTL_MS) {
    parkedAgentLaunch.value = null;
    return null;
  }
  if (!connectionId || parked.connectionId !== connectionId) return null;
  if (parked.session !== session) return null;
  parkedAgentLaunch.value = null;
  return parked.choice;
}

/** Drop the slot. For tests and for a deliberate abandonment. */
export function clearAgentLaunch(): void {
  parkedAgentLaunch.value = null;
}
