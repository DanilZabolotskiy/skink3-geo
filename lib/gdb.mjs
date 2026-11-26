// Reading a table of an Esri file geodatabase (a directory `<name>.gdb`) with Node alone: its fields, its rows,
// and the polygons of its geometry field, as GeoJSON. The layout followed is the one the OpenFileGDB driver of GDAL
// documents: a `.gdbtablx` of row offsets beside each `.gdbtable` of rows. Only what a polygon layer needs is read:
// numbers, strings, dates and polygons (their z and m left out); a field of another kind is skipped over. The bytes
// are read as data, never run.

import { pointInRing, signedArea } from './geom.mjs';

const TYPES = { INT16: 0, INT32: 1, FLOAT32: 2, FLOAT64: 3, STRING: 4, DATETIME: 5, OBJECTID: 6, GEOMETRY: 7, BINARY: 8, RASTER: 9, GUID: 10, GLOBALID: 11, XML: 12, INT64: 13, DATE: 14, TIME: 15, DATETIME_OFFSET: 16 };

/** A cursor over a buffer, little-endian. */
function cursor(buf, at = 0) {
  let o = at;
  const need = (n) => {
    if (o + n > buf.length) throw new Error(`gdb: the table ends inside a value (at byte ${o}, ${n} more wanted)`);
  };
  return {
    get at() {
      return o;
    },
    skip(n) {
      need(n);
      o += n;
    },
    u8() {
      need(1);
      return buf[o++];
    },
    i16() {
      need(2);
      o += 2;
      return buf.readInt16LE(o - 2);
    },
    u16() {
      need(2);
      o += 2;
      return buf.readUInt16LE(o - 2);
    },
    i32() {
      need(4);
      o += 4;
      return buf.readInt32LE(o - 4);
    },
    u32() {
      need(4);
      o += 4;
      return buf.readUInt32LE(o - 4);
    },
    f32() {
      need(4);
      o += 4;
      return buf.readFloatLE(o - 4);
    },
    f64() {
      need(8);
      o += 8;
      return buf.readDoubleLE(o - 8);
    },
    i64() {
      need(8);
      o += 8;
      return Number(buf.readBigInt64LE(o - 8));
    },
    /** An unsigned integer of 7 bits a byte, the lowest first. */
    varuint() {
      let v = 0;
      let scale = 1;
      for (;;) {
        need(1);
        const b = buf[o++];
        v += (b & 0x7f) * scale;
        if ((b & 0x80) === 0) return v;
        scale *= 128;
        if (scale > 2 ** 63) throw new Error('gdb: a number too long');
      }
    },
    /** A signed integer: the first byte holds 6 bits and the sign, every other 7 bits. */
    varint() {
      need(1);
      let b = buf[o++];
      const negative = (b & 0x40) !== 0;
      let v = b & 0x3f;
      let scale = 64;
      while (b & 0x80) {
        need(1);
        b = buf[o++];
        v += (b & 0x7f) * scale;
        scale *= 128;
        if (scale > 2 ** 63) throw new Error('gdb: a number too long');
      }
      return negative ? -v : v;
    },
    utf16(chars) {
      need(chars * 2);
      o += chars * 2;
      return buf.toString('utf16le', o - chars * 2, o);
    },
    utf8(bytes) {
      need(bytes);
      o += bytes;
      return buf.toString('utf8', o - bytes, o);
    },
  };
}

/**
 * The fields of a `.gdbtable`: `{ geometry, fields }`. `geometry` is the kind of the layer (`point`, `multipoint`,
 * `polyline`, `polygon`, `multipatch`, or null) and `fields` lists each field with its `name`, `type` (a number of
 * the format), `nullable`, and for a geometry its frame: `{ wkt, x0, y0, scale, z, m }`.
 */
