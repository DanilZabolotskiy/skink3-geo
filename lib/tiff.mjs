// Reading a georeferenced TIFF of one band with Node alone: classic TIFF and BigTIFF, little-endian,
// in tiles or strips, stored, Deflate or LZW, with the horizontal and the floating-point predictor;
// samples of 8 or 16 bits or 32-bit floats. A window reads only the blocks it needs, so a large tile
// costs what the part wanted costs. The file is data: every offset in it is checked against its length.

import { inflateSync } from 'node:zlib';

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };

/** The tags of the first image of a TIFF: Map<tag, number[] | string>. */
export function tiffTags(buf) {
  const order = buf.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') throw new Error('tiff: not a TIFF');
  if (order !== 'II') throw new Error('tiff: only little-endian TIFF is read');
  const magic = buf.readUInt16LE(2);
  if (magic !== 42 && magic !== 43) throw new Error('tiff: not a TIFF');
  const big = magic === 43;
  const u64 = (o) => Number(buf.readBigUInt64LE(o));
  const ifd = big ? u64(8) : buf.readUInt32LE(4);
  const n = big ? u64(ifd) : buf.readUInt16LE(ifd);
  const [first, step, inline] = big ? [ifd + 8, 20, 8] : [ifd + 2, 12, 4];
  if (n > 4096) throw new Error('tiff: a broken directory');
  const tags = new Map();
  for (let k = 0; k < n; k++) {
    const e = first + k * step;
    const [tag, type] = [buf.readUInt16LE(e), buf.readUInt16LE(e + 2)];
    const count = big ? u64(e + 4) : buf.readUInt32LE(e + 4);
    const size = TYPE_SIZE[type];
    if (!size) continue;
    const field = e + (big ? 12 : 8);
    const at = size * count <= inline ? field : big ? u64(field) : buf.readUInt32LE(field);
    if (at + size * count > buf.length) throw new Error(`tiff: the tag ${tag} points outside the file`);
    if (type === 2) {
      tags.set(tag, buf.toString('latin1', at, at + count).replace(/\0+$/, ''));
      continue;
    }
    const values = new Array(count);
    for (let i = 0; i < count; i++) {
      const o = at + i * size;
      values[i] = type === 3 ? buf.readUInt16LE(o) : type === 4 || type === 13 ? buf.readUInt32LE(o) : type === 12 ? buf.readDoubleLE(o) : type === 11 ? buf.readFloatLE(o) : type === 16 || type === 18 ? u64(o) : type === 1 ? buf[o] : NaN;
    }
    tags.set(tag, values);
  }
  return tags;
}

/** Undoes the TIFF predictor on the rows of a decoded tile or strip, in place. */
function unpredict(data, predictor, width, rows, bytes) {
  if (predictor === 1) return data;
  const rowBytes = width * bytes;
  if (predictor === 2) {
    for (let r = 0; r < rows; r++) {
      const base = r * rowBytes;
      if (bytes === 1) for (let i = 1; i < width; i++) data[base + i] = (data[base + i] + data[base + i - 1]) & 0xff;
      else if (bytes === 2) for (let i = 1; i < width; i++) data.writeUInt16LE((data.readUInt16LE(base + 2 * i) + data.readUInt16LE(base + 2 * i - 2)) & 0xffff, base + 2 * i);
      else for (let i = 1; i < width; i++) data.writeUInt32LE((data.readUInt32LE(base + 4 * i) + data.readUInt32LE(base + 4 * i - 4)) >>> 0, base + 4 * i);
    }
    return data;
  }
  if (predictor === 3) {
    // The floating-point predictor: the bytes of a row lie plane by plane, the most significant first,
    // each byte the difference from the one before it.
    const out = Buffer.alloc(data.length);
    for (let r = 0; r < rows; r++) {
      const base = r * rowBytes;
      for (let i = 1; i < rowBytes; i++) data[base + i] = (data[base + i] + data[base + i - 1]) & 0xff;
      for (let i = 0; i < width; i++) for (let b = 0; b < bytes; b++) out[base + i * bytes + b] = data[base + (bytes - 1 - b) * width + i];
    }
    return out;
  }
  throw new Error(`tiff: predictor ${predictor} is not read`);
}

/**
 * LZW as TIFF writes it: codes from 9 to 12 bits, the most significant bit first, 256 clears the
 * table and 257 ends the data, and the codes grow a code early. Returns `size` bytes (zeros where
 * the data ends short).
 */
export function unLzw(src, size) {
  const out = Buffer.alloc(size);
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const length = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) {
    suffix[i] = i;
    length[i] = 1;
  }
  let [next, width, old, o, bits, held, p] = [258, 9, -1, 0, 0, 0, 0];
  for (;;) {
    while (held < width && p < src.length) {
      bits = (bits << 8) | src[p++];
      held += 8;
    }
    if (held < width) break;
    const code = (bits >> (held - width)) & ((1 << width) - 1);
    held -= width;
    bits &= (1 << held) - 1;
    if (code === 257) break;
    if (code === 256) {
      [next, width, old] = [258, 9, -1];
      continue;
    }
    if (old < 0) {
      if (code > 255) throw new Error('tiff: broken LZW data');
      if (o < size) out[o] = code;
      o++;
      old = code;
      continue;
    }
    if (code > next) throw new Error('tiff: broken LZW data');
    // The string of the code, or, for the code not yet in the table, that of the last one and its first byte again.
    const from = code < next ? code : old;
    const n = length[from];
    if (o + n + 1 > size + 4096) throw new Error('tiff: LZW data longer than its block');
    let c = from;
    for (let k = n - 1; k >= 0; k--) {
      if (o + k < size) out[o + k] = suffix[c];
      c = prefix[c];
    }
    // c is past the first code of the string now; its first byte is what was written at o.
    let head = from;
    while (length[head] > 1) head = prefix[head];
    const first = suffix[head];
    if (code >= next && o + n < size) out[o + n] = first;
    o += code < next ? n : n + 1;
    if (next < 4096) {
      prefix[next] = old;
      suffix[next] = first;
      length[next] = length[old] + 1;
      next++;
    }
    if (next === (1 << width) - 1 && width < 12) width++;
    old = code;
  }
  return out;
}

