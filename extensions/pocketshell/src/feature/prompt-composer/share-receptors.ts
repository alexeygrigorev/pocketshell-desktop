/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { PromptComposerAttachmentInput } from '../../backend/agents/prompt-composer';

/**
 * Pure helpers for the share-into-session receptors (app §5 parity).
 *
 * The receptors (`pocketshell.promptComposer.openWithClipboard`,
 * `openWithFiles`, `pasteSelectionToTerminal`, and the composer webview
 * drag-and-drop handler) are thin vscode-API command shims; the genuinely
 * testable logic lives here so it can be unit-tested without booting the
 * extension host.
 */

export interface FileUriDescriptor {
	uri: vscode.Uri;
	fsPath: string;
	displayName: string;
}

/**
 * Resolve a command argument into a flat list of file URIs. Accepts the
 * shapes VS Code passes when a command is bound to an explorer / editor
 * context menu: a single `vscode.Uri`, an array of `vscode.Uri`, or
 * `{ fsPath }` / `{ path }` / `{ scheme, fsPath }` objects. Returns an empty
 * list for anything else so the caller can surface a warning.
 */
export function resolveFileUriList(arg: unknown): FileUriDescriptor[] {
	if (Array.isArray(arg)) {
		return arg.flatMap(resolveFileUriList);
	}
	if (arg instanceof vscode.Uri) {
		return [describeUri(arg)];
	}
	if (arg && typeof arg === 'object') {
		const record = arg as { fsPath?: unknown; path?: unknown; scheme?: unknown };
		const scheme = typeof record.scheme === 'string' ? record.scheme : undefined;
		if (typeof record.fsPath === 'string') {
			return [describeUri(scheme === 'file' ? vscode.Uri.file(record.fsPath) : vscode.Uri.parse(record.fsPath))];
		}
		if (typeof record.path === 'string') {
			return [describeUri(vscode.Uri.parse(record.path))];
		}
	}
	return [];
}

/**
 * Build the {@link PromptComposerAttachmentInput} list that the existing
 * `addPromptComposerAttachments` / upload pipeline expects, from resolved
 * file descriptors. `createId` is injected so tests don't need crypto.
 */
export function buildAttachmentInputsFromDescriptors(
	descriptors: readonly FileUriDescriptor[],
	createId: () => string,
): PromptComposerAttachmentInput[] {
	return descriptors.map((descriptor) => ({
		id: createId(),
		localPath: descriptor.fsPath,
		displayName: descriptor.displayName,
	}));
}

/**
 * Parse the `files` payload of a webview `drop` message into URI strings.
 * The webview serializes dropped files as an array of URI/path strings (or a
 * single string); non-string / blank entries are ignored.
 */
export function parseDropFileUris(files: unknown): string[] {
	if (!Array.isArray(files)) {
		return typeof files === 'string' && files.trim() ? [files.trim()] : [];
	}
	const uris: string[] = [];
	for (const entry of files) {
		if (typeof entry === 'string' && entry.trim()) {
			uris.push(entry.trim());
		}
	}
	return uris;
}

/**
 * Resolve the text to paste into the active terminal. The priority order
 * matches the app's `pasteIntoSession` entry-point expectations: an explicit
 * command argument wins, then the active editor selection, then the
 * clipboard. Returns `undefined` when no text is available anywhere.
 *
 * The vscode-backed inputs (`selection`, `clipboardText`) are injected so the
 * priority logic can be unit-tested without the extension host.
 */
export function resolvePasteSelectionText(
	arg: unknown,
	selection: string | undefined,
	clipboardText: string | undefined,
): string | undefined {
	if (typeof arg === 'string' && arg.length > 0) {
		return arg;
	}
	if (selection && selection.length > 0) {
		return selection;
	}
	if (clipboardText && clipboardText.length > 0) {
		return clipboardText;
	}
	return undefined;
}

function describeUri(uri: vscode.Uri): FileUriDescriptor {
	return {
		uri,
		fsPath: uri.fsPath,
		displayName: uri.path.split('/').filter(Boolean).pop() ?? uri.fsPath,
	};
}
