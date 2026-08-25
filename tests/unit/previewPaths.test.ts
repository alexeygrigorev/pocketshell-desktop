import { describe, expect, it } from 'vitest';
import {
  PREVIEW_SCHEME,
  containedIn,
  normalisePosixPath,
  parentDirOf,
  previewUrlFor,
  resolveRequestPath,
  tokenOfUrl,
} from '../../src/main/preview/previewPaths';

/**
 * The traversal boundary of the HTML preview.
 *
 * Every case here is an attempt by a document we did not write to name a path
 * outside the folder it was previewed from. That is not a hypothetical: the
 * previewed HTML comes off a remote host over SFTP and is exactly as
 * untrusted as terminal output, and the whole point of serving it on a custom
 * scheme is that its relative references come back to main as PATHS TO READ.
 * If this module is wrong, an HTML file on someone's server decides which
 * files the app pulls over their own SSH connection.
 *
 * Note what is deliberately NOT relied on anywhere below: Chromium's own URL
 * normalisation. It does fold `..` before a request reaches main, and every
 * one of these strings would in practice arrive already flattened — but a
 * defence that only works because something upstream also implements it is
 * not a defence, and the upstream in question is not part of this repo.
 */

const ROOT = '/home/u/site';

describe('normalisePosixPath', () => {
  it('folds . and .. and collapses repeated separators', () => {
    expect(normalisePosixPath('/a/./b/../c')).toBe('/a/c');
    expect(normalisePosixPath('/a//b///c')).toBe('/a/b/c');
    expect(normalisePosixPath('/a/b/')).toBe('/a/b');
  });

  it('refuses a climb above the filesystem root rather than clamping it', () => {
    // Clamping is the common implementation and is what quietly turns
    // `../../../../etc/passwd` into a perfectly valid `/etc/passwd` that then
    // has to be caught by the containment check alone. Refusing means the
    // ATTEMPT is the error, wherever it would have landed.
    expect(normalisePosixPath('/../etc/passwd')).toBeNull();
    expect(normalisePosixPath('/a/../../etc/passwd')).toBeNull();
  });

  it('refuses a relative path — there is no base to resolve one against here', () => {
    expect(normalisePosixPath('a/b')).toBeNull();
    expect(normalisePosixPath('')).toBeNull();
  });

  it('refuses an embedded NUL', () => {
    // A C-string API on the far side truncates at the NUL, so `/safe\0/../..`
    // would be checked as one path and read as another.
    expect(normalisePosixPath('/home/u/site/a\0/../../../etc/passwd')).toBeNull();
    expect(normalisePosixPath('/home/u/site/ok\0.css')).toBeNull();
  });

  it('treats a backslash as an ordinary filename character', () => {
    // The remote is always POSIX. Splitting on `\` would corrupt legal names
    // without buying anything.
    expect(normalisePosixPath('/a/we\\ird/b')).toBe('/a/we\\ird/b');
  });

  it('maps the root to itself', () => {
    expect(normalisePosixPath('/')).toBe('/');
  });
});

describe('containedIn', () => {
  it('accepts the root itself and anything under it', () => {
    expect(containedIn(ROOT, ROOT)).toBe(true);
    expect(containedIn(ROOT, '/home/u/site/css/main.css')).toBe(true);
  });

  it('rejects a sibling whose name merely starts with the root', () => {
    // The bug this function exists to not have.
    expect(containedIn('/home/alexey', '/home/alexey-secrets/id_rsa')).toBe(false);
    expect(containedIn(ROOT, '/home/u/site-backup/x')).toBe(false);
  });

  it('rejects a parent and an unrelated path', () => {
    expect(containedIn(ROOT, '/home/u')).toBe(false);
    expect(containedIn(ROOT, '/etc/passwd')).toBe(false);
  });

  it('handles / as a root without doubling the separator', () => {
    expect(containedIn('/', '/etc/passwd')).toBe(true);
    expect(containedIn('/', '/')).toBe(true);
  });

  it('tolerates a trailing separator on the root', () => {
    expect(containedIn('/home/u/site/', '/home/u/site/a.css')).toBe(true);
    expect(containedIn('/home/u/site/', '/home/u/other')).toBe(false);
  });
});

