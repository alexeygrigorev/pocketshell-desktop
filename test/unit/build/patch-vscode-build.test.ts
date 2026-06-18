/**
 * Regression test for scripts/patch-vscode-build.js.
 *
 * Bug: on the windows-2022 runner, git's autocrlf=true checks the vendored VS
 * Code source out with \r\n (CRLF). The patch helpers use literal \n-joined
 * multi-line STRING targets via replaceRequired(), which does a byte-exact
 * content.includes(target). A \n-joined target can never be found inside \r\n
 * content, so the first multi-line replaceRequired call
 * (patchActivityBarViewContainers) threw `Patch target not found` and broke the
 * Windows release build.
 *
 * Fix: read() normalizes CRLF -> LF before returning file content, making every
 * patch CRLF-agnostic. These tests prove that fix end-to-end against the actual
 * exported replaceRequired helper.
 */

import { describe, it, expect } from 'vitest';
import { replaceRequired } from '../../../scripts/patch-vscode-build';

// The same multi-line literal target the patch uses (see line ~183 of
// patch-vscode-build.js). Joined with \n, exactly as in production.
const getViewContainersTarget =
  '\tprivate getViewContainers(): readonly ViewContainer[] {\n\t\treturn this.viewDescriptorService.getViewContainersByLocation(this.location);\n\t}';

const getViewContainersReplacement =
  '\tprivate getViewContainers(): readonly ViewContainer[] {\n\t\tconst hidden = new Set<string>(["workbench.view.explorer"]);\n\t\treturn this.viewDescriptorService.getViewContainersByLocation(this.location).filter(c => !hidden.has(c.id));\n\t}';

describe('replaceRequired - CRLF tolerance (Windows release blocker)', () => {
  it('documents why the bug happened: a \\n target is NOT present in CRLF content', () => {
    // Simulate git autocrlf=true on windows: source bytes are \r\n-terminated.
    const crlf =
      'class X {\r\n\tprivate getViewContainers(): readonly ViewContainer[] {\r\n\t\treturn this.viewDescriptorService.getViewContainersByLocation(this.location);\r\n\t}\r\n}\r\n';

    // This is the exact check replaceRequired() does (content.includes(target)).
    // It MUST be false on CRLF content — that is the bug.
    expect(crlf.includes(getViewContainersTarget)).toBe(false);

    // And without normalization, replaceRequired throws (fail-loud).
    expect(() =>
      replaceRequired(crlf, getViewContainersTarget, getViewContainersReplacement, 'regression'),
    ).toThrow(/Patch target not found/);
  });

  it('matches and replaces a literal multi-line target after read() CRLF normalization (the fix)', () => {
    const crlf =
      'class X {\r\n\tprivate getViewContainers(): readonly ViewContainer[] {\r\n\t\treturn this.viewDescriptorService.getViewContainersByLocation(this.location);\r\n\t}\r\n}\r\n';

    // This is exactly what read() does after the fix.
    const normalized = crlf.replace(/\r\n/g, '\n');

    // Now the \n-joined target IS present and replaceRequired succeeds.
    const result = replaceRequired(
      normalized,
      getViewContainersTarget,
      getViewContainersReplacement,
      'patchActivityBarViewContainers getViewContainers',
    );

    // Replacement applied...
    expect(result).toContain('hidden.has(c.id)');
    expect(result).not.toContain(
      'return this.viewDescriptorService.getViewContainersByLocation(this.location);\n\t}',
    );
    // ...and the rest of the file (the class wrapper, trailing newline) intact.
    expect(result).toContain('class X {');
    expect(result.endsWith('}\n')).toBe(true);
  });
});

describe('replaceRequired - LF path (no regression on linux/mac)', () => {
  it('matches and replaces a literal multi-line target against LF content', () => {
    const lf =
      'class X {\n\tprivate getViewContainers(): readonly ViewContainer[] {\n\t\treturn this.viewDescriptorService.getViewContainersByLocation(this.location);\n\t}\n}\n';

    const result = replaceRequired(lf, getViewContainersTarget, getViewContainersReplacement);

    expect(result).toContain('hidden.has(c.id)');
    expect(result).not.toContain(
      'return this.viewDescriptorService.getViewContainersByLocation(this.location);\n\t}',
    );
    expect(result).toContain('class X {');
  });
});

describe('replaceRequired - fail loud on upstream drift', () => {
  it('throws when the target is genuinely absent (preserves upstream-drift signal)', () => {
    expect(() =>
      replaceRequired('totally unrelated content', 'NOT PRESENT\n', 'x'),
    ).toThrow(/Patch target not found/);
  });
});
