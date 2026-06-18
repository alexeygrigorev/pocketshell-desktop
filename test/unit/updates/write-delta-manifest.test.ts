/**
 * Unit tests for scripts/write-delta-manifest.mjs.
 *
 * This is the regression test for the v0.1.4 release blocker (#96): the
 * SHIPPED win32-x64 manifest had `"sha256": "\db4444a9..."` — a stray leading
 * backslash — so it was invalid JSON and the in-app updater could not parse it,
 * breaking every Windows in-app update. Root cause was a shell
 * `sha256sum | awk` capture on the windows-2022 Git-Bash runner (value-triggered:
 * the hash began with "db"). The fix hashes in-process with `node:crypto` and
 * SELF-VALIDATES the output, so a corrupt manifest can never ship.
 *
 * Style mirrors package-delta.test.ts: explicit vitest imports, fs/os/path from
 * node, temp dirs under os.tmpdir(), recursive rmSync cleanup, a CLI-path test
 * that spawns the script as a child process to exercise the main-module guard.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// The writer is a standalone ESM build script (NOT compiled by gulp), so we
// import it directly from source via a file URL. vitest resolves this through
// its ESM loader.
const WRITER_URL = pathToFileURL(
  path.resolve(__dirname, '../../../scripts/write-delta-manifest.mjs')
).href;

// Absolute path to the script, resolved relative to the repo root
// (process.cwd() when vitest runs from the repo root). Used by the CLI-path
// regression test, which spawns the script as a child process to exercise the
// main()-module guard that the direct-import tests bypass.
const WRITER_SCRIPT = path.resolve(
  process.cwd(),
  'scripts',
  'write-delta-manifest.mjs'
);

interface WriteResult {
  sha: string;
}

// module.exports on an .mjs is not a thing; writeDeltaManifest is a named ESM
// export, so a dynamic import() is the correct loader.
async function importWriter(): Promise<{
  writeDeltaManifest: (
    version: string,
    repo: string,
    tag: string,
    zipName: string,
    zipPath: string,
    baseVersion: string,
    outPath: string
  ) => WriteResult;
}> {
  return await import(WRITER_URL);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let workRoot: string;

/** A few hundred pseudo-random but deterministic bytes for the "zip". */
const ZIP_BYTES = Buffer.from(
  Array.from({ length: 512 }, (_, i) => (i * 1103515245 + 12345) & 0xff)
);

beforeAll(() => {
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'psh-manifest-'));
});

