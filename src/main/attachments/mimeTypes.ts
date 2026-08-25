/**
 * MIME type -> file extension mapping for staged attachments.
 *
 * Mirrors `ShareUploader.extensionForMimeType` on Android, which defers
 * to the platform's `MimeTypeMap`. Electron has no equivalent registry,
 * so the common types are tabulated here and everything else falls
 * through a narrow heuristic (see below).
 *
 * This is only ever a *default*: it applies when the attachment has no
 * usable extension of its own. A file the user picked already carries
 * one in its basename, so this table is mostly exercised by clipboard
 * pastes, where the platform hands us bytes plus a mime type and either
 * no name at all or a generic one like "image.png".
 */

/**
 * Known mime -> extension pairs. Deliberately small: the goal is
 * "the extension a human would expect", not an exhaustive IANA mirror.
 */
const EXTENSIONS: Readonly<Record<string, string>> = {
  // Images — the paste path's bread and butter.
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/svg+xml': 'svg',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  // Documents and text — "upload a file" is not image-only.
  'application/pdf': 'pdf',
  // `application/x-pdf` and `application/vnd.pdf` would survive the
  // subtype heuristic below on their own; `application/acrobat` is the
  // one legacy spelling that would not, and it is still what a few
  // older Windows applications put on the clipboard.
  'application/x-pdf': 'pdf',
  'application/acrobat': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/css': 'css',
  'text/xml': 'xml',
  'application/xml': 'xml',
  'application/json': 'json',
  'application/javascript': 'js',
  'text/javascript': 'js',
  'application/typescript': 'ts',
  'application/rtf': 'rtf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  // Archives.
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'application/x-gzip': 'gz',
  'application/x-tar': 'tar',
  'application/x-7z-compressed': '7z',
  // Audio. Tabulated in full rather than left to the subtype heuristic,
  // because audio is no longer here "for completeness": a voice memo or
  // a recorded call is an ordinary thing to hand a coding agent, and it
  // is the one attachment class that routinely arrives as bytes with a
  // mime type and no filename (a recorder applet's drag payload), which
  // is exactly the case this table exists to serve.
  //
  // The heuristic gets several of these right by accident — `audio/flac`
  // yields `flac` — but it is actively wrong wherever the registry name
  // and the extension diverge, and audio is where that happens most:
  // `audio/vnd.wave` would land as `.wave`, and `audio/x-ms-wma` folds
  // to `ms-wma`, which the alphanumeric guard then rejects outright,
  // leaving the file with no extension at all. Listing the spellings is
  // cheaper than teaching the heuristic about them.
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/x-aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/x-pn-wav': 'wav',
  'audio/aiff': 'aiff',
  'audio/x-aiff': 'aiff',
  'audio/x-ms-wma': 'wma',
  // `weba`, not `webm`: a WebM container holding only an audio track is
  // conventionally suffixed `.weba`, and keeping it distinct from the
  // video row below is what stops a voice clip from being labelled a
  // video on the remote side.
  'audio/webm': 'weba',
  // Video.
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
};

/**
 * Extension (no leading dot) for `mime`, or null when nothing sensible
 * can be derived.
 *
 * Parameters are stripped (`image/png; charset=binary` -> `image/png`)
 * and the type is lower-cased before lookup. When the exact type is not
 * tabulated we fall back to the subtype with an `x-` prefix and a
 * `+suffix` removed (`image/x-foo` -> `foo`, `application/bar+xml` ->
 * `bar`) as long as it still looks like a plausible extension. Android
 * returns null in that case; we are slightly more generous because
 * desktop clipboards surface far more long-tail types than an Android
 * share sheet, and a wrong-but-plausible extension is friendlier than
 * an extension-less file the agent cannot guess at.
 */
export function extensionForMimeType(mime: string | null | undefined): string | null {
  if (mime == null) return null;
  const normalised = mime.split(';')[0]!.trim().toLowerCase();
  if (normalised === '') return null;

  const known = EXTENSIONS[normalised];
  if (known != null) return known;

  const slash = normalised.indexOf('/');
  if (slash <= 0) return null;
  const subtype = normalised
    .slice(slash + 1)
    .replace(/^(x-|vnd\.)/, '')
    .split('+')[0]!;
  // Only accept a short, plainly alphanumeric subtype — anything with
  // dots or unusual length is a registry name, not an extension.
  return /^[a-z0-9]{1,8}$/.test(subtype) ? subtype : null;
}

