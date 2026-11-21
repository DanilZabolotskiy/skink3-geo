// Reading an ESRI shapefile with Node alone: the polygons of its .shp and the attributes of its .dbf,
// as a GeoJSON feature collection. Only what a polygon layer needs is read: polygons (shape types 5,
// 15 and 25, their z and m left out), and character, number and logical fields. The bytes are read as
// data, never run.

import { pointInRing, signedArea } from './geom.mjs';

const POLYGON = new Set([5, 15, 25]);

/** The records of a .dbf (dBase III) table: one object a record, by field name; null for a deleted record. */
export function readDbf(buf) {
  const count = buf.readUInt32LE(4);
  const headerLength = buf.readUInt16LE(8);
  const recordLength = buf.readUInt16LE(10);
  const fields = [];
  for (let o = 32; o + 32 <= headerLength && buf[o] !== 0x0d; o += 32) {
    const raw = buf.subarray(o, o + 11);
    const end = raw.indexOf(0);
    fields.push({ name: raw.toString('latin1', 0, end < 0 ? 11 : end), type: String.fromCharCode(buf[o + 11]), length: buf[o + 16] });
  }
  const out = [];
  for (let k = 0; k < count; k++) {
    const at = headerLength + k * recordLength;
    if (at + recordLength > buf.length) throw new Error(`dbf: record ${k} runs past the end of the table`);
    if (buf[at] === 0x2a) {
      out.push(null);
      continue;
    }
    const record = {};
    let o = at + 1;
    for (const f of fields) {
      const text = buf.toString('latin1', o, o + f.length).trim();
      o += f.length;
      if (f.type === 'N' || f.type === 'F') record[f.name] = text === '' ? null : Number(text);
      else if (f.type === 'L') record[f.name] = /^[TtYy]$/.test(text) ? true : /^[FfNn]$/.test(text) ? false : null;
      else record[f.name] = text;
    }
    out.push(record);
  }
  return out;
}

/**
 * The polygons of a .shp as GeoJSON geometries, one a record (null for a record with no shape). A ring that runs
 * clockwise is an outer ring and one that runs counter-clockwise a hole, as the format has it; a hole goes to the
 * outer ring that holds it. Rings come closed, their first point repeated at the end, as GeoJSON writes them.
 */
export function readShp(buf) {
  if (buf.readInt32BE(0) !== 9994) throw new Error('shp: not a shapefile (no file code 9994)');
  const type = buf.readInt32LE(32);
  if (!POLYGON.has(type)) throw new Error(`shp: shape type ${type} is not a polygon (5, 15, 25)`);
  const fileLength = buf.readInt32BE(24) * 2;
  const out = [];
  for (let o = 100; o + 8 <= Math.min(fileLength, buf.length); ) {
    const length = buf.readInt32BE(o + 4) * 2;
    const c = o + 8;
    o = c + length;
    if (o > buf.length) throw new Error('shp: a record runs past the end of the file');
    const shape = buf.readInt32LE(c);
    if (shape === 0) {
      out.push(null);
      continue;
    }
    if (!POLYGON.has(shape)) throw new Error(`shp: a record of shape type ${shape} among polygons`);
    const parts = buf.readInt32LE(c + 36);
    const points = buf.readInt32LE(c + 40);
    const starts = [];
    for (let k = 0; k < parts; k++) starts.push(buf.readInt32LE(c + 44 + 4 * k));
    const at = c + 44 + 4 * parts;
    const rings = starts.map((s, k) => {
      const e = k + 1 < parts ? starts[k + 1] : points;
      const ring = [];
      for (let i = s; i < e; i++) ring.push([buf.readDoubleLE(at + 16 * i), buf.readDoubleLE(at + 16 * i + 8)]);
      return ring;
    });
    const outers = rings.filter((r) => signedArea(r) < 0).map((r) => [r]);
    for (const hole of rings.filter((r) => signedArea(r) >= 0)) {
      const home = outers.find((p) => pointInRing(hole[0], p[0])) ?? outers[0];
      if (home) home.push(hole);
    }
    out.push(outers.length === 1 ? { type: 'Polygon', coordinates: outers[0] } : { type: 'MultiPolygon', coordinates: outers });
  }
  return out;
}

/** A shapefile's .shp and .dbf as one GeoJSON feature collection. */
export function readShapefile(shp, dbf) {
  const shapes = readShp(shp);
  const records = dbf ? readDbf(dbf) : [];
  if (dbf && records.length !== shapes.length) throw new Error(`shapefile: ${shapes.length} shapes and ${records.length} records`);
  // A deleted record takes its shape with it.
  const features = shapes.map((geometry, k) => ({ type: 'Feature', properties: dbf ? records[k] : {}, geometry })).filter((f) => f.properties !== null);
  return { type: 'FeatureCollection', features };
}
