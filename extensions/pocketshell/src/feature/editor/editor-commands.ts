/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ConnectionService } from '../../connection-service';
import { resolveHostId, getOrConnect } from '../../host-picking';
import { SftpClient } from '../../backend/files/sftp-client';
import type { SshConnection } from '../../backend/ssh/connection/ssh-client';
import {
	DocumentManager,
	RemoteSaveManager,
} from '../../backend/editor';
import type {
	RemoteDocument,
	RemoteFileMetadata,
	SftpAdapter,
} from '../../backend/editor';
import type { FeatureDeps } from '../manifest';
import { SftpClientAdapter } from './sftp-adapter-impl';

/**
 * Editor feature: registers commands that open remote files into a
 * DocumentManager/RemoteSaveManager pipeline and mirror their content into
 * VS Code text editors.
 *
 * State is held in a single per-registration EditorState: one DocumentManager
 * plus one RemoteSaveManager built lazily around a freshly connected SftpClient.
 * Documents are tracked by their remote path and remembered in a Map so that
 * "save" and "revert" can find the RemoteDocument backing the active editor.
 *
 * Open mirrors remote content into an untitled VS Code editor and remembers the
 * association; save reads the editor's current text back into the RemoteDocument
 * (updateContent) before flushing to the server; revert restores the original
 * content in both the RemoteDocument and the editor.
 */
export function registerEditor(
	service: ConnectionService,
	_ctx: vscode.ExtensionContext,
	_deps: FeatureDeps,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	const output = vscode.window.createOutputChannel('PocketShell Editor');
	disposables.push(output);

	const state = new EditorState();

	// -------------------------------------------------------------------------
	// pocketshell.editor.open — read: fetch remote file, open in an editor
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.editor.open', async () => {
			const hostId = await resolveHostId(service, undefined, { connectedOnly: true });
			if (hostId === undefined) {
				return;
			}
			const conn = await getOrConnect(service, hostId);
			if (conn === null) {
				return;
			}

			const remotePath = await vscode.window.showInputBox({
				prompt: 'Remote file path',
				value: '/home/',
			});
			if (remotePath === undefined) {
				return;
			}

			try {
				// Already-open remote files must not re-enter openDocument(),
				// which throws "Document already open". Focus the existing
				// editor instead.
				const existing = state.documents.getDocument(remotePath);
				if (existing) {
					const bound = state.editorFor(remotePath);
					if (bound) {
						await vscode.window.showTextDocument(bound.document);
					}
					return;
				}

				const sftp = await state.client(conn);
				const content = await sftp.readFileText(remotePath);
				const stat = await sftp.stat(remotePath);
				const metadata: RemoteFileMetadata = {
					path: remotePath,
					size: stat.size,
					modifiedAt: stat.modifiedAt,
				};

				const doc = state.documents.openDocument(remotePath, content, metadata);

				const editor = await openEditorFor(doc);
				state.bindEditor(remotePath, editor);

				output.appendLine(`opened ${remotePath} (${stat.size} bytes)`);
				output.show(true);
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Failed to open remote file: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.editor.save — mutate: flush active editor to the server
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.editor.save', async () => {
			const entry = state.entryForActiveEditor();
			if (entry === undefined) {
				vscode.window.showWarningMessage(
					vscode.l10n.t('No remote document is active in this editor.'),
				);
				return;
			}

			const { doc, editor } = entry;
			// Pull the editor's current text back into the document model.
			doc.updateContent(editor.document.getText());

			try {
				const result = await state.saver().save(doc);
				if (result.success) {
					// Refresh the editor to reflect the post-save (original) content.
					await writeEditor(editor, doc.content);
					output.appendLine(`saved ${doc.path}`);
					output.show(true);
					vscode.window.showInformationMessage(
						vscode.l10n.t('Saved {0}', doc.path),
					);
				} else {
					vscode.window.showErrorMessage(
						vscode.l10n.t('Save failed: {0}', result.error ?? 'unknown error'),
					);
				}
			} catch (err) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Save failed: {0}', String(err)),
				);
			}
		}),
	);

	// -------------------------------------------------------------------------
	// pocketshell.editor.revert — mutate: discard edits, restore original
	// -------------------------------------------------------------------------
	disposables.push(
		vscode.commands.registerCommand('pocketshell.editor.revert', async () => {
			const entry = state.entryForActiveEditor();
			if (entry === undefined) {
				vscode.window.showWarningMessage(
					vscode.l10n.t('No remote document is active in this editor.'),
				);
				return;
			}

			const { doc, editor } = entry;
			doc.revert();
			await writeEditor(editor, doc.content);
			vscode.window.showInformationMessage(
				vscode.l10n.t('Reverted {0} to last saved version', doc.path),
			);
		}),
	);

	return disposables;
}

