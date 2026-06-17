/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PocketShell. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as os from 'os';
import { HostStore, initStore } from './backend/ssh/data/host-store';
import type { Host, NewHost } from './backend/ssh/data/host-store';
import {
	HostMetadataStore,
	initMetadataStore,
	type HostMetadata,
} from './backend/ssh/data/host-metadata-store';
import { migrateLegacyHosts, type MigrationResult } from './backend/ssh/data/host-metadata-migration';
import { parseSshConfig } from './backend/ssh/data/ssh-config-parser';
import { formatHostStanza, patchIdentityFileForAlias } from './backend/ssh/data/ssh-config-writer';
import {
	resolveHostForConnection,
	resolveHostsFromConfig,
	hostIdentityForAlias,
	stableHostIdFromAlias,
} from './backend/ssh/data/ssh-host-resolver';
import { initWatchedFolderStore, type NewWatchedFolder, type WatchedFolder, type WatchedFolderStore, type WatchedFolderUpdate } from './backend/ssh/data/watched-folder-store';
import { discoveredRootToWatchedFolder, discoverRemoteProjectRoots } from './backend/ssh/data/watched-folder-discovery';
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
 *
 * Host model: `~/.ssh/config` is the SINGLE SOURCE OF TRUTH for the host list
 * and for connection details. The host list returned by {@link getHosts} is a
 * live parse of the config, merged with PocketShell-specific metadata stored
 * in a separate metadata table. There is no import/copy flow.
 */
export class ConnectionService {
	private static instance: ConnectionService | undefined;

	private _hostStorePromise: Promise<HostStore | undefined> | undefined;
	private _metadataStorePromise: Promise<HostMetadataStore | undefined> | undefined;
	private _watchedFolderStorePromise: Promise<WatchedFolderStore | undefined> | undefined;
	private _keyStorePromise: Promise<KeyStore | undefined> | undefined;
	private _passphraseProvider: ((host: Host) => Promise<string | undefined>) | undefined;
	private _diagnostics: ((input: DiagnosticRecordInput) => void) | undefined;
	readonly connectionManager: ConnectionManager;

	/** id -> { identity, alias } cache from the most recent live resolve. */
	private _idIndex: Map<number, { identity: string; alias: string }> = new Map();

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
	 * Lazily initialize the legacy host store. Only used for one-time
	 * migration of pre-existing rows into the metadata store.
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

