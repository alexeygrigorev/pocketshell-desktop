/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * PURE helpers for the action-assistant mutating tools (Dispatch 2).
 *
 * These validate / build the inputs to the 6 mutating actions. They contain NO
 * vscode / SSH / tmux code (and NO cross-layer imports) so they are fully unit-
 * testable and mirrored byte-identical to
 * `extensions/pocketshell/src/backend/assistant/` (lesson #19).
 *
 * Security: model-controlled inputs (paths, folder names, repo full-names, file
 * content) must be shell-quoted and path-traversal-guarded before they reach a
 * shell. These helpers centralize that — the feature-layer action methods call
 * them and never hand raw model input to a shell.
 */

/**
 * The agent-name strings the model may send (the start_session tool enum). The
 * feature layer casts the non-shell members to its `SessionKind` (which is
 * structurally identical — `'shell' | 'claude' | 'codex' | 'opencode'`).
 */
export type AssistantAgentName = 'claude' | 'codex' | 'opencode' | 'shell';

/**
 * Map a model-supplied agent name to a launchable agent name, lower-cased and
 * validated. Returns null for an unknown name (the action reports a clear error
 * to the model).
 */
export function mapAgentNameToSessionKind(agent: string): AssistantAgentName | null {
	const lower = agent.trim().toLowerCase();
	if (lower === 'shell' || lower === 'claude' || lower === 'codex' || lower === 'opencode') {
		return lower;
	}
	return null;
}

/**
 * Whether a path contains a `..` segment (path traversal). Tilde-prefixed paths
 * are allowed. Both forward and backslash separators are checked so a Windows-
 * style `..\\` cannot slip through on a POSIX target.
 */
export function hasPathTraversal(path: string): boolean {
	const segments = path.split(/[\\/]/);
	return segments.some((seg) => seg === '..');
}

/**
 * Whether a folder name is a safe single path component (no separators, no `..`,
 * no leading dash that could be mistaken for a flag, non-empty). Used by
 * create_project before constructing an mkdir command.
 */
export function isSafeFolderName(folderName: string): boolean {
	const trimmed = folderName.trim();
	if (trimmed.length === 0) return false;
	if (trimmed === '.' || trimmed === '..') return false;
	// Reject anything containing a separator (no nested paths from the model).
	if (/[\\/]/.test(trimmed)) return false;
	// Reject a leading dash so the name can't read as an mkdir flag.
	if (trimmed.startsWith('-')) return false;
	return true;
}

/**
 * Shell-quote a single argument POSIX-style (single-quote, escaping embedded
 * single-quotes). Identical in behavior to `quoteShellArg` in
 * backend/sessions/create-session, kept here so the mutating helpers don't pull
 * in the sessions module transitively (and so the mirror has no feature import).
 */
export function shellQuote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Join a parent directory and a single folder name into an absolute path,
 * normalizing exactly one separating slash. Does NOT resolve `..` — callers
 * must have already rejected traversal via {@link isSafeFolderName}.
 */
export function joinPath(parent: string, name: string): string {
	const cleanParent = parent.endsWith('/') ? parent.slice(0, -1) : parent;
	return `${cleanParent}/${name}`;
}

/**
 * Build the `mkdir -p <quoted-path>` command for create_project. The path is
 * shell-quoted. Caller must have validated `folderName` and `parentPath`.
 */
export function buildMkdirCommand(parentPath: string, folderName: string): string {
	const target = joinPath(parentPath, folderName);
	return `mkdir -p ${shellQuote(target)}`;
}

/**
 * Build the absolute created path returned to the model on a successful
 * create_project (the joined parent + folder name, no shell quoting).
 */
export function buildCreatedPath(parentPath: string, folderName: string): string {
	return joinPath(parentPath, folderName);
}

/**
 * Resolve the clone target directory. If `folder` is a non-empty model-supplied
 * root, use it verbatim (the caller quotes it); otherwise fall back to
 * `defaultRoot` joined with the repo name parsed out of `fullName`.
 */
export function buildCloneTarget(fullName: string, folder: string | null, defaultRoot: string): string {
	if (folder && folder.trim().length > 0) {
		return folder;
	}
	const repoName = repoNameFromFullName(fullName);
	return `${defaultRoot.replace(/\/+$/, '')}/${repoName}`;
}

/** Parse the repo name (segment after the last `/`) out of an `owner/repo` full name. */
export function repoNameFromFullName(fullName: string): string {
	const cleaned = fullName.replace(/\/+$/, '');
	const idx = cleaned.lastIndexOf('/');
	return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/**
 * Build the `https://github.com/<fullName>` clone URL. Used only as a fallback
 * when the server-side `pocketshell repos clone` CLI is unavailable; the
 * primary path is PocketShellRepos.clone (server-side, no client credentials).
 */
export function buildCloneUrl(fullName: string): string {
	return `https://github.com/${fullName.replace(/^\/+/, '')}`;
}

/** The default heredoc delimiter used by {@link buildCreateFileHeredoc}. */
export const CREATE_FILE_HEREDOC_DELIMITER = 'POCKETSHELL_EOF';

/**
 * Build a quoted-delimiter heredoc that writes `content` to `path` byte-exact
 * with NO shell expansion. The delimiter is single-quoted (`<<'POCKETSHELL_EOF'`)
 * so the body is never interpreted.
 *
 * Delimiter-collision guard: if the content itself contains a line equal to the
 * delimiter, the heredoc would terminate early and corrupt the file. In that
 * (very rare) case we return an `error` so the caller falls back or reports a
 * clear failure rather than writing a truncated file.
 *
 * The path is shell-quoted; content is appended verbatim. A trailing newline is
 * ensured (heredocs require it before the closing delimiter).
 */
export function buildCreateFileHeredoc(
	path: string,
	content: string,
): { ok: true; command: string } | { ok: false; error: string } {
	const delimiter = CREATE_FILE_HEREDOC_DELIMITER;
	// Collision guard: a content line equal to the delimiter would close the
	// heredoc early. Check the raw lines (content may contain quotes / $ / etc.
	// which are all safe inside a quoted heredoc — only an exact-delimiter line
	// is dangerous).
	const lines = content.split('\n');
	if (lines.includes(delimiter)) {
		return {
			ok: false,
			error:
				`Cannot write the file safely: its contents contain the heredoc delimiter ` +
				`(${delimiter}). Use a different method to create this file.`,
		};
	}
	const body = content.endsWith('\n') ? content : content + '\n';
	const command =
		`cat > ${shellQuote(path)} <<'${delimiter}'\n` +
		body +
		`${delimiter}\n`;
	return { ok: true, command };
}
