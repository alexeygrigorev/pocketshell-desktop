/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SftpClient } from './backend/files/sftp-client';
import type { RemoteFileEntry } from './backend/files/types';
import { ConnectionService } from './connection-service';

/**
 * VS Code FileSystemProvider backed by SFTP over SSH.
 *
 * URI scheme: pocketshell://<hostId>/path/to/file
 *
 * Maps VS Code file operations to SFTP operations on the remote host.
 * SftpClient instances are cached per host and reused across operations.
 */
export class SftpFsProvider implements vscode.FileSystemProvider, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this.changeEmitter.event;

	/**
	 * Cached SFTP clients keyed by hostId. Reused across operations to avoid
	 * opening a new SFTP channel for every single file system call.
	 */
	private readonly clientCache = new Map<number, SftpClient>();

	constructor(private readonly service: ConnectionService) {}

	/**
	 * Dispose all cached SFTP clients and the change emitter.
	 */
	dispose(): void {
		for (const client of this.clientCache.values()) {
			client.disconnect();
		}
		this.clientCache.clear();
		this.changeEmitter.dispose();
	}

	// -- URI parsing ------------------------------------------------------------

	/**
	 * Parse a pocketshell:// URI into { hostId, remotePath }.
	 */
	private parseUri(uri: vscode.Uri): { hostId: number; remotePath: string } {
		// URI authority is the hostId; path is the remote file path.
		// pocketshell://42/home/user/file.txt -> hostId=42, path=/home/user/file.txt
		const hostId = parseInt(uri.authority, 10);
		if (isNaN(hostId)) {
			throw vscode.FileSystemError.Unavailable(uri);
		}
		return { hostId, remotePath: uri.path };
	}

	/**
	 * Get or create a cached SftpClient for the given host.
	 *
	 * Returns a connected client ready for operations. If the cached client's
	 * underlying connection has dropped, it is discarded and a fresh one is
	 * created.
	 */
	private async getClient(hostId: number): Promise<SftpClient> {
		const cached = this.clientCache.get(hostId);
		if (cached && cached.connected) {
			return cached;
		}

		// Discard stale client if present
		if (cached) {
			cached.disconnect();
			this.clientCache.delete(hostId);
		}

		const conn = this.service.getConnection(hostId);
		if (!conn) {
			throw vscode.FileSystemError.Unavailable(`No active connection for host ${hostId}`);
		}
		const client = new SftpClient(conn);
		await client.connect();
		this.clientCache.set(hostId, client);
		return client;
	}

	// -- FileSystemProvider implementation --------------------------------------

	stat(uri: vscode.Uri): vscode.FileStat | Thenable<vscode.FileStat> {
		const { hostId, remotePath } = this.parseUri(uri);
		return this.getClient(hostId).then(async (client: SftpClient) => {
			const stat = await client.stat(remotePath);
			let type = vscode.FileType.Unknown;
			if (stat.isDirectory()) {
				type = vscode.FileType.Directory;
			} else if (stat.isFile()) {
				type = vscode.FileType.File;
			}
			if (stat.isSymbolicLink()) {
				type |= vscode.FileType.SymbolicLink;
			}
			return {
				type,
				ctime: 0, // SFTP does not reliably provide creation time
				mtime: stat.modifiedAt,
				size: stat.size,
			};
		});
	}

	readDirectory(uri: vscode.Uri): Thenable<[string, vscode.FileType][]> {
		const { hostId, remotePath } = this.parseUri(uri);
		return this.getClient(hostId).then(async (client: SftpClient) => {
			const entries: RemoteFileEntry[] = await client.readdir(remotePath);
			return entries.map((entry: RemoteFileEntry) => {
				let type = vscode.FileType.Unknown;
				if (entry.isDirectory) {
					type = vscode.FileType.Directory;
				} else if (entry.isFile) {
					type = vscode.FileType.File;
				}
				if (entry.isSymbolicLink) {
					type |= vscode.FileType.SymbolicLink;
				}
				return [entry.name, type] as [string, vscode.FileType];
			});
		});
	}

	readFile(uri: vscode.Uri): Thenable<Uint8Array> {
		const { hostId, remotePath } = this.parseUri(uri);
		return this.getClient(hostId).then(async (client: SftpClient) => {
			const buf = await client.readFile(remotePath);
			return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
		});
	}

	writeFile(uri: vscode.Uri, content: Uint8Array, options: { readonly create: boolean; readonly overwrite: boolean }): Thenable<void> {
		const { hostId, remotePath } = this.parseUri(uri);
		return this.getClient(hostId).then(async (client: SftpClient) => {
			// Check if file exists
			const exists = await client.exists(remotePath);
			if (exists && !options.overwrite) {
				throw vscode.FileSystemError.FileExists(uri);
			}
			if (!exists && !options.create) {
				throw vscode.FileSystemError.FileNotFound(uri);
			}
			await client.writeFile(remotePath, Buffer.from(content));
		});
	}

	delete(uri: vscode.Uri, options: { readonly recursive: boolean }): Thenable<void> {
		const { hostId, remotePath } = this.parseUri(uri);
		return this.getClient(hostId).then(async (client: SftpClient) => {
			const stat = await client.stat(remotePath);
			if (stat.isDirectory()) {
				if (options.recursive) {
					await this.deleteDirectoryRecursive(client, remotePath);
				} else {
					await client.rmdir(remotePath);
				}
			} else {
				await client.unlink(remotePath);
			}
		});
	}

	rename(oldUri: vscode.Uri, newUri: vscode.Uri, _options: { readonly overwrite: boolean }): Thenable<void> {
		const oldParsed = this.parseUri(oldUri);
		const newParsed = this.parseUri(newUri);
		if (oldParsed.hostId !== newParsed.hostId) {
			throw vscode.FileSystemError.Unavailable('Cannot rename across hosts');
		}
		return this.getClient(oldParsed.hostId).then(async (client: SftpClient) => {
			await client.rename(oldParsed.remotePath, newParsed.remotePath);
		});
	}

	createDirectory(uri: vscode.Uri): Thenable<void> {
		const { hostId, remotePath } = this.parseUri(uri);
		return this.getClient(hostId).then(async (client: SftpClient) => {
			await client.mkdir(remotePath);
		});
	}

	watch(_uri: vscode.Uri, _options: { readonly recursive: boolean; readonly excludes: readonly string[] }): vscode.Disposable {
		// No-op for v0.1.0: SFTP does not support inotify-style watching.
		return new vscode.Disposable(() => {});
	}

	// -- Private helpers --------------------------------------------------------

	/**
	 * Recursively delete a directory: list contents, delete files and
	 * subdirectories depth-first, then remove the now-empty directory.
	 */
	private async deleteDirectoryRecursive(client: SftpClient, dirPath: string): Promise<void> {
		const entries = await client.readdir(dirPath);
		for (const entry of entries) {
			if (entry.isDirectory) {
				await this.deleteDirectoryRecursive(client, entry.path);
			} else {
				await client.unlink(entry.path);
			}
		}
		await client.rmdir(dirPath);
	}
}
