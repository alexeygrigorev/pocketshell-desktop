/**
 * FolderResolver tests — the 3 scoring bands (Confident / Ambiguous / NoMatch).
 *
 * The resolver scores each candidate on its label + path tail + trailing path
 * context, then sorts into bands. This test covers all three bands, the
 * multi-segment path-context match, the empty-candidate / empty-query guards,
 * and the "did you mean" nearest list on NoMatch.
 */

import { describe, it, expect } from 'vitest';
import { resolveFolder, type FolderCandidate } from '../../../src/assistant/folder-resolver';

function candidate(path: string, label?: string, sessionCount = 0): FolderCandidate {
	return { path, label: label ?? path.slice(path.lastIndexOf('/') + 1), sessionCount };
}

const CANDIDATES: FolderCandidate[] = [
	candidate('/home/user/workshops/rov-workshop', 'ROV Workshop'),
	candidate('/home/user/workshops/drone-workshop', 'Drone Workshop'),
	candidate('/home/user/projects/ai-shipping-labs/workshops', 'AI Shipping Labs Workshops'),
	candidate('/home/user/personal/notes'),
];

describe('FolderResolver — Confident band', () => {
	it('returns a confident match on an exact label', () => {
		const r = resolveFolder('ROV Workshop', CANDIDATES);
		expect(r.kind).toBe('confident');
		if (r.kind === 'confident') {
			expect(r.candidate.path).toBe('/home/user/workshops/rov-workshop');
		}
	});

	it('returns a confident match on a path-tail substring', () => {
		const r = resolveFolder('rov-workshop', CANDIDATES);
		expect(r.kind).toBe('confident');
		if (r.kind === 'confident') {
			expect(r.candidate.label).toBe('ROV Workshop');
		}
	});

	it('returns a confident match on a multi-segment path-context query', () => {
		// "ai shipping labs workshops" spans trailing path segments.
		const r = resolveFolder('ai shipping labs workshops', CANDIDATES);
		expect(r.kind).toBe('confident');
		if (r.kind === 'confident') {
			expect(r.candidate.path).toBe('/home/user/projects/ai-shipping-labs/workshops');
		}
	});

	it('is case-insensitive (ROV_Workshop ~= rov workshop)', () => {
		const r = resolveFolder('rov workshop', [
			candidate('/x/ROV_Workshop'),
		]);
		expect(r.kind).toBe('confident');
	});

	it('clears the runner-up by the CONFIDENT_MARGIN', () => {
		// Only one candidate matches "drone"; the rest are far below.
		const r = resolveFolder('drone workshop', CANDIDATES);
		expect(r.kind).toBe('confident');
		if (r.kind === 'confident') {
			expect(r.candidate.label).toBe('Drone Workshop');
		}
	});
});

describe('FolderResolver — Ambiguous band', () => {
	it('returns ambiguous when multiple candidates tie near the top', () => {
		// Two "workshop" candidates both match "workshop" comparably.
		const r = resolveFolder('workshop', [
			candidate('/a/rov-workshop'),
			candidate('/b/drone-workshop'),
			candidate('/c/notes'),
		]);
		expect(r.kind).toBe('ambiguous');
		if (r.kind === 'ambiguous') {
			expect(r.candidates.length).toBeGreaterThanOrEqual(2);
		}
	});

	it('ambiguous candidates come from the input set (never synthesised)', () => {
		const inputs = [candidate('/a/foo'), candidate('/b/foo')];
		const r = resolveFolder('foo', inputs);
		if (r.kind === 'ambiguous') {
			for (const c of r.candidates) {
				expect(inputs.some((i) => i.path === c.path)).toBe(true);
			}
		}
	});
});

describe('FolderResolver — NoMatch band', () => {
	it('returns no_match when nothing clears the LOW_SCORE threshold', () => {
		const r = resolveFolder('qqqqqqxxxxx', CANDIDATES);
		expect(r.kind).toBe('no_match');
		if (r.kind === 'no_match') {
			// Surfaces up to 3 "did you mean" nearest.
			expect(r.nearest.length).toBeLessThanOrEqual(3);
		}
	});

	it('returns no_match with the input candidates when the query is empty', () => {
		const r = resolveFolder('', CANDIDATES);
		expect(r.kind).toBe('no_match');
	});

	it('returns no_match when the candidate list is empty', () => {
		const r = resolveFolder('anything', []);
		expect(r.kind).toBe('no_match');
		if (r.kind === 'no_match') {
			expect(r.nearest).toEqual([]);
		}
	});

	it("nearest list is capped at 3", () => {
		const many = Array.from({ length: 10 }, (_, i) => candidate(`/p/folder${i}`));
		const r = resolveFolder('zzz', many);
		if (r.kind === 'no_match') {
			expect(r.nearest.length).toBeLessThanOrEqual(3);
		}
	});
});

describe('FolderResolver — determinism + ordering', () => {
	it('is deterministic (same input -> same output)', () => {
		const a = resolveFolder('workshop', CANDIDATES);
		const b = resolveFolder('workshop', CANDIDATES);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	it('within the ambiguous band, ties are broken by shorter label, then path ascending', () => {
		// Two exact-tail matches: "foo" at /short/foo and /a/very/long/path/foo.
		// Both score identically and have the same label length ("foo"), so the
		// path-ascending tiebreak applies: /a/... sorts before /short/...
		const r = resolveFolder('foo', [
			candidate('/short/foo'),
			candidate('/a/very/long/path/foo'),
		]);
		expect(r.kind).toBe('ambiguous');
		if (r.kind === 'ambiguous') {
			expect(r.candidates[0].path).toBe('/a/very/long/path/foo');
		}
		// Same scores but different label lengths: shorter label first.
		const r2 = resolveFolder('x', [
			candidate('/p/longerlabel', 'longerlabel'),
			candidate('/q/x', 'x'),
		]);
		if (r2.kind === 'ambiguous') {
			expect(r2.candidates[0].label).toBe('x');
		}
	});
});
