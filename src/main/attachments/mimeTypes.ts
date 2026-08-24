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
  // Audio / video, for completeness — the pipeline is type-agnostic.
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'weba',
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