// ---------------------------------------------------------------------------
// The inverse direction: extension -> mime
// ---------------------------------------------------------------------------
//
// The Files tab needs the OPPOSITE lookup from everything above. It starts
// from a remote filename — the only thing an SFTP listing gives it — and has
// to decide what the bytes are before it reads them, because reading an mp3
// as UTF-8 text is what froze the app. To render those bytes it then needs a
// mime type for the `Blob` it hands to `<audio>` / `<embed>`, since a Blob
// with no type is served as `application/octet-stream` and Chromium will not
// play or paginate it.
//
// This lives here, beside {@link extensionForMimeType}, rather than in a
// second table next to the Files tab. Two independent mime tables in one app
// drift the moment either is extended — and this one was extended today with
// the full audio set precisely because audio matters now.

/**
 * Reverse of {@link EXTENSIONS}, built once, FIRST SPELLING WINS.
 *
 * The forward table is many-to-one (`audio/mpeg` and `audio/mp3` both yield
 * `mp3`), so the inverse needs a tie-break. Declaration order is it: every
 * group in the table above is written canonical-spelling-first — `image/jpeg`
 * before `image/jpg`, `audio/mpeg` before `audio/mp3`, `application/pdf`
 * before its legacy aliases — so taking the first entry that maps to an
 * extension yields the registered type rather than a vendor alias.
 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const [mime, ext] of Object.entries(EXTENSIONS)) {
    out[ext] ??= mime;
  }
  // Spellings a user's files carry but a clipboard never offers, so they have
  // no row in the forward table: `.jpeg` written out in full, the audiobook
  // and secondary Ogg suffixes, and the two plain-text suffixes that must
  // resolve to a type rather than fall through to "unknown binary".
  out['jpeg'] = 'image/jpeg';
  out['m4b'] = 'audio/mp4';
  out['oga'] = 'audio/ogg';
  out['spx'] = 'audio/ogg';
  // Web-asset spellings, added for the HTML preview (src/main/preview/).
  //
  // These are here rather than in the forward table because they are not
  // things a CLIPBOARD ever hands over — nobody pastes a webfont — so they
  // have no "what extension would a human expect" answer to contribute. What
  // they do have is a Content-Type the preview's protocol handler must send:
  // a stylesheet served as `application/octet-stream` is ignored by the
  // renderer, and a font fetched without `font/woff2` is refused, both of
  // which look exactly like a page that has no styling rather than like the
  // header bug they are.
  //
  // `htm` and `xhtml` earn their place for a different reason: they are what
  // the Files tab's classifier keys on to route a file to the preview at all
  // (src/renderer/fileKind.ts), and a `.htm` that resolved to null would open
  // in the editor while its `.html` twin previewed.
  out['htm'] = 'text/html';
  out['xhtml'] = 'application/xhtml+xml';
  out['mjs'] = 'text/javascript';
  out['cjs'] = 'text/javascript';
  out['map'] = 'application/json';
  out['webmanifest'] = 'application/manifest+json';
  out['woff'] = 'font/woff';
  out['woff2'] = 'font/woff2';
  out['ttf'] = 'font/ttf';
  out['otf'] = 'font/otf';
  out['eot'] = 'application/vnd.ms-fontobject';
  return out;
})();

/**
 * The canonical mime type for a file extension, or null when unknown.
 *
 * Accepts the extension with or without its leading dot, in any case.
 * Deliberately returns null rather than `application/octet-stream` for an
 * unrecognised extension: "I do not know" and "I know it is opaque bytes" are
 * different answers, and the Files tab's classifier acts on the difference —
 * an unknown extension gets its bytes sniffed, a known-opaque one does not.
 */
export function mimeTypeForExtension(ext: string | null | undefined): string | null {
  if (ext == null) return null;
  const key = ext.trim().toLowerCase().replace(/^\./, '');
  if (key === '') return null;
  return MIME_BY_EXTENSION[key] ?? null;
}

/** The lower-cased extension of a path's basename (no dot), or null. */
export function extensionOfPath(path: string): string | null {
  // POSIX separators only: every path this sees is a remote one.
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  // A leading dot is a dotfile (`.bashrc`), not an extension.
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}