describe('resolveRequestPath', () => {
  const url = (path: string) => `${PREVIEW_SCHEME}://abc123${path}`;

  it('resolves an ordinary relative asset the browser has already joined', () => {
    expect(resolveRequestPath(url('/home/u/site/css/main.css'), ROOT)).toEqual({
      ok: true,
      path: '/home/u/site/css/main.css',
    });
  });

  it('drops the query and the fragment', () => {
    // The query is the preview's own business (cache-busting); a fragment
    // never reaches a server at all. Neither is ever part of a filename.
    expect(resolveRequestPath(url('/home/u/site/a.css?v=2#top'), ROOT)).toEqual({
      ok: true,
      path: '/home/u/site/a.css',
    });
  });

  it('percent-decodes exactly once, so a real filename with a space works', () => {
    expect(resolveRequestPath(url('/home/u/site/my%20file.css'), ROOT)).toEqual({
      ok: true,
      path: '/home/u/site/my file.css',
    });
  });

  it('refuses a percent-encoded traversal', () => {
    // `%2e%2e` is not a path segment to a URL parser but decodes into one,
    // which is why the decode happens BEFORE the fold rather than after.
    expect(resolveRequestPath(url('/home/u/site/%2e%2e/%2e%2e/etc/passwd'), ROOT)).toEqual({
      ok: false,
      error: 'outside-root',
    });
    expect(resolveRequestPath(url('/home/u/%2e%2e/etc/shadow'), ROOT)).toEqual({
      ok: false,
      error: 'outside-root',
    });
  });

  it('does NOT decode twice, so %252e is a literal filename', () => {
    // On the host, `%2e%2e` is a two-character-repeated ordinary filename. A
    // second decoding pass would invent a traversal that the request never
    // asked for — and, worse, would prove that this function can be talked
    // into decoding as many times as an attacker likes.
    expect(resolveRequestPath(url('/home/u/site/%252e%252e'), ROOT)).toEqual({
      ok: true,
      path: '/home/u/site/%2e%2e',
    });
  });

  it('refuses a plain textual traversal that lands outside the root', () => {
    expect(resolveRequestPath(url('/home/u/site/../../../etc/passwd'), ROOT)).toEqual({
      ok: false,
      error: 'outside-root',
    });
    expect(resolveRequestPath(url('/home/u/site/../other/x.css'), ROOT)).toEqual({
      ok: false,
      error: 'outside-root',
    });
  });

  it('refuses an absolute path the page simply asserted', () => {
    // `<img src="/etc/passwd">` resolves against the frame's origin, so it
    // arrives here as a perfectly well-formed absolute request.
    expect(resolveRequestPath(url('/etc/passwd'), ROOT)).toEqual({
      ok: false,
      error: 'outside-root',
    });
    expect(resolveRequestPath(url('/home/u/.ssh/id_ed25519'), ROOT)).toEqual({
      ok: false,
      error: 'outside-root',
    });
  });

  it('refuses a malformed percent escape instead of guessing at it', () => {
    expect(resolveRequestPath(url('/home/u/site/%zz.css'), ROOT)).toEqual({
      ok: false,
      error: 'malformed',
    });
  });

  it('refuses a string that is not a URL at all', () => {
    expect(resolveRequestPath('not a url', ROOT)).toEqual({ ok: false, error: 'malformed' });
  });

  it('is not fooled by a sibling directory that shares the root prefix', () => {
    expect(resolveRequestPath(url('/home/u/site-backup/secrets.env'), ROOT)).toEqual({
      ok: false,
      error: 'outside-root',
    });
  });
});

describe('tokenOfUrl', () => {
  it('reads the token out of the host position', () => {
    expect(tokenOfUrl('psview://deadbeef/home/u/site/a.html')).toBe('deadbeef');
  });

  it('refuses any other scheme, so no other URL can address a preview', () => {
    expect(tokenOfUrl('https://deadbeef/home/u/site/a.html')).toBeNull();
    expect(tokenOfUrl('file:///home/u/site/a.html')).toBeNull();
  });

  it('returns null when there is no host to name a preview with', () => {
    expect(tokenOfUrl('psview:///home/u/site/a.html')).toBeNull();
    expect(tokenOfUrl('nonsense')).toBeNull();
  });
});

describe('previewUrlFor', () => {
  it('produces a URL whose path mirrors the remote one, so relatives resolve', () => {
    // This is the whole mechanism in one assertion: because the path is real,
    // the browser joins `style.css` onto it correctly and we get the request.
    const url = previewUrlFor('tok', '/home/u/site/index.html');
    expect(url).toBe('psview://tok/home/u/site/index.html');
    expect(new URL('style.css', url).href).toBe('psview://tok/home/u/site/style.css');
    expect(new URL('img/logo.png', url).href).toBe('psview://tok/home/u/site/img/logo.png');
  });

  it('encodes per segment, so a ? or # in a filename cannot restructure the URL', () => {
    const url = previewUrlFor('tok', '/home/u/site/a?b#c.html');
    expect(url).toBe('psview://tok/home/u/site/a%3Fb%23c.html');
    // And it survives the round trip back through the resolver.
    expect(resolveRequestPath(url, '/home/u/site')).toEqual({
      ok: true,
      path: '/home/u/site/a?b#c.html',
    });
  });

  it('round-trips a space and a unicode name', () => {
    const url = previewUrlFor('tok', '/home/u/site/rapport final.html');
    expect(resolveRequestPath(url, '/home/u/site')).toEqual({
      ok: true,
      path: '/home/u/site/rapport final.html',
    });
    const uni = previewUrlFor('tok', '/home/u/site/отчёт.html');
    expect(resolveRequestPath(uni, '/home/u/site')).toEqual({
      ok: true,
      path: '/home/u/site/отчёт.html',
    });
  });
});

describe('parentDirOf', () => {
  it('is the directory the preview will be scoped to', () => {
    expect(parentDirOf('/home/u/site/index.html')).toBe('/home/u/site');
    expect(parentDirOf('/home/u/index.html')).toBe('/home/u');
  });

  it('does not escape the root', () => {
    expect(parentDirOf('/index.html')).toBe('/');
  });
});