afterAll(() => {
  if (workRoot) {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('writeDeltaManifest', () => {
  it(
    'writes a valid manifest whose sha256 is clean hex (no stray backslash) ' +
      'and equals the crypto hash of the bytes',
    async () => {
      const { writeDeltaManifest } = await importWriter();

      const zipPath = path.join(workRoot, 'delta.zip');
      const outPath = path.join(workRoot, 'latest-win32-x64.json');
      fs.writeFileSync(zipPath, ZIP_BYTES);

      const result = writeDeltaManifest(
        '0.1.4',
        'alexeygrigorev/pocketshell-desktop',
        'v0.1.4',
        'pocketshell-extension-0.1.4-win32-x64.zip',
        zipPath,
        '037f7fbe03f7',
        outPath
      );

      // The returned sha is exactly the crypto hash of the bytes we wrote.
      const expectedSha = crypto
        .createHash('sha256')
        .update(ZIP_BYTES)
        .digest('hex');
      expect(result.sha).toBe(expectedSha);

      // Written file parses cleanly as JSON.
      const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));

      // The four fields, in the canonical order, all non-empty strings.
      expect(Object.keys(parsed)).toEqual([
        'version',
        'downloadUrl',
        'sha256',
        'baseVersion',
      ]);

      expect(parsed.version).toBe('0.1.4');
      expect(parsed.baseVersion).toBe('037f7fbe03f7');
      expect(parsed.downloadUrl).toBe(
        'https://github.com/alexeygrigorev/pocketshell-desktop/' +
          'releases/download/v0.1.4/' +
          'pocketshell-extension-0.1.4-win32-x64.zip'
      );
      // downloadUrl ends with the asset filename exactly.
      expect(parsed.downloadUrl.endsWith('/pocketshell-extension-0.1.4-win32-x64.zip'))
        .toBe(true);

      // THE REGRESSION: sha is 64-char lowercase hex with NO stray leading
      // backslash (the v0.1.4 win32 manifest had "\db4444...").
      expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(parsed.sha256).not.toContain('\\');
      expect(parsed.sha256).toBe(expectedSha);
    },
    15_000
  );

  it(
    'CLI PATH: `node write-delta-manifest.mjs <args>` runs main() end-to-end ' +
      'and produces a valid manifest',
    () => {
      // This test exists BECAUSE the direct-import test above never exercises
      // main() or the main-module guard at the bottom of the script. Spawning
      // the script as a child process forces the guard to evaluate (the lesson
      // from package-extension-delta.mjs, where a broken Windows-only guard
      // silently never ran main() and broke the release).

      const cliWorkRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'psh-manifest-cli-')
      );
      try {
        const zipPath = path.join(cliWorkRoot, 'delta.zip');
        const outPath = path.join(cliWorkRoot, 'latest-linux-x64.json');
        fs.writeFileSync(zipPath, ZIP_BYTES);

        // Spawn the script as a child process. execFileSync throws on a
        // non-zero exit, so reaching the next assertion proves the guard
        // matched on this OS and main() ran.
        const stdout = execFileSync(
          process.execPath,
          [
            WRITER_SCRIPT,
            '0.1.4',
            'alexeygrigorev/pocketshell-desktop',
            'v0.1.4',
            'pocketshell-extension-0.1.4-linux-x64.zip',
            zipPath,
            '037f7fbe03f7',
            outPath,
          ],
          { encoding: 'utf8', maxBuffer: 1 << 20 }
        );
        expect(stdout).toContain('wrote');

        // The written manifest parses cleanly and has a clean-hex sha.
        const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(parsed.sha256).toBe(
          crypto.createHash('sha256').update(ZIP_BYTES).digest('hex')
        );
        expect(parsed.version).toBe('0.1.4');
        expect(parsed.downloadUrl).toBe(
          'https://github.com/alexeygrigorev/pocketshell-desktop/' +
            'releases/download/v0.1.4/' +
            'pocketshell-extension-0.1.4-linux-x64.zip'
        );
        expect(parsed.baseVersion).toBe('037f7fbe03f7');
      } finally {
        fs.rmSync(cliWorkRoot, { recursive: true, force: true });
      }
    },
    15_000
  );

  it('self-validation FAILS LOUD: a missing zipPath exits non-zero', () => {
    // Bad input must never produce a manifest. The CLI should exit 1 with an
    // ERROR: line, not write a corrupt file.
    const outPath = path.join(workRoot, 'should-not-exist.json');
    const missingZip = path.join(workRoot, 'does-not-exist.zip');

    let threw = false;
    try {
      execFileSync(
        process.execPath,
        [
          WRITER_SCRIPT,
          '0.1.4',
          'alexeygrigorev/pocketshell-desktop',
          'v0.1.4',
          'pocketshell-extension-0.1.4-win32-x64.zip',
          missingZip,
          '037f7fbe03f7',
          outPath,
        ],
        { encoding: 'utf8', maxBuffer: 1 << 20 }
      );
    } catch (err) {
      threw = true;
      const e = err as { status?: number; stderr?: string };
      expect(e.status).not.toBe(0);
      expect(e.stderr).toContain('ERROR:');
    }
    expect(threw).toBe(true);
    // No partial/corrupt manifest was written.
    expect(fs.existsSync(outPath)).toBe(false);
  });

  it('self-validation FAILS LOUD: bad argv count exits non-zero', () => {
    let threw = false;
    try {
      execFileSync(
        process.execPath,
        [WRITER_SCRIPT, 'only', 'two', 'args'],
        { encoding: 'utf8', maxBuffer: 1 << 20 }
      );
    } catch (err) {
      threw = true;
      const e = err as { status?: number; stderr?: string };
      expect(e.status).not.toBe(0);
      expect(e.stderr).toContain('usage:');
      expect(e.stderr).toContain('expected exactly 7 arguments');
    }
    expect(threw).toBe(true);
  });
});
