/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FolderCandidate, FolderResolution } from './folder-resolver';

/**
 * The seam between the provider-agnostic agent loop and the live app surfaces
 * (terminal registry, connection service, tmux client, SFTP, git repos).
 *
 * Ported from the Android app's `AssistantActions.kt`. Every method here
 * corresponds to one or more tools in the catalog. The loop never touches
 * vscode / SSH / tmux directly — it only calls this interface — so the loop can
 * be unit-tested end to end against a hand-built fake that scripts tool outputs.
 *
 * The vscode-dependent production wiring lives in
 * `feature/assistant/desktop-assistant-actions.ts` (feature-layer, NOT mirrored
 * — like detect-ports-resolver / share-receptors, lesson #19).
 *
 * Methods that mutate remote / nav state (runCommand, createFile, startSession,
 * sendPromptToSession, createProject, cloneRepo) are only invoked by the loop
 * AFTER the user confirms the candidate via the confirm-or-correct gate. Inspect
 * / nav methods auto-run.
 *
 * Dispatch 1 stubs the 6 mutating methods: they exist on the interface and on
 * the desktop impl but return a clear "available in a follow-up" ActionResult.
 * Dispatch 2 fills in the real implementations behind the (already-built) gate.
 */

/** The outcome of a mutating tool. `ok` drives the trace `result` field. */
export interface ActionResult {
	readonly ok: boolean;
	readonly message: string;
}

export const ActionResult = {
	ok(message: string): ActionResult {
		return { ok: true, message };
	},
	error(message: string): ActionResult {
		return { ok: false, message };
	},
};

/**
 * Wraps a FolderResolver outcome for the `resolve_folder` tool, or a plain
 * error message when the host is unknown / its folders cannot be read.
 */
export type FolderResolutionResult =
	| { kind: 'resolved'; resolution: FolderResolution }
	| { kind: 'unavailable'; message: string };

/** Re-export FolderCandidate so action implementations can import from here. */
export type { FolderCandidate, FolderResolution };

export interface AssistantActions {
	// ---- Inspect (auto-run, read-only) ----------------------------------

	/**
	 * Snapshot of the current screen / host / session / cwd. Resolves
	 * "this folder", "this dir", "here", "it" for the model. Returns a
	 * JSON-ish text block the model can read.
	 */
	getContext(): Promise<string>;

	/** Host list (id + name + connected state). */
	listHosts(): Promise<string>;

	/** tmux folders on `host` (session name -> cwd grouping). */
	listFolders(host: string): Promise<string>;

	/**
	 * Resolve a fuzzy `query` folder name to a working directory on `host`,
	 * ranking the FULL known folder set (live session cwds + discovered /
	 * known project folders). Returns `unavailable` when the host is unknown
	 * or its folders cannot be read; the loop surfaces that as a plain tool
	 * message rather than a resolution.
	 */
	resolveFolder(host: string, query: string): Promise<FolderResolutionResult>;

	/** tmux sessions on `host`. */
	listSessions(host: string): Promise<string>;

	/** `ls -la` of `path` on the active host. */
	listDirectory(path: string): Promise<string>;

	/** First N KiB of `path` on the active host. */
	readFile(path: string): Promise<string>;

	/** `pocketshell repos list --json` on the active host. */
	listRepos(): Promise<string>;

	// ---- Act — navigation (auto) ----------------------------------------

	/** Navigate to the folder list / a folder on `host` rooted at `path`. */
	openFolder(host: string, path: string): Promise<string>;

	/** Attach to / open an existing tmux session by name. */
	openSession(sessionName: string): Promise<string>;

	/** Navigate to a named app screen (hosts, settings, usage, ...). */
	openScreen(destination: string): Promise<string>;

	// ---- Act — mutating (confirm-gated) ---------------------------------

	/** Create a tmux session in `cwd` on `host` launching `agent`. Returns the session name. */
	startSession(host: string, cwd: string, agent: string): Promise<ActionResult>;

	/** Send `prompt` to the agent running in `sessionName`. */
	sendPromptToSession(sessionName: string, prompt: string): Promise<ActionResult>;

	/** Create an empty project folder under `parentPath` on `host`. */
	createProject(host: string, parentPath: string, folderName: string): Promise<ActionResult>;

	/** Run `command` in the active terminal via send-keys. Safety gate has already passed. */
	runCommand(command: string): Promise<ActionResult>;

	/** Create a file at `path` with `content` on the active host. */
	createFile(path: string, content: string): Promise<ActionResult>;

	/** `pocketshell repos clone <fullName>` on the active host, optionally into `folder`. */
	cloneRepo(fullName: string, folder: string | null): Promise<ActionResult>;
}
