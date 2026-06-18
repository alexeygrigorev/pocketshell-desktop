/**
 * Minimal ZIP archive builder for tests.
 *
 * Produces a valid ZIP (stored or deflated entries, single central directory,
 * end-of-central-directory record) that the installer's pure-node extractor can
 * read. Kept dependency-free so tests do not pull in a zip library.
 */

import { deflateRawSync } from 'node:zlib';

interface BuiltEntry {
  name: string;
  data: Buffer; // uncompressed
  deflate: boolean;
}

/** Builder fluent API for constructing a small zip archive. */
export class ZipBuilder {
  private entries: BuiltEntry[] = [];

  store(name: string, data: string | Buffer = ''): this {
    this.entries.push({ name, data: Buffer.from(data), deflate: false });
    return this;
  }

  deflate(name: string, data: string | Buffer): this {
    this.entries.push({ name, data: Buffer.from(data), deflate: true });
    return this;
  }

  dir(name: string): this {
    if (!name.endsWith('/')) name += '/';
    return this.store(name, '');
  }

  /** Serialize to a ZIP file buffer. */
  build(): Buffer {
    const localParts: Buffer[] = [];
    const centralParts: Buffer[] = [];
    let offset = 0;

    for (const entry of this.entries) {
      const nameBuf = Buffer.from(entry.name, 'utf8');
      const isDir = entry.name.endsWith('/');
      const compressed = entry.deflate && !isDir ? deflateRawSync(entry.data) : entry.data;
      const method = entry.deflate && !isDir ? 8 : 0;
      const crc = crc32(entry.data);

      // Local file header (30 bytes + name).
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4); // version needed
      local.writeUInt16LE(0, 6); // flags
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(0, 10); // mod time
      local.writeUInt16LE(0, 12); // mod date
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(entry.data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28); // extra len

      localParts.push(local, nameBuf, compressed);

      // Central directory header (46 bytes + name).
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4); // version made by
      central.writeUInt16LE(20, 6); // version needed
      central.writeUInt16LE(0, 8); // flags
      central.writeUInt16LE(method, 10);
      central.writeUInt16LE(0, 12); // mod time
      central.writeUInt16LE(0, 14); // mod date
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(compressed.length, 20);
      central.writeUInt32LE(entry.data.length, 24);
      central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt16LE(0, 30); // extra len
      central.writeUInt16LE(0, 32); // comment len
      central.writeUInt16LE(0, 34); // disk number
      central.writeUInt16LE(0, 36); // internal attrs
      central.writeUInt32LE(isDir ? 0x10 : 0, 38); // external attrs
      central.writeUInt32LE(offset, 42); // local header offset
      centralParts.push(central, nameBuf);

      offset += local.length + nameBuf.length + compressed.length;
    }

    const cdStart = offset;
    const centralBuf = Buffer.concat(centralParts);
    const cdSize = centralBuf.length;

    // End of central directory record (22 bytes).
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4); // disk number
    eocd.writeUInt16LE(0, 6); // disk with cd
    eocd.writeUInt16LE(this.entries.length, 8); // entries on this disk
    eocd.writeUInt16LE(this.entries.length, 10); // total entries
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20); // comment len

    return Buffer.concat([...localParts, centralBuf, eocd]);
  }
}

// CRC-32 (IEEE 802.3) table-based implementation.
const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
