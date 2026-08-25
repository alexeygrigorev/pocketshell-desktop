import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NAME,
  MAX_LENGTH,
  composeRemoteName,
  renderSanitised,
  sanitiseFilename,
} from '@main/attachments/FilenameSanitiser';
import { extensionForMimeType } from '@main/attachments/mimeTypes';

/**
 * Ported from the Android app's FilenameSanitiserTest (issue #138
 * acceptance: path traversal, null bytes, very long names, Unicode).
 * Defects here mean we land files outside the attachments directory or
 * under shell-unsafe names.
 */
describe('sanitiseFilename', () => {
  const render = (input: string | null | undefined, ext?: string | null): string =>
    renderSanitised(sanitiseFilename(input, ext));

  it('strips path traversal segments', () => {
    expect(render('../../../etc/passwd')).toBe('passwd');
    expect(render('../../../etc/passwd')).not.toContain('..');
    expect(render('../../../etc/passwd')).not.toContain('/');
  });

  it('treats backslashes as path separators', () => {
    expect(render('..\\..\\Windows\\System32\\drivers\\hosts')).toBe('hosts');
  });

  it('strips null bytes', () => {
    const nul = String.fromCharCode(0);
    expect(render(`safe${nul}name${nul}.txt`)).toBe('safename.txt');
  });

  it('strips control characters', () => {
    const bel = String.fromCharCode(0x07);
    const esc = String.fromCharCode(0x1b);
    const del = String.fromCharCode(0x7f);
    expect(render(`foo${bel}bar${esc}baz${del}.txt`)).toBe('foobarbaz.txt');
  });

  it('collapses whitespace runs to a single underscore', () => {
    expect(render('Recording 2024-05-14 09 30 12.m4a')).toBe(
      'Recording_2024-05-14_09_30_12.m4a',
    );
    // Newlines/tabs are whitespace first, control characters second — the
    // ordering is what keeps `foo\nbar` readable instead of `foobar`.
    expect(render('foo\nbar\tbaz.txt')).toBe('foo_bar_baz.txt');
  });

  it('collapses underscore runs and trims separators', () => {
    expect(render('report (final).docx')).toBe('report_final.docx');
    expect(render('__weird__.txt')).toBe('weird.txt');
    expect(render('-dashes-.txt')).toBe('dashes.txt');
  });

  it('splits the extension on the LAST dot', () => {
    const result = sanitiseFilename('archive.tar.gz');
    expect(result.base).toBe('archive.tar');
    expect(result.ext).toBe('gz');
  });

  it('treats a leading-dot name as having no extension', () => {
    const result = sanitiseFilename('.bashrc');
    expect(result.base).toBe('bashrc');
    expect(result.ext).toBe('');
  });

  it('treats a trailing dot as having no extension', () => {
    const result = sanitiseFilename('notes.');
    expect(result.base).toBe('notes');
    expect(result.ext).toBe('');
  });

  it('falls back to the default stem for empty and dot-only input', () => {
    expect(render('')).toBe(DEFAULT_NAME);
    expect(render(null)).toBe(DEFAULT_NAME);
    expect(render(undefined)).toBe(DEFAULT_NAME);
    expect(render('...')).toBe(DEFAULT_NAME);
    expect(render('..')).toBe(DEFAULT_NAME);
    // A name made only of disallowed characters collapses to `_`, which the
    // trim then removes — same empty-stem path.
    expect(render('***')).toBe(DEFAULT_NAME);
  });

  it('keeps non-ASCII letters and digits', () => {
    expect(render('отчёт.txt')).toBe('отчёт.txt');
    expect(render('日本語ファイル.png')).toBe('日本語ファイル.png');
    expect(render('café résumé.pdf')).toBe('café_résumé.pdf');
  });

  it('caps the total length while preserving the extension', () => {
    const result = sanitiseFilename(`${'a'.repeat(500)}.txt`);
    expect(result.ext).toBe('txt');
    expect(renderSanitised(result).length).toBe(MAX_LENGTH);
    // The cap trims the stem, never the extension.
    expect(result.base.length).toBe(MAX_LENGTH - 'txt'.length - 1);
  });

  it('caps an absurdly long extension at 16 characters', () => {
    const result = sanitiseFilename(`payload.${'z'.repeat(64)}`);
    expect(result.ext).toBe('z'.repeat(16));
    expect(renderSanitised(result).length).toBeLessThanOrEqual(MAX_LENGTH);
  });

  it('caps a long name that has no extension at all', () => {
    const result = sanitiseFilename('b'.repeat(500));
    expect(result.ext).toBe('');
    expect(result.base.length).toBe(MAX_LENGTH);
  });

  it('applies the default extension only when the name has none', () => {
    expect(render('screenshot', 'png')).toBe('screenshot.png');
    // An existing extension always wins over the mime-derived default.
    expect(render('diagram.svg', 'png')).toBe('diagram.svg');
    expect(render('.bashrc', 'txt')).toBe('bashrc.txt');
  });

  it('sanitises the default extension too', () => {
    expect(render('shot', '../png')).toBe('shot.png');
  });

  it('composes the timestamped remote name', () => {
    expect(composeRemoteName('20260824-101500', sanitiseFilename('shot.png'))).toBe(
      '20260824-101500-shot.png',
    );
    expect(composeRemoteName('20260824-101500', sanitiseFilename('README'))).toBe(
      '20260824-101500-README',
    );
  });
});

