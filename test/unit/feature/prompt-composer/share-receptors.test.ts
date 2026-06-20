/**
 * Unit tests for the share-into-session receptors (app §5 parity).
 *
 * The receptors themselves (`pocketshell.promptComposer.openWithClipboard`,
 * `openWithFiles`, `pasteSelectionToTerminal`, and the composer webview
 * drag-and-drop handler) are thin VS Code command shims; the genuinely
 * testable logic lives in `share-receptors.ts`, which is pure (only the
 * `vscode.Uri` constructor is used) so it can be unit-tested directly.
 *
 * Covers:
 *   - `resolveFileUriList`: single Uri, Uri arrays, `{fsPath}`/`{path}` objects,
 *     file-scheme coercion, non-file args → empty list.
 *   - `buildAttachmentInputsFromDescriptors`: descriptor → attachment-input
 *     shape, injected `createId`.
 *   - `parseDropFileUris`: array vs single string vs garbage filtering.
 *   - `resolvePasteSelectionText`: explicit-arg > selection > clipboard priority,
 *     all-empty → undefined.
 */

import { describe, it, expect, vi } from 'vitest';

/**
 * The SUT (`share-receptors.ts`) does `import * as vscode from 'vscode'` and
 * uses `vscode.Uri.file` / `vscode.Uri.parse` plus `.fsPath` / `.path` /
 * `.scheme` / `.toString()`. vitest.config.ts has NO vscode alias/stub (see
 * startup-auto-connector.test.ts for the same pattern), so we provide a
 * minimal functional Uri stub that is enough to exercise the parsing logic.
 * Only `Uri.file` and `Uri.parse` are exercised; we model `file://` URIs
 * faithfully because `resolveFileUriList` routes file-scheme `fsPath` through
 * `Uri.file`.
 */
vi.mock('vscode', () => {
	class UriStub {
		readonly scheme: string;
		readonly path: string;
		constructor(scheme: string, path: string) {
			this.scheme = scheme;
			this.path = path;
		}
		get fsPath(): string {
			return this.path.startsWith('/') ? this.path : `/${this.path}`;
		}
		toString(): string {
			return `${this.scheme}://${this.path}`;
		}
		static file(path: string): UriStub {
			const normalized = path.startsWith('/') ? path : `/${path}`;
			return new UriStub('file', normalized);
		}
		static parse(value: string): UriStub {
			const match = /^([\w-]+):\/\/?(.*)$/.exec(value);
			if (match) {
				const [, scheme, rest] = match;
				return new UriStub(scheme, rest.startsWith('/') ? rest : `/${rest}`);
			}
			return new UriStub('file', value);
		}
	}
	return { Uri: UriStub };
});

import * as vscode from 'vscode';
import {
	buildAttachmentInputsFromDescriptors,
	parseDropFileUris,
	resolveFileUriList,
	resolvePasteSelectionText,
} from '../../../../extensions/pocketshell/src/feature/prompt-composer/share-receptors';

