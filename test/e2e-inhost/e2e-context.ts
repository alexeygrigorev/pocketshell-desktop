/**
 * Shared types for the in-host E2E harness.
 *
 * `E2eContext` is produced by `globalSetup` (Node runner process), persisted to
 * `<userDataDir>/e2e-context.json`, and read back by the in-host tests (a
 * different process — the forked VS Code extension host). The JSON file is the
 * only channel between them.
 */

/** Shape persisted to `e2e-context.json`. */
export interface E2eContext {
	/** Absolute path to the temp `--user-data-dir`. */
	userDataDir: string;
	/** Absolute path to the temp `--extensions-dir`. */
	extensionsDir: string;
	/** Absolute path to the temp HOME (holds the seeded `~/.ssh/config`). */
	tmpHome: string;
	/** The SSH alias seeded into `~/.ssh/config`. */
	alias: string;
	/** Deterministic stable host id for the alias (matches the extension). */
	hostId: number;
	/** Fixture connection details. */
	fixture: {
		host: string;
		port: number;
		user: string;
		keyPath: string;
	};
}

/** Filename (relative to userDataDir) where the context is written. */
export const CONTEXT_FILENAME = 'e2e-context.json';