	/** Lazily initialize the PocketShell host-metadata store. */
	private ensureMetadataStore(): Promise<HostMetadataStore | undefined> {
		if (this._metadataStorePromise) {
			return this._metadataStorePromise;
		}
		const dbPath = this._storageDir
			? path.join(this._storageDir, 'hosts.db')
			: undefined;
		this._metadataStorePromise = initMetadataStore(dbPath).catch(err => {
			console.error('[PocketShell] Failed to initialize host metadata database:', err);
			return undefined;
		});
		return this._metadataStorePromise;
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

	private ensureWatchedFolderStore(): Promise<WatchedFolderStore | undefined> {
		if (this._watchedFolderStorePromise) {
			return this._watchedFolderStorePromise;
		}
		const dbPath = this._storageDir
			? path.join(this._storageDir, 'watched-folders.db')
			: path.join(os.homedir(), '.pocketshell', 'watched-folders.db');
		this._watchedFolderStorePromise = initWatchedFolderStore(dbPath).catch(err => {
			console.error('[PocketShell] Failed to initialize watched folder database:', err);
			return undefined;
		});
		return this._watchedFolderStorePromise;
	}

	/** Whether any host storage is available (resolves after init attempt). */
	async isStoreAvailable(): Promise<boolean> {
		return (await this.ensureMetadataStore()) !== undefined;
	}

	/** Get or create the singleton instance. */
	static getInstance(): ConnectionService {
		if (!ConnectionService.instance) {
			ConnectionService.instance = new ConnectionService();
		}
		return ConnectionService.instance;
	}

	// -- SSH config + metadata -----------------------------------------------

	/** Parse ~/.ssh/config live. Returns [] if the file is absent. */
	private parseConfig() {
		try {
			return parseSshConfig();
		} catch (err) {
			console.warn('[PocketShell] Failed to parse ~/.ssh/config:', err);
			return [];
		}
	}

	/** Return PocketShell metadata as a Map keyed by identity. */
	private async metadataMap(): Promise<Map<string, HostMetadata>> {
		const store = await this.ensureMetadataStore();
		return store?.asMap() ?? new Map();
	}

	/**
	 * Return the live host list parsed from ~/.ssh/config, merged with any
	 * stored PocketShell metadata. The config is the single source of truth;
	 * nothing is copied into a separate store.
	 */
	async getHosts(): Promise<Host[]> {
		const parsed = this.parseConfig();
		const metadata = await this.metadataMap();
		const { hosts } = resolveHostsFromConfig(parsed, { metadata });
		this._idIndex = new Map(hosts.map(h => [h.host.id, { identity: h.identity, alias: h.alias }]));
		return hosts.map(h => h.host);
	}

	/** Get a single host by id (resolved live from the config). */
	async getHost(id: number): Promise<Host | undefined> {
		const hosts = await this.getHosts();
		return hosts.find(h => h.id === id);
	}

	/** Look up the SSH alias for a stable host id. */
	async getAliasForId(id: number): Promise<string | undefined> {
		if (!this._idIndex.has(id)) {
			await this.getHosts();
		}
		return this._idIndex.get(id)?.alias;
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

	/**
	 * @deprecated The host list is now derived from ~/.ssh/config. New hosts
	 * are added by editing the config (see the `pocketshell.addHost` command).
	 * This method is retained for compatibility and appends a Host stanza to
	 * the config file so the new entry appears live.
	 */
	async addHost(host: NewHost): Promise<number> {
		const configPath = path.join(os.homedir(), '.ssh', 'config');
		await ensureSshConfigExists(configPath);
		const stanza = formatHostStanza(host);
		fs.appendFileSync(configPath, stanza);
		return stableHostIdFromAlias(host.name || host.hostname);
	}

	/**
	 * Update PocketShell metadata for a host. Connection-detail fields on the
	 * supplied Host (hostname/port/user/keyPath) are ignored — the config is
	 * the source of truth. If the keyPath differs from the current config
	 * value, the config's IdentityFile is updated instead.
	 */
	async updateHost(host: Host): Promise<boolean> {
		const alias = (await this.getAliasForId(host.id)) ?? host.name;
		const identity = hostIdentityForAlias(alias);

		// If the caller changed the identity file, write it to the config so
		// the config remains the single source of truth.
		const liveHost = await this.getHost(host.id);
		if (liveHost && host.keyPath && host.keyPath !== liveHost.keyPath) {
			await updateIdentityFileInConfig(alias, host.keyPath);
		}

		const store = await this.ensureMetadataStore();
		if (!store) {
			throw new Error('Database not available');
		}
		store.upsert(identity, alias, {
			alias,
			maxAutoPort: host.maxAutoPort,
			skipPortsBelow: host.skipPortsBelow,
			scanIntervalSec: host.scanIntervalSec,
			enabled: host.enabled,
			lastConnectedAt: host.lastConnectedAt,
			tmuxInstalled: host.tmuxInstalled,
			lastBootstrapAt: host.lastBootstrapAt,
			pocketshellInstalled: host.pocketshellInstalled,
			pocketshellLastDetectedAt: host.pocketshellLastDetectedAt,
			pocketshellCliVersion: host.pocketshellCliVersion,
			pocketshellExpectedCliVersion: host.pocketshellExpectedCliVersion,
			pocketshellVersionCompatible: host.pocketshellVersionCompatible,
			pocketshellDaemonRunning: host.pocketshellDaemonRunning,
			pocketshellDaemonEnabled: host.pocketshellDaemonEnabled,
			usageCommandOverride: host.usageCommandOverride,
			claudeProfilesJson: host.claudeProfilesJson,
			codexProfilesJson: host.codexProfilesJson,
		});
		return true;
	}

	/**
	 * Remove PocketShell metadata for a host. The host entry in ~/.ssh/config
	 * is NOT touched (the config is the source of truth); remove the stanza
	 * there to drop the host from the list.
	 */
	async deleteHost(id: number): Promise<boolean> {
		const alias = await this.getAliasForId(id);
		if (!alias) {
			return false;
		}
		const identity = hostIdentityForAlias(alias);
		const store = await this.ensureMetadataStore();
		if (!store) {
			throw new Error('Database not available');
		}
		return store.delete(identity);
	}

	/** Update the lastConnectedAt timestamp for a host (by id -> alias). */
	async touchConnected(id: number): Promise<void> {
		const alias = await this.getAliasForId(id);
		if (!alias) return;
		const identity = hostIdentityForAlias(alias);
		const store = await this.ensureMetadataStore();
		store?.touchConnected(identity);
	}

	/**
	 * One-time migration of legacy `hosts` rows into the metadata store.
	 * Safe to call repeatedly: once the legacy table is empty it is a no-op.
	 * Returns the match/unmatch report so the UI can inform the user.
	 */
	async migrateLegacyHostMetadata(): Promise<MigrationResult> {
		const legacyStore = await this.ensureStore();
		const metadataStore = await this.ensureMetadataStore();
		if (!legacyStore || !metadataStore) {
			return { matched: [], unmatched: [] };
		}
		const legacyHosts = legacyStore.list();
		if (legacyHosts.length === 0) {
			return { matched: [], unmatched: [] };
		}
		const parsed = this.parseConfig();
		return migrateLegacyHosts(
			legacyHosts,
			parsed,
			metadataStore,
			legacyId => {
				legacyStore.delete(legacyId);
			},
			{ deleteLegacy: true },
		);
	}

	async getWatchedFolders(hostId: number): Promise<WatchedFolder[]> {
		const store = await this.ensureWatchedFolderStore();
		return store?.list(hostId) ?? [];
	}

	async getWatchedFolder(id: number): Promise<WatchedFolder | undefined> {
		const store = await this.ensureWatchedFolderStore();
		return store?.get(id);
	}

	async addWatchedFolder(folder: NewWatchedFolder): Promise<number> {
		const store = await this.ensureWatchedFolderStore();
		if (!store) {
			throw new Error('Watched folder database not available');
		}
		return store.add(folder);
	}

	async updateWatchedFolder(id: number, patch: WatchedFolderUpdate): Promise<boolean> {
		const store = await this.ensureWatchedFolderStore();
		if (!store) {
			throw new Error('Watched folder database not available');
		}
		return store.update(id, patch);
	}

	async deleteWatchedFolder(id: number): Promise<boolean> {
		const store = await this.ensureWatchedFolderStore();
		if (!store) {
			throw new Error('Watched folder database not available');
		}
		return store.delete(id);
	}

	async moveWatchedFolder(id: number, direction: 'up' | 'down'): Promise<boolean> {
		const store = await this.ensureWatchedFolderStore();
		if (!store) {
			throw new Error('Watched folder database not available');
		}
		return store.move(id, direction);
	}

	async discoverWatchedFolders(hostId: number): Promise<WatchedFolder[]> {
		const store = await this.ensureWatchedFolderStore();
		if (!store) {
			throw new Error('Watched folder database not available');
		}
		const conn = this.getConnection(hostId);
		if (!conn) {
			throw new Error('Host is not connected. Connect first, then discover project roots.');
		}
		const discovered = await discoverRemoteProjectRoots(conn);
		for (const root of discovered) {
			store.add(discoveredRootToWatchedFolder(hostId, root));
		}
		return store.list(hostId);
	}

	// -- Connection operations --------------------------------------------------

	/**
	 * Connect to a host. Connection details are resolved LIVE from
	 * ~/.ssh/config at connect time (the config is the single source of
	 * truth), not read from a stored row.
	 */
	async connect(hostId: number): Promise<SshConnection> {
		const alias = await this.getAliasForId(hostId);
		if (!alias) {
			throw new Error(`Host not found for id ${hostId}`);
		}

		const parsed = this.parseConfig();
		const metadata = await this.metadataMap();
		const host = resolveHostForConnection(alias, parsed, { metadata });

		// Expand ~ to home directory
		const expandedKeyPath = host.keyPath.startsWith('~')
			? path.join(os.homedir(), host.keyPath.slice(1))
			: host.keyPath;

		const keyStore = await this.ensureKeyStore();
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
			await this.touchConnected(hostId);
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

// ---------------------------------------------------------------------------
// ~/.ssh/config I/O helpers (the pure formatting/patching logic lives in
// ssh-config-writer.ts so it can be unit-tested without vscode).
// ---------------------------------------------------------------------------

/** Ensure ~/.ssh/config exists (creates it, and ~/.ssh, if absent). */
export async function ensureSshConfigExists(configPath: string): Promise<void> {
	const dir = path.dirname(configPath);
	fs.mkdirSync(dir, { recursive: true });
	if (!fs.existsSync(configPath)) {
		fs.writeFileSync(configPath, '', { mode: 0o600 });
	}
}

/**
 * Update (or insert) the IdentityFile directive for the first Host block
 * matching `alias` in ~/.ssh/config. Used by key-assignment so the config
 * stays the single source of truth for the identity file.
 */
export async function updateIdentityFileInConfig(alias: string, keyPath: string): Promise<void> {
	const configPath = path.join(os.homedir(), '.ssh', 'config');
	await ensureSshConfigExists(configPath);
	const original = fs.readFileSync(configPath, 'utf-8');
	const updated = patchIdentityFileForAlias(original, alias, keyPath);
	if (updated !== original) {
		fs.writeFileSync(configPath, updated, { mode: 0o600 });
	}
}