describe('extensionForMimeType', () => {
  it('maps the common clipboard image types', () => {
    expect(extensionForMimeType('image/png')).toBe('png');
    expect(extensionForMimeType('image/jpeg')).toBe('jpg');
    expect(extensionForMimeType('image/gif')).toBe('gif');
    expect(extensionForMimeType('image/webp')).toBe('webp');
    expect(extensionForMimeType('image/svg+xml')).toBe('svg');
  });

  it('maps non-image types — the pipeline is not image-only', () => {
    expect(extensionForMimeType('application/pdf')).toBe('pdf');
    expect(extensionForMimeType('text/plain')).toBe('txt');
    expect(extensionForMimeType('text/markdown')).toBe('md');
    expect(extensionForMimeType('application/json')).toBe('json');
    expect(extensionForMimeType('application/zip')).toBe('zip');
  });

  it('maps the common audio types', () => {
    expect(extensionForMimeType('audio/mpeg')).toBe('mp3');
    expect(extensionForMimeType('audio/mp4')).toBe('m4a');
    expect(extensionForMimeType('audio/wav')).toBe('wav');
    expect(extensionForMimeType('audio/ogg')).toBe('ogg');
    expect(extensionForMimeType('audio/opus')).toBe('opus');
    expect(extensionForMimeType('audio/flac')).toBe('flac');
    expect(extensionForMimeType('audio/aac')).toBe('aac');
    expect(extensionForMimeType('audio/webm')).toBe('weba');
  });

  it('maps the PDF spellings, including the legacy one', () => {
    expect(extensionForMimeType('application/pdf')).toBe('pdf');
    expect(extensionForMimeType('application/x-pdf')).toBe('pdf');
    // Would otherwise sanitise to ".acrobat", which no reader opens.
    expect(extensionForMimeType('application/acrobat')).toBe('pdf');
  });

  it('tabulates the audio spellings the subtype heuristic gets wrong', () => {
    // Each of these is why the audio rows are listed out rather than
    // left to the `x-`/`vnd.` fallback: the registry name and the
    // extension diverge, so the fallback would produce ".wave" or, for
    // the dashed ones, no extension at all.
    expect(extensionForMimeType('audio/wave')).toBe('wav');
    expect(extensionForMimeType('audio/vnd.wave')).toBe('wav');
    expect(extensionForMimeType('audio/x-pn-wav')).toBe('wav');
    expect(extensionForMimeType('audio/x-ms-wma')).toBe('wma');
  });

  it('normalises case and strips parameters', () => {
    expect(extensionForMimeType('IMAGE/PNG')).toBe('png');
    expect(extensionForMimeType('image/png; charset=binary')).toBe('png');
    expect(extensionForMimeType('  image/jpeg  ')).toBe('jpg');
    // The codecs parameter is how Opus normally announces itself; the
    // container is still Ogg, so the extension is too.
    expect(extensionForMimeType('audio/ogg; codecs=opus')).toBe('ogg');
    expect(extensionForMimeType('AUDIO/MPEG')).toBe('mp3');
  });

  it('falls back to a plausible subtype for untabulated types', () => {
    expect(extensionForMimeType('image/x-foo')).toBe('foo');
    expect(extensionForMimeType('application/bar+xml')).toBe('bar');
  });

  it('returns null when nothing sensible can be derived', () => {
    expect(extensionForMimeType(null)).toBeNull();
    expect(extensionForMimeType(undefined)).toBeNull();
    expect(extensionForMimeType('')).toBeNull();
    expect(extensionForMimeType('nonsense')).toBeNull();
    expect(extensionForMimeType('application/vnd.some.long.registry.name')).toBeNull();
  });
});