describe('share-into-session receptors', () => {
	describe('resolveFileUriList', () => {
		it('returns a descriptor for a single vscode.Uri', () => {
			const uri = vscode.Uri.file('/tmp/note.txt');
			const result = resolveFileUriList(uri);
			expect(result).toHaveLength(1);
			expect(result[0].fsPath).toBe(uri.fsPath);
			expect(result[0].displayName).toBe('note.txt');
			expect(result[0].uri.toString()).toBe(uri.toString());
		});

		it('flattens an array of Uris', () => {
			const a = vscode.Uri.file('/tmp/a.txt');
			const b = vscode.Uri.file('/var/log/b.log');
			const result = resolveFileUriList([a, b]);
			expect(result.map((d) => d.displayName)).toEqual(['a.txt', 'b.log']);
		});

		it('accepts a {fsPath} object with file scheme', () => {
			const result = resolveFileUriList({ scheme: 'file', fsPath: '/home/u/report.md' });
			expect(result).toHaveLength(1);
			expect(result[0].displayName).toBe('report.md');
			expect(result[0].uri.scheme).toBe('file');
		});

		it('accepts a {path} object', () => {
			const result = resolveFileUriList({ path: 'file:///etc/config.json' });
			expect(result).toHaveLength(1);
			expect(result[0].fsPath).toBe('/etc/config.json');
			expect(result[0].displayName).toBe('config.json');
		});

		it('returns an empty list for non-file args', () => {
			expect(resolveFileUriList(undefined)).toEqual([]);
			expect(resolveFileUriList(null)).toEqual([]);
			expect(resolveFileUriList('just a string')).toEqual([]);
			expect(resolveFileUriList(42)).toEqual([]);
			expect(resolveFileUriList({})).toEqual([]);
			expect(resolveFileUriList({ scheme: 'file' })).toEqual([]);
		});

		it('ignores non-Uri entries inside an array', () => {
			const result = resolveFileUriList([
				vscode.Uri.file('/tmp/keep.txt'),
				'string-entry',
				null,
				{ notAUri: true },
				vscode.Uri.file('/tmp/also-keep.csv'),
			]);
			expect(result.map((d) => d.displayName)).toEqual(['keep.txt', 'also-keep.csv']);
		});

		it('handles nested arrays', () => {
			const result = resolveFileUriList([
				[vscode.Uri.file('/a.txt'), vscode.Uri.file('/b.txt')],
				[vscode.Uri.file('/c.txt')],
			]);
			expect(result.map((d) => d.displayName)).toEqual(['a.txt', 'b.txt', 'c.txt']);
		});
	});

	describe('buildAttachmentInputsFromDescriptors', () => {
		it('maps descriptors to PromptComposerAttachmentInput using the injected createId', () => {
			let counter = 0;
			const createId = () => `id-${++counter}`;
			const descriptors = resolveFileUriList([
				vscode.Uri.file('/tmp/one.txt'),
				vscode.Uri.file('/tmp/two.log'),
			]);
			const inputs = buildAttachmentInputsFromDescriptors(descriptors, createId);
			expect(inputs).toEqual([
				{ id: 'id-1', localPath: descriptors[0].fsPath, displayName: 'one.txt' },
				{ id: 'id-2', localPath: descriptors[1].fsPath, displayName: 'two.log' },
			]);
		});

		it('returns an empty list for no descriptors', () => {
			const inputs = buildAttachmentInputsFromDescriptors([], () => 'x');
			expect(inputs).toEqual([]);
		});
	});

	describe('parseDropFileUris', () => {
		it('returns the strings from an array, trimming and dropping blanks', () => {
			const result = parseDropFileUris([
				'file:///tmp/a.txt',
				'  file:///tmp/b.txt  ',
				'',
				'   ',
				null,
				123,
				'file:///tmp/c.txt',
			]);
			expect(result).toEqual([
				'file:///tmp/a.txt',
				'file:///tmp/b.txt',
				'file:///tmp/c.txt',
			]);
		});

		it('accepts a single string payload', () => {
			expect(parseDropFileUris('file:///tmp/single.md')).toEqual(['file:///tmp/single.md']);
			expect(parseDropFileUris('   ')).toEqual([]);
		});

		it('returns an empty list for non-string payloads', () => {
			expect(parseDropFileUris(undefined)).toEqual([]);
			expect(parseDropFileUris(null)).toEqual([]);
			expect(parseDropFileUris(42)).toEqual([]);
			expect(parseDropFileUris({})).toEqual([]);
		});
	});

	describe('resolvePasteSelectionText', () => {
		it('prefers an explicit string argument over selection and clipboard', () => {
			const text = resolvePasteSelectionText('arg-text', 'selection-text', 'clip-text');
			expect(text).toBe('arg-text');
		});

		it('falls back to the editor selection when no explicit arg', () => {
			const text = resolvePasteSelectionText(undefined, 'selection-text', 'clip-text');
			expect(text).toBe('selection-text');
		});

		it('falls back to the clipboard when no arg and no selection', () => {
			const text = resolvePasteSelectionText(undefined, undefined, 'clip-text');
			expect(text).toBe('clip-text');
		});

		it('returns undefined when nothing is available', () => {
			expect(resolvePasteSelectionText(undefined, undefined, undefined)).toBeUndefined();
		});

		it('ignores an empty-string explicit arg', () => {
			expect(resolvePasteSelectionText('', 'selection-text', 'clip-text')).toBe('selection-text');
		});

		it('ignores an empty selection and falls through to the clipboard', () => {
			expect(resolvePasteSelectionText(undefined, '', 'clip-text')).toBe('clip-text');
		});

		it('ignores an empty clipboard', () => {
			expect(resolvePasteSelectionText(undefined, undefined, '')).toBeUndefined();
		});

		it('treats a non-string arg (e.g. a Uri object) as absent and falls through', () => {
			const uri = vscode.Uri.file('/tmp/x');
			const text = resolvePasteSelectionText(uri, 'selection-text', 'clip-text');
			expect(text).toBe('selection-text');
		});
	});
});