export function readGdbFields(table) {
  if (table.length < 40 || table.readInt32LE(0) !== 3) throw new Error('gdb: not a table of a file geodatabase (no version 3 header)');
  const at = Number(table.readBigUInt64LE(32));
  const c = cursor(table, at);
  c.u32();
  const version = c.u32();
  if (version !== 3 && version !== 4 && version !== 6) throw new Error(`gdb: a table of version ${version} is not read`);
  const flags = c.u32();
  const kind = { 0: null, 1: 'point', 2: 'multipoint', 3: 'polyline', 4: 'polygon', 9: 'multipatch' }[flags & 0xff] ?? null;
  const count = c.u16();
  const fields = [];
  for (let k = 0; k < count; k++) {
    const name = c.utf16(c.u8());
    c.utf16(c.u8());
    const type = c.u8();
    const field = { name, type, nullable: false };
    switch (type) {
      case TYPES.OBJECTID:
        c.u8();
        c.u8();
        break;
      case TYPES.INT16:
      case TYPES.INT32:
      case TYPES.FLOAT32:
      case TYPES.FLOAT64:
      case TYPES.DATETIME:
      case TYPES.INT64:
      case TYPES.DATE:
      case TYPES.TIME:
      case TYPES.DATETIME_OFFSET: {
        c.u8();
        field.nullable = (c.u8() & 1) !== 0;
        c.skip(c.u8());
        break;
      }
      case TYPES.STRING: {
        c.u32();
        field.nullable = (c.u8() & 1) !== 0;
        c.skip(c.varuint());
        break;
      }
      case TYPES.GEOMETRY: {
        c.u8();
        field.nullable = (c.u8() & 1) !== 0;
        const wkt = c.utf16(c.u16() / 2);
        const has = c.u8();
        const [m, z] = [(has & 2) !== 0, (has & 4) !== 0];
        const x0 = c.f64();
        const y0 = c.f64();
        const scale = c.f64();
        if (m) c.skip(16);
        if (z) c.skip(16);
        c.f64();
        if (m) c.f64();
        if (z) c.f64();
        c.skip(32);
        // The sizes of the spatial index's grid follow, as many as a byte of 0 and a count say.
        for (;;) {
          const b = c.u8();
          if (b === 0) {
            const n = c.u32();
            if (n < 1 || n > 3) throw new Error(`gdb: ${n} grid sizes in the geometry field "${name}"`);
            c.skip(8 * n);
            break;
          }
          // A field with z or m holds their extent first: what is not 0 here is the first byte of a double.
          c.skip(7);
        }
        Object.assign(field, { wkt, x0, y0, scale, z, m });
        break;
      }
      case TYPES.BINARY:
      case TYPES.XML:
        c.u8();
        field.nullable = (c.u8() & 1) !== 0;
        break;
      case TYPES.GUID:
      case TYPES.GLOBALID:
        c.u8();
        field.nullable = (c.u8() & 1) !== 0;
        break;
      case TYPES.RASTER:
        throw new Error(`gdb: the raster field "${name}" is not read`);
      default:
        throw new Error(`gdb: the field "${name}" is of type ${type}, which is not read`);
    }
    fields.push(field);
  }
  return { geometry: kind, fields };
}

/** The byte offsets of the rows of a table, from its `.gdbtablx`: 0 for a row that was deleted. */
export function readGdbOffsets(tablx) {
  if (tablx.length < 16 || tablx.readInt32LE(0) !== 3) throw new Error('gdb: not the row index of a file geodatabase (no version 3 header)');
  const blocks = tablx.readInt32LE(4);
  const rows = tablx.readInt32LE(8);
  const size = tablx.readInt32LE(12);
  if (size < 4 || size > 6) throw new Error(`gdb: offsets of ${size} bytes`);
  const end = 16 + blocks * 1024 * size;
  if (end + 16 > tablx.length) throw new Error('gdb: the row index is cut short');
  // A sparse index lists which of its blocks are there in a bitmap after them; a dense one has none.
  const words = tablx.readInt32LE(end);
  const present = [];
  if (words === 0) for (let b = 0; b < blocks; b++) present.push(b);
  else {
    const total = tablx.readInt32LE(end + 4);
    for (let b = 0; b < total; b++) if (tablx[end + 16 + (b >> 3)] & (1 << (b & 7))) present.push(b);
    if (present.length !== blocks) throw new Error('gdb: the row index lists another number of blocks than it holds');
  }
  const out = new Array(Math.max(rows, 0)).fill(0);
  present.forEach((block, k) => {
    for (let i = 0; i < 1024; i++) {
      const row = block * 1024 + i;
      if (row >= out.length) break;
      out[row] = tablx.readUIntLE(16 + (k * 1024 + i) * size, size);
    }
  });
  return out;
}

const SHAPES = { point: new Set([1, 9, 11, 21, 52]), line: new Set([3, 10, 13, 23, 50]), polygon: new Set([5, 15, 19, 25, 51]) };

/**
 * The polygon of a geometry blob as GeoJSON, in the units of the field's frame; null for an empty one. A ring that
 * runs clockwise is an outer ring and one that runs counter-clockwise a hole, as the format has it; a hole goes to the
 * outer ring that holds it. Rings come closed, their first point repeated at the end.
 */
