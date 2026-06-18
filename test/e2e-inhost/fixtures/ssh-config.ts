/**
 * Fixture: seed `~/.ssh/config` with a stanza for the Docker SSH fixture.
 *
 * The PocketShell extension reads `os.homedir()/.ssh/config` as the single
 * source of truth for the host list (see
 * `extensions/pocketshell/src/connection-service.ts`). For the in-host E2E to
 * observe a host at launch, the config must exist BEFORE the host process
 * starts. The runner sets `process.env.HOME = tmpHome` and `os.homedir()`
 * resolves against it, so we write to `<tmpHome>/.ssh/config`.
 *
 * The stable numeric host id is computed with the SAME deterministic FNV-1a
 * hash the extension uses
 * (`stableHostIdFromAlias` in
 * `extensions/pocketshell/src/backend/ssh/data/ssh-host-resolver.ts`). We
 * replicate the pure function here rather than importing it from the built
 * extension: the built `out/` tree is not guaranteed to expose the resolver
 * module as a separately require-able file, and the function is tiny,
 * documented, and deterministic.
 */

import * as fs from 'fs';
import * as path from 'path';

/** The SSH alias the extension will resolve into a host entry. */
export const FIXTURE_ALIAS = 'psh-fixture';

/**
 * Deterministic stable id for an alias. Mirrors the extension's
 * `stableHostIdFromAlias` exactly (FNV-1a over `alias:<alias>`, masked to 30
 * bits). See `ssh-host-resolver.ts:61` (`stableHostId`) and `:399`
 * (`stableHostIdFromAlias`).
 */
export function stableHostIdFromAlias(alias: string): number {
	const identity = `alias:${alias}`;
	let hash = 0x811c9dc5;
	for (let i = 0; i < identity.length; i++) {
		hash ^= identity.charCodeAt(i);
		hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
	}
	return (hash & 0x3fffffff) || 1;
}

/** Expected stable host id for the fixture alias. */
export const FIXTURE_HOST_ID = stableHostIdFromAlias(FIXTURE_ALIAS);

/**
 * Write `<tmpHome>/.ssh/config` with a stanza for {@link FIXTURE_ALIAS} and
 * ensure the identity key is mode 600 (ssh refuses group/world-readable keys).
 *
 * @returns the path to the written config file.
 */
export function seedSshConfig(
	tmpHome: string,
	keyPath: string,
	fixture: { host: string; port: number; user: string },
): string {
	const sshDir = path.join(tmpHome, '.ssh');
	fs.mkdirSync(sshDir, { recursive: true });

	const configPath = path.join(sshDir, 'config');
	const stanza = [
		`Host ${FIXTURE_ALIAS}`,
		`    HostName ${fixture.host}`,
		`    Port ${fixture.port}`,
		`    User ${fixture.user}`,
		`    IdentityFile ${keyPath}`,
		`    StrictHostKeyChecking no`,
		`    UserKnownHostsFile /dev/null`,
		'',
	].join('\n');
	fs.writeFileSync(configPath, stanza, { mode: 0o600 });

	// ssh rejects keys that are group/world readable/writable.
	try {
		fs.chmodSync(keyPath, 0o600);
	} catch (err) {
		// Non-fatal: the key may already be 600.
		console.warn(`[e2e-inhost] Could not chmod key ${keyPath}:`, err instanceof Error ? err.message : err);
	}

	return configPath;
}
