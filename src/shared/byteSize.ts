/**
 * Human byte formatting — one ladder, one refusal sentence.
 *
 * These were re-derived in five places across main and renderer (the size
 * refusals in AttachmentStager / LocalFileReader / SftpService, the files
 * store's open-cap notes, the ports panel's row sizes). One copy here is the
 * "one voice in the UI" the SftpService comment used to maintain by hand.
 */

/**
 * The B / KB / MB / GB ladder, one decimal above bytes.
 *
 * Main and renderer both import it: a size shown in a file listing and a size
 * named in a refusal sentence must never disagree about how big the same file
 * is.
 */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** Megabyte figure with one decimal — the "N.N MB" voice the refusals share. */
export function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * The oversize-refusal sentence. [subject] is a path (SFTP read, local read
 * backing) or a human label (attachment staging) — the sentence is the same.
 */
export function oversizeMessage(size: number, maxBytes: number, subject: string): string {
  return `${subject} is ${formatMb(size)} MB; the limit is ${formatMb(maxBytes)} MB`;
}
