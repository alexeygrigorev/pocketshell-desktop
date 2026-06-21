/**
 * Unit tests for the `sendTextToPane` bracketed-paste gate (app §5 parity).
 *
 * `sendTextToPane` decides, from `(submit, text)`, whether to send the text as
 * a bracketed paste (`sendBracketedPaste`) or as legacy keystroke input
 * (`sendInput`). That decision is distilled into the pure helper
 * `shouldPasteAsBracketed`, which these tests pin down across all four
 * quadrants — especially the regression-critical guarantee that `submit:true`
 * callers (run_command / reply / the composer submit path) are byte-unchanged.
 *
 * The SUT module (`tmux-session-terminal.ts`) imports `vscode` for
 * `vscode.EventEmitter`; vitest.config.ts has no vscode stub, so we supply a
 * minimal one (same pattern as share-receptors.test.ts).
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => {
	class Emitter<T> {
		private listeners: ((e: T) => void)[] = [];
		readonly event = (listener: (e: T) => void): { dispose(): void } => {
			this.listeners.push(listener);
			return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
		};
		fire(e: T): void { for (const l of this.listeners) l(e); }
		dispose(): void { this.listeners = []; }
	}
	return { EventEmitter: Emitter };
});

import { shouldPasteAsBracketed } from '../../../extensions/pocketshell/src/feature/tmux-ui/tmux-session-terminal';

describe('shouldPasteAsBracketed (sendTextToPane gate)', () => {
	it('multiline + submit:false → bracketed paste (the parity fix)', () => {
		// This is the case the fix targets: pasting multiline text routes through
		// tmux's bracketed-paste path so the shell receives ONE pasted unit.
		expect(shouldPasteAsBracketed(false, 'line1\nline2')).toBe(true);
		expect(shouldPasteAsBracketed(false, 'a\nb\nc')).toBe(true);
		expect(shouldPasteAsBracketed(false, '\nleading')).toBe(true);
		expect(shouldPasteAsBracketed(false, 'trailing\n')).toBe(true);
	});

	it('single-line + submit:false → UNCHANGED (legacy sendInput, no markers)', () => {
		expect(shouldPasteAsBracketed(false, 'ls -la')).toBe(false);
		expect(shouldPasteAsBracketed(false, '')).toBe(false);
		// Lone CR is NOT a paragraph break (matches the app's containsLineBreak).
		expect(shouldPasteAsBracketed(false, 'a\rb')).toBe(false);
	});

	it('submit:true multiline → UNCHANGED (per-line Enter preserved, run_command/reply path)', () => {
		// Regression-critical: every submit:true caller must stay byte-identical.
		// Even multiline text with submit:true takes the sendInput(text + '\r')
		// path, NOT bracketed paste — that's the explicit "execute this" contract.
		expect(shouldPasteAsBracketed(true, 'line1\nline2')).toBe(false);
		expect(shouldPasteAsBracketed(true, 'single')).toBe(false);
		expect(shouldPasteAsBracketed(true, '')).toBe(false);
	});

	it('CRLF counts as a line break for the paste gate (matches containsLineBreak)', () => {
		// `\r\n` contains `\n`, so it routes to bracketed paste; the helper then
		// normalises CRLF → LF inside the frame (buildBracketedPasteHex).
		expect(shouldPasteAsBracketed(false, 'line1\r\nline2')).toBe(true);
	});
});
