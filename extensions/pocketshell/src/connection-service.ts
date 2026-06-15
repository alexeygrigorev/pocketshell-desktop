/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as os from 'os';
import { HostStore, initStore } from './backend/ssh/data/host-store';
import type { Host, NewHost } from './backend/ssh/data/host-store';
import { KeyStore, defaultKeysDir, hasPrivateKeyPassphrase, initKeyStore } from './backend/ssh/data/key-store';
import { ConnectionManager } from './backend/ssh/connection/connection-manager';
import { ConnectionState } from './backend/ssh/connection/connection-manager';
import type { SshConnection, SshConnectParams } from './backend/ssh/connection/ssh-client';
import * as fs from 'fs';
import type { DiagnosticRecordInput } from './backend/diagnostics';

/**
 * Central service that manages SSH hosts, connections, and their lifecycle.
 *
 * Singleton shared across all extension components (terminal profiles,
 * file system provider, tree view).
 */
export class ConnectionService {
	private static instance: ConnectionService | undefined;

	private _hostStorePromise: Promise<HostStore | undefined> | undefined;
	private _keyStorePromise: Promise<KeyStore | undefined> | undefined;
	private _passphraseProvider: ((host: Host) => Promise<string | undefined>) | undefined;
	private _diagnostics: ((input: DiagnosticRecordInput) => void) | undefined;
	readonly connectionManager: ConnectionManager;

	private constructor() {
		this.connectionManager = new ConnectionManager();
	}

	/**
	 * Set the storage directory for the host database.
	 * Must be called before the first store access (i.e. during activate()).
	 */
	setStorageDir(storageDir: string): void {
		this._storageDir = storageDir;
	}

	setPassphraseProvider(provider: (host: Host) => Promise<string | undefined>): void {
		this._passphraseProvider = provider;
	}

	setDiagnosticsRecorder(recorder: (input: DiagnosticRecordInput) => void): void {
		this._diagnostics = recorder;
	}

	private _storageDir: string | undefined;

	/**
	 * Lazily initialize the host store. Returns a promise that resolves to
	 * the store, or undefined if initialization failed (native module load
	 * failure, SQL error, etc.). Caches the result so only one attempt is made.
	 */
	private ensureStore(): Promise<HostStore | undefined> {
		if (this._hostStorePromise) {
			return this._hostStorePromise;
		}
		const dbPath = this._storageDir
			? path.join(this._storageDir, 'hosts.db')
			: undefined;
		this._hostStorePromise = initStore(dbPath).catch(err => {
			console.error('[PocketShell] Failed to initialize host database:', err);
			return undefined;
		});
		return this._hostStorePromise;
	}

	private ensureKeyStore(): Promise<KeyStore | undefined> {
		if (this._keyStorePromise) {
			return this._keyStorePromise;
		}
		const dbPath = this._storageDir
			? path.join(this._storageDir, 'keys.db')
			: path.join(os.homedir(), '.pocketshell', 'keys.db');
		const keysDir = defaultKeysDir(this._storageDir);
		this._keyStorePromise = initKeyStore(dbPath, keysDir).catch(err => {
			console.error('[PocketShell] Failed to initialize key database:', err);
			return undefined;
		});
		return this._keyStorePromise;
	}

	/** Whether the host store is available (resolves after init attempt). */
	async isStoreAvailable(): Promise<boolean> {
		return (await this.ensureStore()) !== undefined;
	}

	/** Get or create the singleton instance. */
	static getInstance(): ConnectionService {
		if (!ConnectionService.instance) {
			ConnectionService.instance = new ConnectionService();
		}
		return ConnectionService.instance;
	}

	// -- Host operations -------------------------------------------------------

	/** Return all configured hosts, or empty array if the store is unavailable. */
	async getHosts(): Promise<Host[]> {
		const store = await this.ensureStore();
		return store?.list() ?? [];
	}

	async getKeys() {
		const store = await this.ensureKeyStore();
		return store?.list() ?? [];
	}

	async importKey(name: string, sourcePath: string, hasPassphrase?: boolean) {
		const store = await this.ensureKeyStore();
		if (!store) {
			throw new Error('Key database not available');
		}
		return store.importKey(name, sourcePath, { hasPassphrase });
	}

	async generateKey(name: string) {
		const store = await this.ensureKeyStore();
		if (!store) {
			throw new Error('Key database not available');
		}
		return store.generateKey(name);
	}

	/** Get a single host by id. */
	async getHost(id: number): Promise<Host | undefined> {
		const store = await this.ensureStore();
		return store?.get(id);
	}

	/**
	 * Add a new host and return its id.
	 * @throws Error if the host store is not available.
	 */
	async addHost(host: NewHost): Promise<number> {
		const store = await this.ensureStore();
		if (!store) {
			throw new Error('Database not available');
		}
		return store.add(host);
	}

	/**
	 * Update an existing host.
	 * @throws Error if the host store is not available.
	 */
	async updateHost(host: Host): Promise<boolean> {
		const store = await this.ensureStore();
		if (!store) {
			throw new Error('Database not available');
		}
		return store.update(host);
	}

