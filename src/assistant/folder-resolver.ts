/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure, vscode-free fuzzy folder resolver (kept like `command-safety` so it is
 * unit-testable without the extension host AND so the mirror is byte-identical,
 * lesson #19).
 *
 * Ported verbatim from the Android app's `FolderResolver.kt`. Given a free-text
 * query ("the AI shipping labs workshops folder") and the FULL candidate folder
 * set, it scores each candidate on TWO fields — the human `label` and the path
 * tail (`path`'s last segment) — and sorts them into three bands:
 *
 *  - **Confident**: a single clear winner (top score >= HIGH_SCORE and its
 *    margin over the runner-up >= CONFIDENT_MARGIN).
 *  - **Ambiguous**: multiple candidates cluster near the top (all within
 *    AMBIGUOUS_MARGIN of the leader and each >= LOW_SCORE).
 *  - **NoMatch**: nothing clears LOW_SCORE.
 *
 * Scoring is deterministic token overlap + substring + tail-exact bonuses; no
 * external fuzzy-match dependency. It is intentionally conservative: when the
 * query under-specifies, it lands in the ambiguous band so the user is ASKED
 * rather than silently sent to a best guess. Every FolderCandidate embedded in
 * any branch comes from the input list — the resolver never synthesises a path.
 */

/** One known folder the assistant can open a session in. */
export interface FolderCandidate {
	/** The absolute folder path (the only value ever used as a cwd). */
	readonly path: string;
	/** The human label (watched-folder label, or the path tail). */
	readonly label: string;
	/** Active tmux sessions in this folder (for the chooser). */
	readonly sessionCount?: number;
}

/** Outcome of resolving a fuzzy folder name against the known candidate set. */
export type FolderResolution =
	| { kind: 'confident'; candidate: FolderCandidate }
	| { kind: 'ambiguous'; candidates: FolderCandidate[] }
	| { kind: 'no_match'; nearest: FolderCandidate[] };

/** Minimum top score for a single confident match. */
const HIGH_SCORE = 0.55;
/** Top must beat the runner-up by this much to be confident. */
const CONFIDENT_MARGIN = 0.20;
/** Candidates within this margin of the leader are treated as a tie. */
const AMBIGUOUS_MARGIN = 0.20;
/** A candidate must reach this score to be a plausible match at all. */
const LOW_SCORE = 0.20;
/** How many "did you mean" suggestions to surface on a no-match. */
const NEAREST_LIMIT = 3;
/** Trailing path segments considered when matching multi-word queries. */
const PATH_CONTEXT_SEGMENTS = 3;
/** Path-context match counts slightly less than a label/tail match. */
const PATH_CONTEXT_WEIGHT = 0.9;

interface Scored {
	readonly candidate: FolderCandidate;
	readonly score: number;
}

/**
 * Resolve `query` against `candidates`. Both arguments are taken as-is; the
 * caller is responsible for supplying the FULL untruncated candidate set
 * (never a `take(N)` summary, which could silently drop the target).
 */
export function resolveFolder(query: string, candidates: readonly FolderCandidate[]): FolderResolution {
	const queryTokens = tokenize(query);
	if (candidates.length === 0 || queryTokens.length === 0) {
		return { kind: 'no_match', nearest: candidates.slice(0, NEAREST_LIMIT) };
	}

	const scored: Scored[] = candidates
		.map((candidate) => ({ candidate, score: score(queryTokens, candidate) }))
		// Stable, deterministic order: best score first; ties broken by the
		// shorter (more specific) label, then the path for total order.
		.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			if (a.candidate.label.length !== b.candidate.label.length) {
				return a.candidate.label.length - b.candidate.label.length;
			}
			return a.candidate.path < b.candidate.path ? -1 : a.candidate.path > b.candidate.path ? 1 : 0;
		});

	const top = scored[0];
	if (top.score < LOW_SCORE) {
		return { kind: 'no_match', nearest: scored.slice(0, NEAREST_LIMIT).map((s) => s.candidate) };
	}

	const cluster = scored.filter((s) => top.score - s.score <= AMBIGUOUS_MARGIN && s.score >= LOW_SCORE);
	const runnerUp = scored[1];
	const isClearWinner =
		top.score >= HIGH_SCORE && (runnerUp === undefined || top.score - runnerUp.score >= CONFIDENT_MARGIN);

	if (isClearWinner || cluster.length === 1) {
		return { kind: 'confident', candidate: top.candidate };
	}
	return { kind: 'ambiguous', candidates: cluster.map((s) => s.candidate) };
}

/**
 * Score one candidate against the tokenized query, taking the better of the
 * label match, the path-tail match, and the trailing path-context match.
 */
function score(queryTokens: readonly string[], candidate: FolderCandidate): number {
	const tail = candidate.path.substring(candidate.path.lastIndexOf('/') + 1);
	const labelScore = fieldScore(queryTokens, candidate.label);
	const tailScore = fieldScore(queryTokens, tail);
	// The path tail is the primary discriminator, but a multi-word query
	// often spans several path segments. Score the trailing segments too so
	// such a query lands a confident match without inflating bare-tail ties.
	const pathScore = fieldScore(queryTokens, pathContext(candidate.path)) * PATH_CONTEXT_WEIGHT;
	return Math.max(labelScore, tailScore, pathScore);
}

/** Last few path segments joined, for matching multi-segment queries. */
function pathContext(path: string): string {
	return path
		.replace(/^\/+|\/+$/g, '')
		.split('/')
		.slice(-PATH_CONTEXT_SEGMENTS)
		.join(' ');
}

function fieldScore(queryTokens: readonly string[], field: string): number {
	const fieldNorm = normalize(field);
	if (fieldNorm.trim().length === 0) return 0;
	const fieldTokens = tokenize(field);
	if (fieldTokens.length === 0) return 0;

	// Token overlap: fraction of query tokens that appear (as a token or a
	// token-substring) somewhere in the field. This is the core signal.
	let matchedQueryTokens = 0;
	for (const qt of queryTokens) {
		if (fieldTokens.some((ft) => ft === qt || ft.includes(qt) || qt.includes(ft))) {
			matchedQueryTokens++;
		}
	}
	const overlap = matchedQueryTokens / queryTokens.length;

	// Bonus when the whole query string appears as a contiguous substring of
	// the field (e.g. query "rov workshop" inside "rov-workshop").
	const joinedQuery = queryTokens.join('');
	const joinedField = fieldTokens.join('');
	const substringBonus = joinedField.includes(joinedQuery) ? 0.25 : 0;

	// Strong bonus for an exact field match (every token, both ways).
	const querySet = new Set(queryTokens);
	const fieldSet = new Set(fieldTokens);
	const exactBonus = fieldTokens.length === queryTokens.length && setsEqual(fieldSet, querySet) ? 0.35 : 0;

	return Math.min(overlap + substringBonus + exactBonus, 1.0);
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const v of a) {
		if (!b.has(v)) return false;
	}
	return true;
}

/** Lowercase + collapse separators so "ROV_Workshop" ~= "rov workshop". */
function normalize(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokenize(value: string): string[] {
	return normalize(value)
		.split(' ')
		.filter((t) => t.length > 0);
}
