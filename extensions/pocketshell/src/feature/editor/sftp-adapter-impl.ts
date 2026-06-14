/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SftpAdapter } from '../../backend/editor';
import type { SftpClient } from '../../backend/files/sftp-client';

/**
 * Concrete SftpAdapter that delegates to the already-wired SftpClient.
 *
 * The editor's `SftpAdapter` interface (see backend/editor/types.ts) requires:
 *   - writeFile(path, data): Promise<void>
 *   - stat(path): Promise<{ modifiedAt: number; size: number }>
 *   - readFileText(path): Promise<string>
 *
 * SftpClient already exposes `writeFile` and `readFileText` with identical
 * signatures, and a `stat` that returns a richer `RemoteFileStat` object.
 * `RemoteFileStat` structurally satisfies the adapter's narrower return type
 * (it carries both `modifiedAt` and `size`), so `stat` delegates directly and
 * TypeScript narrows the result via the explicit return-type annotation here.
 */
export class SftpClientAdapter implements SftpAdapter {
	constructor(private readonly client: SftpClient) {}

	/** Write data to a remote file, creating or overwriting it. */
	writeFile(path: string, data: Buffer | string): Promise<void> {
		return this.client.writeFile(path, data);
	}

	/**
	 * Stat a remote file, returning only the fields the editor needs:
	 * modification time (epoch ms) and size in bytes.
	 */
	async stat(path: string): Promise<{ modifiedAt: number; size: number }> {
		const stat = await this.client.stat(path);
		return { modifiedAt: stat.modifiedAt, size: stat.size };
	}

	/** Read a remote file's text content. */
	readFileText(path: string): Promise<string> {
		return this.client.readFileText(path);
	}
}