	/**
	 * Delete a host by id.
	 * @throws Error if the host store is not available.
	 */
	async deleteHost(id: number): Promise<boolean> {
		const store = await this.ensureStore();
		if (!store) {
			throw new Error('Database not available');
		}
		return store.delete(id);
	}

	// -- Connection operations --------------------------------------------------

	/**
	 * Connect to a host using its stored keyPath.
	 *
	 * For v0.1.0, this uses a simple authentication model:
	 *   - Key: host.keyPath (expanded ~ to home dir)
	 *   - knownHosts: acceptAll
	 */
	async connect(hostId: number): Promise<SshConnection> {
		const store = await this.ensureStore();
		const keyStore = await this.ensureKeyStore();
		const host = store?.get(hostId);
		if (!host) {
			throw new Error(`Host not found: ${hostId}`);
		}

		// Expand ~ to home directory
		const expandedKeyPath = host.keyPath.startsWith('~')
			? path.join(os.homedir(), host.keyPath.slice(1))
			: host.keyPath;

		const keyMetadata = keyStore?.getByPrivateKeyPath(expandedKeyPath) ?? keyStore?.getByPrivateKeyPath(host.keyPath);
		const needsPassphrase = keyMetadata?.hasPassphrase ?? detectKeyPassphrase(expandedKeyPath);
		this.recordDiagnostics('ssh', 'connect_started', {
			hostId,
			hostname: host.hostname,
			username: host.username,
			port: host.port,
			keyPath: expandedKeyPath,
			needsPassphrase,
		});
		const passphrase = needsPassphrase ? await this._passphraseProvider?.(host) : undefined;
		if (needsPassphrase && passphrase === undefined) {
			this.recordDiagnostics('ssh', 'connect_failed', {
				hostId,
				hostname: host.hostname,
				username: host.username,
				port: host.port,
				reason: 'passphrase_required',
			});
			throw new Error('Passphrase required');
		}

		const params: SshConnectParams = {
			host: host.hostname,
			port: host.port,
			user: host.username,
			key: { type: 'path', file: expandedKeyPath },
			passphrase,
			knownHosts: { type: 'acceptAll' },
		};

		let conn: SshConnection;
		try {
			conn = await this.connectionManager.connect(hostId, params);
		} catch (err) {
			if (needsPassphrase || !isLikelyPassphraseError(err)) {
				this.recordDiagnostics('ssh', 'connect_failed', {
					hostId,
					hostname: host.hostname,
					username: host.username,
					port: host.port,
					error: err instanceof Error ? err.message : String(err),
				});
				throw err;
			}

			const retryPassphrase = await this._passphraseProvider?.(host);
			if (retryPassphrase === undefined) {
				this.recordDiagnostics('ssh', 'connect_failed', {
					hostId,
					hostname: host.hostname,
					username: host.username,
					port: host.port,
					reason: 'passphrase_retry_cancelled',
				});
				throw err;
			}
			try {
				conn = await this.connectionManager.connect(hostId, {
					...params,
					passphrase: retryPassphrase,
				});
			} catch (retryErr) {
				this.recordDiagnostics('ssh', 'connect_failed', {
					hostId,
					hostname: host.hostname,
					username: host.username,
					port: host.port,
					error: retryErr instanceof Error ? retryErr.message : String(retryErr),
				});
				throw retryErr;
			}
		}

		// Update last-connected timestamp — failure must not reject connect()
		try {
			store?.touchConnected(hostId);
		} catch (err) {
			console.warn('[PocketShell] Failed to update last-connected timestamp:', err);
		}

		this.recordDiagnostics('ssh', 'connect_succeeded', {
			hostId,
			hostname: host.hostname,
			username: host.username,
			port: host.port,
		});
		return conn;
	}

	/** Disconnect from a host. */
	disconnect(hostId: number): void {
		this.connectionManager.disconnect(hostId);
		this.recordDiagnostics('ssh', 'disconnect', { hostId });
	}

	/** Get an active connection for a host, or null. */
	getConnection(hostId: number): SshConnection | null {
		return this.connectionManager.getConnection(hostId);
	}

	/** Get the connection state for a host. */
	getState(hostId: number): ConnectionState {
		return this.connectionManager.getState(hostId);
	}

	/** Dispose all resources. */
	dispose(): void {
		this.connectionManager.destroy();
		ConnectionService.instance = undefined;
	}

	private recordDiagnostics(
		category: DiagnosticRecordInput['category'],
		name: string,
		metadata?: DiagnosticRecordInput['metadata'],
	): void {
		this._diagnostics?.({ category, name, metadata });
	}
}

function detectKeyPassphrase(keyPath: string): boolean {
	try {
		return hasPrivateKeyPassphrase(fs.readFileSync(keyPath, 'utf-8'));
	} catch {
		return false;
	}
}

function isLikelyPassphraseError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /passphrase|encrypted|private key/i.test(message);
}
