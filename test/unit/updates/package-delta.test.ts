/**
 * Unit tests for scripts/package-extension-delta.mjs.
 *
 * The marquee test is the CLOSED LOOP: what the build-time packager (yazl)
 * produces must be installable byte-for-byte by the runtime extractor (yauzl,
 * in src/updates/installer.ts). If this passes, the release workflow's
 * `node package-extension-delta.mjs` step is a faithful, portable replacement
 * for the previous `( cd "$EXT_DIR" && zip -r -X ... )` shell-out (which broke
 * on windows-2022 where `zip` is unavailable).
 *
 * Style mirrors installer.test.ts: explicit vitest imports, fs/os/path from
 * node, temp dirs under os.tmpdir(), recursive rmSync cleanup.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { extractZipBuffer } from '../../../src/updates/installer';

// The packager is a standalone ESM build script (NOT compiled by gulp), so we
// import it directly from source via a file URL. vitest resolves this through
// its ESM loader.
const PACKAGER_URL = pathToFileURL(
  path.resolve(__dirname, '../../../scripts/package-extension-delta.mjs'),
).href;

// Absolute paths to the script + validator, resolved relative to the repo root
// (process.cwd() when vitest runs from the repo root). Used by the CLI-path
// regression test, which spawns the script as a child process to exercise the
// main()-module guard that the direct-import tests bypass.
const PACKAGER_SCRIPT = path.resolve(
  process.cwd(),
  'scripts',
  'package-extension-delta.mjs',
);
const VALIDATOR_SCRIPT = path.resolve(
  process.cwd(),
  'scripts',
  'check-delta-zip.mjs',
);

interface PackageResult {
  entryCount: number;
  bytes: number;
}

// module.exports on an .mjs is not a thing; packageExtensionDelta is a named
// ESM export, so a dynamic import() is the correct loader.
async function importPackager(): Promise<{
  packageExtensionDelta: (
    srcDir: string,
    outZip: string,
  ) => Promise<PackageResult>;
}> {
  return await import(PACKAGER_URL);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let srcDir: string;
let outZip: string;
let extractDir: string;
let workRoot: string;

/** Fixed "native binary" bytes (deterministic so the test is reproducible). */
const NATIVE_BYTES = Buffer.from([
  0x7f,
  0x45,
  0x4c,
  0x46, // ELF magic
  0x02,
  0x01,
  0x01,
  0x00,
  0xde,
  0xad,
  0xbe,
  0xef,
  0x00,
  0x99,
  0x33,
]);

const EXTENSION_JS = 'console.log("PocketShell extension main");\n';
const PACKAGE_JSON = JSON.stringify(
  { name: 'pocketshell', version: '0.1.4', main: 'out/extension.js' },
  null,
  2,
);
const BASE_VERSION_JSON = '{"baseVersion":"abc123def456"}\n';

beforeAll(() => {
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'psh-delta-'));
  srcDir = path.join(workRoot, 'src');
  outZip = path.join(workRoot, 'delta.zip');
  extractDir = path.join(workRoot, 'extracted');

  buildExtensionFixture(srcDir);
});

/**
 * Populate `dir` with a representative extension layout: out/extension.js,
 * package.json, base-version.json, a nested native binary under node_modules,
 * and at least one other nested file. Mirrors what
 * vendor/vscode/extensions/pocketshell looks like at packaging time. Shared by
 * the direct-import tests (via beforeAll) and the CLI-path regression test
 * (which builds its own fixture in an isolated temp dir).
 */
function buildExtensionFixture(dir: string): void {
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'ssh2', 'build', 'Release'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(dir, 'node_modules', 'ssh2', 'lib'), {
    recursive: true,
  });

  fs.writeFileSync(path.join(dir, 'out', 'extension.js'), EXTENSION_JS);
  fs.writeFileSync(path.join(dir, 'package.json'), PACKAGE_JSON);
  fs.writeFileSync(path.join(dir, 'base-version.json'), BASE_VERSION_JSON);
  fs.writeFileSync(
    path.join(dir, 'node_modules', 'ssh2', 'build', 'Release', 'sshcrypto.node'),
    NATIVE_BYTES,
  );
  // A second nested file (non-binary) under a different subtree, so the
  // round-trip covers more than one parent chain.
  fs.writeFileSync(
    path.join(dir, 'node_modules', 'ssh2', 'lib', 'client.js'),
    'module.exports = {};\n',
  );
}

