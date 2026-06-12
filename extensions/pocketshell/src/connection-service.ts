/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as os from 'os';
import { HostStore, initStore } from './backend/ssh/data/host-store';
import type { Host, NewHost } from './backend/ssh/data/host-store';
import { ConnectionManager } from './backend/ssh/connection/connection-manager';
import { ConnectionState } from './backend/ssh/connection/connection-manager';
import type { SshConnection, SshConnectParams } from './backend/ssh/connection/ssh-client';

/**
 * Central service that manages SSH hosts, connections, and their lifecycle.
 *
 * Singleton shared across all extension components (terminal profiles,
 * file system provider, tree view).
 */
export class ConnectionService {
	private static instance: ConnectionService | undefined;

	private _hostStorePromise: Promise<HostStore | undefined> | undefined;
	readonly connectionManager: ConnectionManager;

	private constructor() {
		this.connectionManager = new ConnectionManager();
	}

	/**
	 * Lazily initialize the host store. Returns a promise that resolves to
	 * the store, or undefined if initialization failed (native module load
	 * failure, SQL error, etc.). Caches the result so only one attempt is made.
	 */
	private ensureStore(): Promise<HostStore | undefined> {
		if (this._hostStorePromise) {
			return this._hostStorePromise;
		}
		this._hostStorePromise = initStore().catch(err => {
			console.error('[PocketShell] Failed to initialize host database:', err);
			return undefined;
		});
		return this._hostStorePromise;
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

	// -- Connection operations --------------------------------------------------

	/**
	 * Connect to a host using default key path (~/.ssh/id_rsa).
	 *
	 * For v0.1.0, this uses a simple authentication model:
	 *   - Key: ~/.ssh/id_rsa
	 *   - knownHosts: acceptAll
	 */
	async connect(hostId: number): Promise<SshConnection> {
		const store = await this.ensureStore();
		const host = store?.get(hostId);
		if (!host) {
			throw new Error(`Host not found: ${hostId}`);
		}

		const defaultKeyPath = path.join(os.homedir(), '.ssh', 'id_rsa');

		const params: SshConnectParams = {
			host: host.hostname,
			port: host.port,
			user: host.username,
			key: { type: 'path', file: defaultKeyPath },
			knownHosts: { type: 'acceptAll' },
		};

		const conn = await this.connectionManager.connect(hostId, params);

		// Update last-connected timestamp — failure must not reject connect()
		try {
			store?.touchConnected(hostId);
		} catch (err) {
			console.warn('[PocketShell] Failed to update last-connected timestamp:', err);
		}

		return conn;
	}

	/** Disconnect from a host. */
	disconnect(hostId: number): void {
		this.connectionManager.disconnect(hostId);
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
}
