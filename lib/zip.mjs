// Reading a file out of a ZIP archive with Node alone: the central directory, then the one entry
// wanted, stored or deflated. Nothing is written to disk and no name in the archive is used as a path.

import { inflateRawSync } from 'node:zlib';

/** The entries of a ZIP archive: { name, method, size, packed, at }. */
export function zipEntries(buf) {
  // The end of the central directory: its signature, searched from the end (a comment may follow it).
  let end = -1;
  for (let o = buf.length - 22; o >= Math.max(0, buf.length - 22 - 65535); o--) {
    if (buf.readUInt32LE(o) === 0x06054b50) {
      end = o;
      break;
    }
  }
  if (end < 0) throw new Error('zip: no end of central directory (not a ZIP archive)');
  const count = buf.readUInt16LE(end + 10);
  let o = buf.readUInt32LE(end + 16);
  if (count === 0xffff || o === 0xffffffff) throw new Error('zip: ZIP64 archives are not read');
  const entries = [];
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(o) !== 0x02014b50) throw new Error('zip: a broken central directory');
    const [method, packed, size] = [buf.readUInt16LE(o + 10), buf.readUInt32LE(o + 20), buf.readUInt32LE(o + 24)];
    const [nameLength, extraLength, commentLength] = [buf.readUInt16LE(o + 28), buf.readUInt16LE(o + 30), buf.readUInt16LE(o + 32)];
    entries.push({ name: buf.toString('utf8', o + 46, o + 46 + nameLength), method, size, packed, at: buf.readUInt32LE(o + 42) });
    o += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The bytes of the first entry whose name matches. */
export function unzip(buf, match) {
  const entry = zipEntries(buf).find((e) => match.test(e.name));
  if (!entry) throw new Error(`zip: no entry matches ${match}`);
  if (buf.readUInt32LE(entry.at) !== 0x04034b50) throw new Error('zip: a broken local header');
  const start = entry.at + 30 + buf.readUInt16LE(entry.at + 26) + buf.readUInt16LE(entry.at + 28);
  const raw = buf.subarray(start, start + entry.packed);
  if (entry.method === 0) return raw;
  if (entry.method !== 8) throw new Error(`zip: compression method ${entry.method} is not read`);
  const out = inflateRawSync(raw, { maxOutputLength: 2 ** 31 - 1 });
  if (out.length !== entry.size) throw new Error(`zip: ${entry.name} is ${out.length} bytes, the archive says ${entry.size}`);
  return out;
}