afterAll(() => {
  // Recursively clean up both temp trees (rimraf-style).
  if (workRoot) {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('packageExtensionDelta', () => {
  it(
    'produces a flat, valid delta zip that passes check-delta-zip.mjs',
    async () => {
      const { packageExtensionDelta } = await importPackager();
      const result = await packageExtensionDelta(srcDir, outZip);

      // Non-empty zip on disk.
      expect(fs.existsSync(outZip)).toBe(true);
      expect(result.bytes).toBeGreaterThan(0);
      expect(result.entryCount).toBeGreaterThan(0);
      expect(fs.statSync(outZip).size).toBe(result.bytes);

      // Reuse the REAL validator from scripts/. It asserts:
      //   - out/extension.js, package.json, base-version.json are present at root
      //   - no entry starts with pocketshell/ (flat layout)
      // Exit 0 + "zip-ok" on success.
      const validator = path.resolve(
        __dirname,
        '../../../scripts/check-delta-zip.mjs',
      );
      const stdout = execFileSync('node', [validator, outZip], {
        encoding: 'utf8',
        maxBuffer: 1 << 20,
      });
      expect(stdout).toContain('zip-ok');
    },
    30_000,
  );

  it(
    'CLOSED LOOP: runtime extractor installs the zip byte-for-byte (incl. native binary)',
    async () => {
      // outZip was produced by the test above; assert it's there in case test
      // ordering ever changes.
      expect(fs.existsSync(outZip)).toBe(true);

      const zipBuf = fs.readFileSync(outZip);

      // Extract via the REAL runtime extractor used by the in-app updater.
      // extractZipBuffer enforces zip-slip containment AND verifies each
      // entry's CRC-32; if it succeeds, the zip yazl produced is structurally
      // and integrity-valid from yauzl's perspective.
      await extractZipBuffer(zipBuf, extractDir);

      // Walk EVERY regular file in the ORIGINAL srcDir and assert its bytes
      // equal the corresponding extracted file's bytes. This proves what yazl
      // builds, yauzl installs — byte-for-byte — including the .node binary
      // and nested files.
      const originals = walkRegularFiles(srcDir);
      expect(originals.length).toBeGreaterThanOrEqual(5); // sanity: fixture populated

      for (const { rel, abs } of originals) {
        const extractedPath = path.join(extractDir, rel);
        expect(
          fs.existsSync(extractedPath),
          `extracted file missing: ${rel}`,
        ).toBe(true);

        const originalBytes = fs.readFileSync(abs);
        const extractedBytes = fs.readFileSync(extractedPath);
        expect(
          originalBytes.equals(extractedBytes),
          `byte mismatch for ${rel}`,
        ).toBe(true);
      }

      // Explicitly call out the native binary: a corrupted/cross-platform
      // packaging step would mangle it (e.g. text-mode read, encoding
      // conversion). Asserting it specifically makes a regression obvious.
      const nativeRel =
        'node_modules/ssh2/build/Release/sshcrypto.node';
      const extractedNative = path.join(extractDir, nativeRel);
      expect(fs.existsSync(extractedNative)).toBe(true);
      expect(fs.readFileSync(extractedNative).equals(NATIVE_BYTES)).toBe(true);
    },
    30_000,
  );

  it(
    'CLI PATH: `node package-extension-delta.mjs <src> <out>` runs main() ' +
      'end-to-end and produces a check-delta-zip-valid zip',
    () => {
      // This test exists BECAUSE the two tests above import
      // packageExtensionDelta directly and therefore NEVER exercise main() or
      // the main-module guard at the bottom of the script. That gap is exactly
      // what let the BLOCKER (Finding 1) slip through: the old
      // `import.meta.url === \`file://${process.argv[1]}\` guard NEVER matched
      // on Windows (triple-slash file:// URL vs backslash argv), so main()
      // silently never ran and the win32-x64 release job produced NO zip.
      // Spawning the script as a child process forces the guard to evaluate,
      // which would have caught the regression on Windows. On Linux it
      // validates the happy path end-to-end through the real CLI.

      // Build an isolated fixture so this test does not race with the
      // shared outZip consumed by the closed-loop test above.
      const cliWorkRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'psh-delta-cli-'),
      );
      const cliSrcDir = path.join(cliWorkRoot, 'src');
      const cliOutZip = path.join(cliWorkRoot, 'delta.zip');
      try {
        buildExtensionFixture(cliSrcDir);

        // Spawn the script as a child process. execFileSync throws on a
        // non-zero exit (i.e. the guard failed to run main()), so just
        // reaching the next assertion proves the guard matched on this OS.
        const stdout = execFileSync(
          process.execPath,
          [PACKAGER_SCRIPT, cliSrcDir, cliOutZip],
          { encoding: 'utf8', maxBuffer: 1 << 20 },
        );
        expect(stdout).toContain('wrote');

        // A non-empty zip landed on disk.
        expect(fs.existsSync(cliOutZip)).toBe(true);
        expect(fs.statSync(cliOutZip).size).toBeGreaterThan(0);

        // The REAL validator (the same one the release workflow runs
        // immediately after this packager) must accept it: exit 0 + "zip-ok".
        const validatorStdout = execFileSync(
          process.execPath,
          [VALIDATOR_SCRIPT, cliOutZip],
          { encoding: 'utf8', maxBuffer: 1 << 20 },
        );
        expect(validatorStdout).toContain('zip-ok');
      } finally {
        fs.rmSync(cliWorkRoot, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RelAbs {
  rel: string; // POSIX-relative path from srcDir
  abs: string; // absolute path
}

/**
 * Walk `root` and return every regular file as { rel, abs }, where `rel` uses
 * POSIX separators (matching zip entry names).
 */
function walkRegularFiles(root: string): RelAbs[] {
  const out: RelAbs[] = [];
  const visit = (dir: string, prefix: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        visit(abs, rel);
      } else if (stat.isFile()) {
        out.push({ rel, abs });
      }
    }
  };
  visit(root, '');
  return out;
}