// -----------------------------------------------------------------------------
// Per-registration state
// -----------------------------------------------------------------------------

/** Tracks one SftpClient, the document manager, and editor bindings. */
class EditorState {
	readonly documents = new DocumentManager();

	private cachedClient: SftpClient | null = null;
	private saverCache: RemoteSaveManager | null = null;
	private readonly editors = new Map<string, vscode.TextEditor>();

	/**
	 * Connect a SftpClient around `conn` on first use and return it wrapped as
	 * an SftpAdapter. Subsequent calls reuse the cached client while it stays
	 * connected; a dropped client is discarded and rebuilt.
	 */
	async client(conn: SshConnection): Promise<SftpAdapter> {
		if (this.cachedClient && this.cachedClient.connected) {
			return new SftpClientAdapter(this.cachedClient);
		}
		if (this.cachedClient) {
			this.cachedClient.disconnect();
			this.cachedClient = null;
		}
		const client = new SftpClient(conn);
		await client.connect();
		this.cachedClient = client;
		return new SftpClientAdapter(client);
	}

	/** Build (or reuse) the RemoteSaveManager bound to the live SftpClient. */
	saver(): RemoteSaveManager {
		if (!this.saverCache) {
			if (!this.cachedClient) {
				throw new Error('Editor: SFTP client not open. Open a file first.');
			}
			this.saverCache = new RemoteSaveManager(new SftpClientAdapter(this.cachedClient));
		}
		return this.saverCache;
	}

	/** Remember which VS Code editor is backing a remote path. */
	bindEditor(path: string, editor: vscode.TextEditor): void {
		this.editors.set(path, editor);
	}

	/** Look up the VS Code editor bound to a remote path, if any. */
	editorFor(path: string): vscode.TextEditor | undefined {
		return this.editors.get(path);
	}

	/** Find the (document, editor) pair for the currently active editor, if any. */
	entryForActiveEditor(): { doc: RemoteDocument; editor: vscode.TextEditor } | undefined {
		const active = vscode.window.activeTextEditor;
		if (!active) {
			return undefined;
		}
		for (const [path, editor] of this.editors) {
			if (editor === active) {
				const doc = this.documents.getDocument(path);
				if (doc) {
					return { doc, editor };
				}
			}
		}
		return undefined;
	}
}

// -----------------------------------------------------------------------------
// Editor helpers
// -----------------------------------------------------------------------------

/**
 * Open an untitled VS Code editor preloaded with the document's content and
 * language. An untitled document keeps the remote file distinct from any local
 * file; the editor binding (tracked in EditorState) maps it back to its path.
 */
async function openEditorFor(doc: RemoteDocument): Promise<vscode.TextEditor> {
	// `language` is applied by openTextDocument; undefined falls back to plaintext.
	const textDoc = await vscode.workspace.openTextDocument({
		content: doc.content,
		language: doc.language,
	});
	return vscode.window.showTextDocument(textDoc);
}

/**
 * Replace the full text of an editor in a single edit. Used to reflect a save
 * (post-save content) or a revert (original content) back into the editor.
 */
async function writeEditor(editor: vscode.TextEditor, text: string): Promise<void> {
	const document = editor.document;
	const full = new vscode.Range(
		document.positionAt(0),
		document.positionAt(document.getText().length),
	);
	await editor.edit((builder: vscode.TextEditorEdit) => builder.replace(full, text));
}