export function readGdbPolygon(blob, field) {
  const c = cursor(blob);
  const type = c.varuint();
  const base = type & 0xff;
  if (!SHAPES.polygon.has(base)) throw new Error(`gdb: a geometry of shape type ${base} is not a polygon`);
  const curves = base === 51 && (type & 0x20000000) !== 0;
  const n = c.varuint();
  if (n === 0) return null;
  const parts = c.varuint();
  if (curves) c.varuint();
  for (let k = 0; k < 4; k++) c.varuint();
  const sizes = [];
  let left = n;
  for (let k = 0; k < parts - 1; k++) {
    const s = c.varuint();
    sizes.push(s);
    left -= s;
  }
  sizes.push(left);
  if (left < 0) throw new Error('gdb: the parts of a polygon hold more points than it has');
  let [x, y] = [0, 0];
  const rings = sizes.map((count) => {
    const ring = [];
    for (let k = 0; k < count; k++) {
      x += c.varint();
      y += c.varint();
      ring.push([x / field.scale + field.x0, y / field.scale + field.y0]);
    }
    return ring;
  });
  if (curves) throw new Error('gdb: a polygon with curves is not read');
  const outers = [];
  const holes = [];
  for (const ring of rings) {
    if (ring.length < 4) continue;
    const open = ring.slice(0, -1);
    (signedArea(open) < 0 ? outers : holes).push(ring);
  }
  const polys = outers.map((r) => [r]);
  for (const hole of holes) {
    const owner = polys.find((p) => pointInRing(hole[0], p[0].slice(0, -1)));
    if (owner) owner.push(hole);
    else polys.push([hole.slice().reverse()]);
  }
  if (polys.length === 0) return null;
  return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
}

/**
 * The rows of a table as a GeoJSON feature collection: the properties by field name (the object id as `OBJECTID`,
 * whatever its field is called; a date as days since 1899-12-30), and the polygon of the geometry field, or null.
 * `want(properties)` may leave a row out before its geometry is read: a large table is then read in a fraction of the
 * time. A table without a geometry field gives features with no geometry.
 */
export function readGdbTable(table, tablx, { want = null } = {}) {
  const { fields } = readGdbFields(table);
  const offsets = readGdbOffsets(tablx);
  const nullable = fields.filter((f) => f.nullable).length;
  const features = [];
  offsets.forEach((at, row) => {
    if (at === 0) return;
    const c = cursor(table, at);
    const size = c.u32();
    const end = c.at + size;
    const flags = [];
    for (let k = 0; k < Math.ceil(nullable / 8); k++) flags.push(c.u8());
    let bit = 0;
    const properties = {};
    let blob = null;
    let geometryField = null;
    for (const f of fields) {
      if (f.type === TYPES.OBJECTID) {
        properties.OBJECTID = row + 1;
        continue;
      }
      if (f.nullable) {
        const isNull = (flags[bit >> 3] & (1 << (bit & 7))) !== 0;
        bit++;
        if (isNull) {
          if (f.type !== TYPES.GEOMETRY) properties[f.name] = null;
          continue;
        }
      }
      switch (f.type) {
        case TYPES.INT16:
          properties[f.name] = c.i16();
          break;
        case TYPES.INT32:
          properties[f.name] = c.i32();
          break;
        case TYPES.FLOAT32:
          properties[f.name] = c.f32();
          break;
        case TYPES.FLOAT64:
        case TYPES.DATETIME:
        case TYPES.DATE:
        case TYPES.TIME:
          properties[f.name] = c.f64();
          break;
        case TYPES.DATETIME_OFFSET:
          properties[f.name] = c.f64();
          c.i16();
          break;
        case TYPES.INT64:
          properties[f.name] = c.i64();
          break;
        case TYPES.STRING:
        case TYPES.XML:
          properties[f.name] = c.utf8(c.varuint());
          break;
        case TYPES.GEOMETRY: {
          const length = c.varuint();
          blob = table.subarray(c.at, c.at + length);
          geometryField = f;
          c.skip(length);
          break;
        }
        case TYPES.BINARY:
          c.skip(c.varuint());
          break;
        case TYPES.GUID:
        case TYPES.GLOBALID:
          c.skip(16);
          break;
      }
    }
    if (c.at > end) throw new Error(`gdb: row ${row + 1} runs past its own size`);
    if (want && !want(properties)) return;
    features.push({ type: 'Feature', properties, geometry: blob && geometryField ? readGdbPolygon(blob, geometryField) : null });
  });
  return { type: 'FeatureCollection', features };
}

/**
 * The tables of a file geodatabase by name, from its catalog (`a00000001.gdbtable` and its `.gdbtablx`): each name
 * with the stem of its files (`baseline_annual` → `a00000009`).
 */
export function readGdbCatalog(table, tablx) {
  return readGdbTable(table, tablx).features.map((f) => ({ name: String(f.properties.Name), file: `a${f.properties.OBJECTID.toString(16).padStart(8, '0')}` }));
}
