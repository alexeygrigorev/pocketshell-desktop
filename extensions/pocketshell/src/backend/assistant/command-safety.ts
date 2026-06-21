/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Forbidden-pattern + length safety checks for shell commands the assistant
 * wants to run.
 *
 * Ported verbatim from the Android app's `core-voice` CommandPlanner gate
 * (migrated wholesale into `CommandSafety.kt` for issue #266). Multi-statement
 * payloads (joined with `;` / `&&` / `|`) are allowed — the forbidden patterns
 * are anchored on statement boundaries exactly like the planner's were, so
 * `sudo`, `rm -rf`, `shutdown`, `dd`, `mkfs`, writes to raw block devices, etc.
 * are rejected wherever they appear in the command, not just at the start.
 *
 * Kept pure / vscode-free so the agent loop can unit-test the gate without the
 * extension host AND so the mirror is byte-identical (lesson #19). This is the
 * mutating-action guard; built in Dispatch 1, exercised by the mutating tools
 * in Dispatch 2.
 */

/** Hard cap on a single proposed command's length (chars). */
export const MAX_COMMAND_LENGTH = 500;

/**
 * Default forbidden patterns. Copied verbatim from the planner's
 * `DEFAULT_FORBIDDEN_COMMAND_PATTERNS` so the migrated gate keeps the exact
 * same safety surface — `sudo` / `su`, recursive-force `rm`, `shutdown` /
 * `reboot` / `halt`, `mkfs`, `dd`, and redirecting onto a raw block device.
 * Anchored on a line start or a `;` / `&` / `|` statement boundary so they
 * fire mid-pipeline too.
 */
export const DEFAULT_FORBIDDEN_PATTERNS: readonly string[] = [
	String.raw`(^|[;&|]\s*)sudo\b`,
	String.raw`(^|[;&|]\s*)su\b`,
	String.raw`(^|[;&|]\s*)rm\s+-[^\n;]*[rf][^\n;]*[rf]`,
	String.raw`(^|[;&|]\s*)shutdown\b`,
	String.raw`(^|[;&|]\s*)reboot\b`,
	String.raw`(^|[;&|]\s*)halt\b`,
	String.raw`(^|[;&|]\s*)mkfs(\.|$|\s)`,
	String.raw`(^|[;&|]\s*)dd\s+`,
	String.raw`>\s*/dev/(sd|nvme|mapper/)`,
];

interface CompiledPattern {
	readonly source: string;
	readonly regex: RegExp;
}

const compiledDefaults: CompiledPattern[] = DEFAULT_FORBIDDEN_PATTERNS.map((source) => ({
	source,
	regex: new RegExp(source, 'i'),
}));

/**
 * Validate a single proposed command. Returns `null` when the command is safe
 * to execute, or a human-readable rejection reason otherwise. The reason is
 * surfaced back into the agent loop (and to the user) so the model can revise
 * instead of silently dropping the request.
 */
export function rejectCommand(command: string): string | null {
	const trimmed = command.trim();
	if (trimmed.length === 0) {
		return 'The proposed command was empty.';
	}
	if (trimmed.length > MAX_COMMAND_LENGTH) {
		return `The proposed command was too long (over ${MAX_COMMAND_LENGTH} characters).`;
	}
	if (/\0|[\r\n]/.test(trimmed)) {
		return 'The proposed command contained a control character.';
	}
	const normalized = trimmed.toLowerCase();
	for (const compiled of compiledDefaults) {
		if (compiled.regex.test(normalized)) {
			return `The proposed command is blocked by safety rule \`${compiled.source}\`.`;
		}
	}
	return null;
}