/**
 * A raster of one band: { x0, y0, dx, dy, w, h, data }. Sample (i, j) stands at [x0 + i dx, y0 - j dy]
 * in the coordinates of the file (degrees, or the metres of its projection), row 0 at the top;
 * `data` is a Float32Array with NaN where the file has no value. With `window` ([xmin, ymin, xmax,
 * ymax] in the same coordinates) only that part is read, with a sample to spare on each side; the
 * result is null if the window misses the file.
 */
export function readRaster(buf, { window = null } = {}) {
  const tags = tiffTags(buf);
  const one = (tag, fallback) => (tags.has(tag) ? tags.get(tag)[0] : fallback);
  const [w, h] = [one(256), one(257)];
  const bits = one(258, 8);
  const compression = one(259, 1);
  const format = one(339, 1);
  const predictor = one(317, 1);
  if (one(277, 1) !== 1) throw new Error('tiff: only one band is read');
  if (![1, 5, 8, 32946].includes(compression)) throw new Error(`tiff: compression ${compression} is not read`);
  if (!(w > 0 && h > 0 && w * h <= 2 ** 31)) throw new Error('tiff: a broken size');
  const bytes = bits / 8;
  const scale = tags.get(33550);
  const tie = tags.get(33922);
  if (!scale || !tie) throw new Error('tiff: no georeference (pixel scale and tiepoint)');
  const read = format === 3 && bits === 32 ? (b, o) => b.readFloatLE(o) : format === 2 && bits === 16 ? (b, o) => b.readInt16LE(o) : format === 1 && bits === 16 ? (b, o) => b.readUInt16LE(o) : format === 1 && bits === 8 ? (b, o) => b[o] : null;
  if (!read) throw new Error(`tiff: sample format ${format} of ${bits} bits is not read`);
  const nodata = tags.has(42113) ? Number(tags.get(42113)) : null;
  // The tiepoint is the corner of a sample's cell; a centre lies half a cell in.
  const [left, top] = [tie[3] - tie[0] * scale[0], tie[4] + tie[1] * scale[1]];
  let [c0, r0, c1, r1] = [0, 0, w, h];
  if (window) {
    c0 = Math.max(0, Math.floor((window[0] - left) / scale[0]) - 1);
    c1 = Math.min(w, Math.ceil((window[2] - left) / scale[0]) + 1);
    r0 = Math.max(0, Math.floor((top - window[3]) / scale[1]) - 1);
    r1 = Math.min(h, Math.ceil((top - window[1]) / scale[1]) + 1);
    if (c0 >= c1 || r0 >= r1) return null;
  }
  const tiled = tags.has(322);
  const [bw, bh] = tiled ? [one(322), one(323)] : [w, one(278, h)];
  const offsets = tags.get(tiled ? 324 : 273);
  const counts = tags.get(tiled ? 325 : 279);
  const across = Math.ceil(w / bw);
  const [ow, oh] = [c1 - c0, r1 - r0];
  const data = new Float32Array(ow * oh).fill(NaN);
  for (let t = 0; t < offsets.length; t++) {
    const [tx, ty] = tiled ? [(t % across) * bw, Math.floor(t / across) * bh] : [0, t * bh];
    const rows = tiled ? bh : Math.min(bh, h - ty);
    if (tx >= c1 || tx + bw <= c0 || ty >= r1 || ty + rows <= r0) continue;
    // A block the file leaves out (no bytes) holds no value.
    if (counts[t] === 0) continue;
    if (offsets[t] + counts[t] > buf.length) throw new Error('tiff: a block lies outside the file');
    const raw = buf.subarray(offsets[t], offsets[t] + counts[t]);
    const size = bw * rows * bytes;
    const plain = compression === 1 ? Buffer.from(raw) : compression === 5 ? unLzw(raw, size) : inflateSync(raw, { maxOutputLength: size + 64 });
    if (plain.length < size) throw new Error('tiff: a block is shorter than its size');
    const block = unpredict(plain, predictor, bw, rows, bytes);
    for (let r = Math.max(0, r0 - ty); r < rows && ty + r < r1; r++) {
      for (let c = Math.max(0, c0 - tx); c < bw && tx + c < c1; c++) {
        const v = read(block, (r * bw + c) * bytes);
        data[(ty + r - r0) * ow + tx + c - c0] = v === nodata ? NaN : v;
      }
    }
  }
  return { x0: left + (c0 + 0.5) * scale[0], y0: top - (r0 + 0.5) * scale[1], dx: scale[0], dy: scale[1], w: ow, h: oh, data };
}
