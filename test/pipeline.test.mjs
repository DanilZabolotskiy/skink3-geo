// The parts of the pipeline that read files and trace grids: the TIFF and ZIP readers, the grids and
// their contours, the hills, the built-up outline, the epochs, and the spec a new city starts from.
// Every input is made here: nothing is downloaded and no cache is read.
//
//   node --test "test/*.test.*"

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { framesOf, requestsOf, run, scaffold, sourcesText, stringify } from '../build.mjs';
import { reduceTile, sampler, scaleOf, seaTile, waterShare } from '../lib/dem.mjs';
import { area, crosses, lengthOf, pointInRing, signedArea } from '../lib/geom.mjs';
import { builtShare, ghslTilesOf, ghslUrl, mollweide } from '../lib/ghsl.mjs';
import { buildBuiltUp, buildEpochs, buildRelief, buildTerrain, buildWall, growHills, terrainCell, terrainPlan } from '../lib/layers.mjs';
import { alive, yearOf } from '../lib/osm.mjs';
import { projection } from '../lib/project.mjs';
import { closeGaps, components, contours, fillHoles, fillPolygon, makeGrid } from '../lib/raster.mjs';
import { awmc, awmcName, licencesWith } from '../lib/sources.mjs';
import { readRaster, unLzw } from '../lib/tiff.mjs';
import { unzip, zipEntries } from '../lib/zip.mjs';

/** LZW as a TIFF holds it, written the plain way: a clear code, then every byte as its own code. */
function lzw(bytes) {
  const out = [];
  let [bits, held, next, width] = [0, 0, 258, 9];
  const put = (code) => {
    bits = (bits << width) | code;
    held += width;
    while (held >= 8) {
      out.push((bits >> (held - 8)) & 0xff);
      held -= 8;
    }
    bits &= (1 << held) - 1;
  };
  put(256);
  let first = true;
  for (const b of bytes) {
    put(b);
    // The reader adds an entry for every code after the first, and widens its codes a code early.
    if (!first) next++;
    first = false;
    if (next === (1 << width) - 1 && width < 12) width++;
    if (next >= 4094) {
      put(256);
      [next, width, first] = [258, 9, true];
    }
  }
  put(257);
  if (held > 0) out.push((bits << (8 - held)) & 0xff);
  return Buffer.from(out);
}

/** A georeferenced TIFF of one band: classic or BigTIFF, in tiles or one strip, packed as asked. */
function tiff({ w, h, bits, values, big = false, tile = 0, pack = 'none', nodata = null, left = 0, top = 0, scale = 1 }) {
  const bytes = bits / 8;
  const sample = (b, o, v) => (bits === 8 ? b.writeUInt8(v, o) : b.writeUInt16LE(v, o));
  const blocks = [];
  const [bw, bh] = tile ? [tile, tile] : [w, h];
  for (let ty = 0; ty < h; ty += bh) {
    for (let tx = 0; tx < w; tx += bw) {
      const b = Buffer.alloc(bw * bh * bytes);
      for (let r = 0; r < bh && ty + r < h; r++) for (let c = 0; c < bw && tx + c < w; c++) sample(b, (r * bw + c) * bytes, values[(ty + r) * w + tx + c]);
      blocks.push(pack === 'lzw' ? lzw(b) : pack === 'deflate' ? deflateSync(b) : b);
    }
  }
  const text = nodata === null ? null : Buffer.from(`${nodata}\0`, 'latin1');
  const doubles = (list) => {
    const b = Buffer.alloc(list.length * 8);
    list.forEach((v, k) => b.writeDoubleLE(v, k * 8));
    return b;
  };
  // [tag, type, count, value or data]
  const tags = [
    [256, 3, 1, w], [257, 3, 1, h], [258, 3, 1, bits], [259, 3, 1, pack === 'lzw' ? 5 : pack === 'deflate' ? 8 : 1], [277, 3, 1, 1],
    ...(tile ? [[322, 3, 1, tile], [323, 3, 1, tile], [324, 'offsets'], [325, 'counts']] : [[273, 'offsets'], [278, 3, 1, h], [279, 'counts']]),
    [339, 3, 1, 1], [33550, 12, 3, doubles([scale, scale, 0])], [33922, 12, 6, doubles([0, 0, 0, left, top, 0])],
    ...(text ? [[42113, 2, text.length, text]] : []),
  ].sort((a, b) => a[0] - b[0]);
  const [head, entry, word] = big ? [16, 20, 8] : [8, 12, 4];
  const dir = head + (big ? 8 : 2) + tags.length * entry + word;
  const put = (b, o, v) => (big ? b.writeBigUInt64LE(BigInt(v), o) : b.writeUInt32LE(v, o));
  // The data after the directory: the block offsets, the block sizes, the long values, then the blocks.
  const extra = [];
  let at = dir;
  const keep = (data) => {
    extra.push(data);
    at += data.length;
    return at - data.length;
  };
  const offsetsAt = keep(Buffer.alloc(blocks.length * word));
  const countsAt = keep(Buffer.alloc(blocks.length * word));
  const long = new Map();
  for (const t of tags) if (Buffer.isBuffer(t[3]) && t[3].length > word) long.set(t[0], keep(t[3]));
  const blockAt = blocks.map((b) => keep(b));
  blocks.forEach((b, k) => {
    put(extra[0], k * word, blockAt[k]);
    put(extra[1], k * word, b.length);
  });
  const out = Buffer.alloc(dir);
  out.write('II', 0, 'latin1');
  if (big) {
    out.writeUInt16LE(43, 2);
    out.writeUInt16LE(8, 4);
    out.writeBigUInt64LE(16n, 8);
    out.writeBigUInt64LE(BigInt(tags.length), 16);
  } else {
    out.writeUInt16LE(42, 2);
    out.writeUInt32LE(8, 4);
    out.writeUInt16LE(tags.length, 8);
  }
  tags.forEach((t, k) => {
    const e = head + (big ? 8 : 2) + k * entry;
    const field = e + (big ? 12 : 8);
    out.writeUInt16LE(t[0], e);
    if (t[1] === 'offsets' || t[1] === 'counts') {
      out.writeUInt16LE(big ? 16 : 4, e + 2);
      put(out, e + 4, blocks.length);
      // One block: its offset or size sits in the entry itself.
      if (blocks.length === 1) put(out, field, t[1] === 'offsets' ? blockAt[0] : blocks[0].length);
      else put(out, field, t[1] === 'offsets' ? offsetsAt : countsAt);
      return;
    }
    out.writeUInt16LE(t[1], e + 2);
    put(out, e + 4, t[2]);
    if (!Buffer.isBuffer(t[3])) out.writeUInt16LE(t[3], field);
    else if (long.has(t[0])) put(out, field, long.get(t[0]));
    else t[3].copy(out, field);
  });
  return Buffer.concat([out, ...extra]);
}

/** A ZIP archive of the files given, each deflated or stored. */
function zip(files) {
  const parts = [];
  const central = [];
  let at = 0;
  for (const { name, data, store = false } of files) {
    const packed = store ? data : deflateRawSync(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.write(name, 30, 'utf8');
    const entry = Buffer.alloc(46 + name.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(store ? 0 : 8, 10);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(at, 42);
    entry.write(name, 46, 'utf8');
    parts.push(local, packed);
    central.push(entry);
    at += local.length + packed.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.reduce((n, c) => n + c.length, 0), 12);
  end.writeUInt32LE(at, 16);
  return Buffer.concat([...parts, ...central, end]);
}

const circle = (cx, cy, r, n = 90) => Array.from({ length: n }, (_, k) => [cx + r * Math.cos((2 * Math.PI * k) / n), cy + r * Math.sin((2 * Math.PI * k) / n)]);

test('tiff: LZW comes back byte for byte, across the widening of its codes and a full table', () => {
  const bytes = Buffer.from(Array.from({ length: 9000 }, (_, k) => (k * 37 + (k >> 5)) & 0xff));
  assert.deepEqual(unLzw(lzw(bytes), bytes.length), bytes);
  assert.throws(() => unLzw(Buffer.from([0x80, 0x3f, 0xff, 0xff]), 16), /broken LZW/);
});

test('tiff: a classic strip and a BigTIFF in LZW tiles read the same, a window reads its part, and no value is NaN', () => {
  const [w, h] = [40, 30];
  const values = Array.from({ length: w * h }, (_, k) => (k % w) + 100 * Math.floor(k / w));
  values[5 * w + 7] = 65535;
  const plain = readRaster(tiff({ w, h, bits: 16, values, nodata: 65535, left: 1000, top: 5000, scale: 100 }));
  const tiled = readRaster(tiff({ w, h, bits: 16, values, nodata: 65535, left: 1000, top: 5000, scale: 100, big: true, tile: 16, pack: 'lzw' }));
  const packed = readRaster(tiff({ w, h, bits: 16, values, nodata: 65535, left: 1000, top: 5000, scale: 100, tile: 16, pack: 'deflate' }));
  for (const r of [plain, tiled, packed]) {
    assert.deepEqual([r.w, r.h, r.x0, r.y0, r.dx, r.dy], [40, 30, 1050, 4950, 100, 100]);
    assert.equal(r.data[3 * w + 4], 304);
    assert.ok(Number.isNaN(r.data[5 * w + 7]));
  }
  assert.deepEqual([...tiled.data], [...plain.data]);
  // The samples whose centres lie in x 2000..2400, y 3000..3300, and one more on each side.
  const part = readRaster(tiff({ w, h, bits: 16, values, left: 1000, top: 5000, scale: 100, big: true, tile: 16, pack: 'lzw' }), { window: [2000, 3000, 2400, 3300] });
  assert.deepEqual([part.w, part.h, part.x0, part.y0], [6, 5, 1950, 3350]);
  assert.equal(part.data[0], 9 + 100 * 16);
  assert.equal(part.data[part.data.length - 1], 14 + 100 * 20);
  assert.equal(readRaster(tiff({ w, h, bits: 8, values: values.map((v) => v & 0xff) }), { window: [500, 500, 600, 600] }), null);
  assert.throws(() => readRaster(Buffer.from('not a tiff at all')), /not a TIFF/);
});

test('zip: an entry comes out deflated or stored, by a pattern of its name', () => {
  const data = Buffer.from('the tile '.repeat(200));
  const archive = zip([{ name: 'notes.pdf', data: Buffer.from('a paper'), store: true }, { name: 'tile_R5_C20.tif', data }]);
  assert.deepEqual(zipEntries(archive).map((e) => [e.name, e.size]), [['notes.pdf', 7], ['tile_R5_C20.tif', 1800]]);
  assert.deepEqual(unzip(archive, /\.tif$/), data);
  assert.equal(unzip(archive, /\.pdf$/).toString(), 'a paper');
  assert.throws(() => unzip(archive, /\.exe$/), /no entry/);
  assert.throws(() => zipEntries(Buffer.alloc(64)), /not a ZIP/);
});

test('ghsl: the Mollweide plane, the tiles of a city, and the share built between four samples', () => {
  assert.deepEqual(mollweide([0, 0]), [0, 0]);
  assert.ok(Math.abs(mollweide([0, 90])[1] - Math.SQRT2 * 6378137) < 1);
  assert.ok(Math.abs(mollweide([180, 0])[0] - 2 * Math.SQRT2 * 6378137) < 1);
  // A box across the 42nd parallel straddles two rows of tiles; a small island lies in one tile.
  assert.deepEqual(ghslTilesOf([-8.9, 41.8, -8.4, 42.2]), [{ row: 4, col: 18 }, { row: 5, col: 18 }]);
  assert.deepEqual(ghslTilesOf([14.3, 35.8, 14.6, 36.0]), [{ row: 5, col: 20 }]);
  assert.match(ghslUrl(2020, 5, 20), /GHS_BUILT_S_E2020_GLOBE_R2023A_54009_100_V1_0_R5_C20\.zip$/);
  assert.throws(() => ghslUrl(2021, 5, 20), /no layer of 2021/);
  const [x, y] = mollweide([14.5, 35.9]);
  const raster = { x0: x - 50, y0: y + 50, dx: 100, dy: 100, w: 2, h: 2, data: Float32Array.from([10000, 0, NaN, 5000]) };
  assert.ok(Math.abs(builtShare([raster])([14.5, 35.9]) - 0.375) < 1e-6);
  assert.equal(builtShare([raster])([15.5, 35.9]), 0);
});

test('raster: a filled disc is traced as one counter-clockwise ring of its area; holes fill and gaps close', () => {
  const g = makeGrid([0, 0, 200, 200], 1);
  fillPolygon(g, [circle(100, 100, 60)], 1);
  const { rings } = contours(g, 0.5);
  assert.equal(rings.length, 1);
  assert.ok(signedArea(rings[0]) > 0);
  assert.ok(Math.abs(area(rings[0]) - Math.PI * 3600) / (Math.PI * 3600) < 0.02);
  // A ring with a hole: two outlines, the hole clockwise; filled, one.
  const holed = makeGrid([0, 0, 200, 200], 1);
  fillPolygon(holed, [circle(100, 100, 60), circle(100, 100, 20)], 1);
  assert.deepEqual(contours(holed, 0.5).rings.map((r) => Math.sign(signedArea(r))).sort(), [-1, 1]);
  assert.equal(contours(fillHoles(holed), 0.5).rings.length, 1);
  // Two blocks 6 apart are two pieces, and one once gaps of up to 8 are closed.
  const two = makeGrid([0, 0, 100, 40], 1);
  fillPolygon(two, [[[10, 10], [40, 10], [40, 30], [10, 30]]], 1);
  fillPolygon(two, [[[46, 10], [80, 10], [80, 30], [46, 30]]], 1);
  assert.equal(components(two).sizes.length - 1, 2);
  assert.equal(components(closeGaps(two, 4)).sizes.length - 1, 1);
});

test('hills: two summits part along the hollow between them, stop at their floor and reach, and at a limit', () => {
  const g = makeGrid([0, 0, 400, 200], 4);
  const bump = (x, y, cx, cy, top) => top * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * 50 ** 2));
  for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) g.data[j * g.w + i] = Math.max(bump(i * 4 + 2, j * 4 + 2, 120, 100, 60), bump(i * 4 + 2, j * 4 + 2, 280, 100, 40));
  const hills = [{ id: 'west', at: [120, 100], floor: 10, reach: 400 }, { id: 'east', at: [280, 100], floor: 10, reach: 400 }];
  const { labels, seeds } = growHills(g, hills);
  const at = (x, y) => labels[Math.floor(y / 4) * g.w + Math.floor(x / 4)];
  assert.deepEqual([at(120, 100), at(280, 100), at(4, 4)], [1, 2, 0]);
  // The hollow lies where the two bumps are as high as each other: nearer the lower summit.
  assert.deepEqual([at(190, 100), at(230, 100)], [1, 2]);
  assert.equal(g.data[seeds[0]] > 59, true);
  // A short reach keeps a hill near its summit; a limit keeps it out of what is not allowed.
  const near = growHills(g, [{ ...hills[0], reach: 30 }]).labels;
  assert.equal(near[Math.floor(100 / 4) * g.w + Math.floor(170 / 4)], 0);
  const allowed = Float32Array.from({ length: g.w * g.h }, (_, k) => ((k % g.w) * 4 < 150 ? 1 : 0));
  const kept = growHills(g, hills.slice(0, 1), allowed).labels;
  assert.ok(kept.every((l, k) => l === 0 || allowed[k] === 1));
  // A ridge given by its spine grows from the whole line.
  const ridge = growHills(g, [{ id: 'ridge', spine: [[100, 100], [140, 100]], floor: 10, reach: 20 }]).labels;
  assert.deepEqual([ridge[25 * g.w + 25], ridge[25 * g.w + 34], ridge[25 * g.w + 45]], [1, 1, 0]);
});

test('relief: contours at the heights asked for, or at a step; a hill is a stack of rings inside one another', () => {
  const proj = projection({ lon: 10, lat: 45 });
  const frame = { proj, reliefBox: [-1500, -1500, 1500, 1500] };
  const heightAt = ([lon, lat]) => {
    const [x, y] = proj.forward([lon, lat]);
    return 100 * Math.exp(-(x * x + y * y) / (2 * 500 ** 2));
  };
  const relief = buildRelief({ cell: 30, smooth: 30, contours: [25, 50], minLength: 100, hills: [{ id: 'top', name: 'Top', summit: [10, 45], floor: 20, reach: 2000 }] }, frame, heightAt);
  assert.deepEqual(relief.contours.map((c) => [c.height, c.rings.length]), [[25, 1], [50, 1]]);
  assert.ok(area(relief.contours[0].rings[0]) > area(relief.contours[1].rings[0]));
  const hill = relief.hills[0];
  assert.equal(hill.rings.length, 2);
  assert.ok(hill.rings[1].ring.every((p) => pointInRing(p, hill.rings[0].ring)));
  assert.ok(Math.hypot(...hill.centre) < 30);
  const stepped = buildRelief({ cell: 30, smooth: 30, contours: { step: 30 }, minLength: 100 }, frame, heightAt);
  assert.deepEqual(stepped.contours.map((c) => c.height), [30, 60, 90]);
});

test('dem: a tile is read by the scale, in blocks that are the mean of their samples; a water mask becomes a share of water', () => {
  const second = 1 / 3600;
  const tile = { lon0: 10, lat0: 45, dx: second, dy: second, w: 6, h: 4, data: Float32Array.from({ length: 24 }, (_, k) => k) };
  const half = reduceTile(tile, 2);
  assert.deepEqual([half.w, half.h, [...half.data]], [3, 2, [3.5, 5.5, 7.5, 15.5, 17.5, 19.5]]);
  // A sample of the reduced tile stands at the middle of its block.
  assert.ok(Math.abs(half.lon0 - (10 + second / 2)) < 1e-12 && Math.abs(half.lat0 - (45 - second / 2)) < 1e-12);
  assert.deepEqual([half.dx, half.dy], [2 * second, 2 * second]);
  // A block at the edge is narrower, and a sample with no height is left out of the mean.
  assert.deepEqual([...reduceTile(tile, 4).data], [10.5, 13.5]);
  const holed = reduceTile({ ...tile, data: Float32Array.from(tile.data, (v, k) => (k === 0 ? NaN : v)) }, 2);
  assert.ok(Math.abs(holed.data[0] - 14 / 3) < 1e-6);
  assert.ok(Number.isNaN(reduceTile({ ...tile, data: new Float32Array(24).fill(NaN) }, 2).data[0]));
  assert.equal(reduceTile(tile, 1), tile);
  assert.throws(() => reduceTile(tile, 1.5), /whole number/);
  // On a slope the reduced tile reads as the whole one does: the mean of a block is the height at its middle.
  const slope = { lon0: 10, lat0: 45, dx: second, dy: second, w: 8, h: 8, data: Float32Array.from({ length: 64 }, (_, k) => (k % 8) + 10 * Math.floor(k / 8)) };
  const place = [10 + 3.3 * second, 45 - 2.7 * second];
  assert.ok(Math.abs(sampler([slope])(place) - 30.3) < 1e-4 && Math.abs(sampler([reduceTile(slope, 2)])(place) - 30.3) < 1e-4);
  // Samples an arc-second apart are about 31 m apart: a grid as fine takes the tile whole, a coarser one reads it in blocks.
  assert.deepEqual(scaleOf(tile, 30), { factor: 1, samples: 1 });
  assert.deepEqual(scaleOf(tile, 120), { factor: 2, samples: 2 });
  assert.deepEqual(scaleOf(tile, 500), { factor: 8, samples: 2 });
  const mask = { ...tile, w: 2, h: 2, data: Uint8Array.of(0, 1, 2, 3) };
  assert.deepEqual([...waterShare(mask).data], [0, 1, 1, 1]);
  assert.deepEqual([...waterShare(mask, ['lake']).data], [0, 0, 1, 0]);
  assert.deepEqual([...reduceTile(waterShare(mask, ['ocean', 'lake']), 2).data], [0.5]);
  assert.deepEqual([...waterShare(seaTile(10, 45), ['ocean']).data], [1, 1, 1, 1]);
  assert.throws(() => waterShare(mask, ['pond']), /no water class "pond"/);
});

test('terrain: an island as its land, its ground in bands to paint in order, a pit, a lake, and a river cut at the coast', () => {
  const proj = projection({ lon: 10, lat: 45 });
  const frame = { proj, box: [-7000, -7000, 7000, 7000] };
  const at = (f) => (lonlat) => f(...proj.forward(lonlat));
  // An island 5 km in radius: a cone up to a rim of 300 m at 2 km from its middle, a crater down to 120 m inside
  // the rim, and a cliff of 150 m along the east coast. A lake in the crater, and a pond too small to keep.
  const heightAt = at((x, y) => {
    const r = Math.hypot(x, y);
    if (r >= 5000) return 0;
    const cone = r >= 2000 ? (300 * (5000 - r)) / 3000 : 120 + (180 * r) / 2000;
    return x > 3000 ? Math.max(cone, 150) : cone;
  });
  const seaAt = at((x, y) => (Math.hypot(x, y) >= 5000 ? 1 : 0));
  const lakeAt = at((x, y) => (Math.hypot(x, y) < 600 || Math.hypot(x + 3500, y) < 250 ? 1 : 0));
  const way = (id, name, points) => ({ type: 'way', id, tags: { waterway: 'river', name }, geometry: points.map((p) => proj.inverse(p)).map(([lon, lat]) => ({ lon, lat })) });
  // A river in two ways from the rim to a point far out at sea, and one the spec does not name.
  const osm = [way(1, 'Testwater', [[1000, 0], [2500, 300]]), way(2, 'Testwater', [[2500, 300], [4000, 0], [6500, 0]]), way(3, 'Otherwater', [[0, 3000], [0, 6000]])];
  const spec = { cell: 100, levels: [50, 100, 200], rivers: { list: ['Testwater'] } };
  const t = buildTerrain(spec, frame, { heightAt, seaAt, lakeAt, osm });
  assert.deepEqual(t.lost, []);
  assert.deepEqual([t.box, t.cell, t.levels], [frame.box, 100, [50, 100, 200]]);
  const radius = (ring) => Math.sqrt(area(ring) / Math.PI);
  // The land is one ring round the island; the sea is what it leaves.
  assert.equal(t.land.length, 1);
  const land = t.land[0].ring;
  assert.ok(Math.abs(radius(land) - 5000) < 50);
  // The bands come in the order to paint them: each ring lies inside the one before it.
  assert.deepEqual(t.bands.map((b) => [b.id, b.band, b.height, b.pit ?? false]), [['band-50-0', 1, 50, false], ['band-100-0', 2, 100, false], ['band-200-0', 3, 200, false], ['pit-200-0', 2, 200, true]]);
  for (const [k, b] of t.bands.entries()) {
    assert.ok(signedArea(b.ring) > 0 && !crosses(b.ring, true), b.id);
    assert.ok(b.ring.every((p) => Number.isInteger(p[0]) && Number.isInteger(p[1])), b.id);
    assert.ok(b.ring.every((p) => pointInRing(p, k > 0 ? t.bands[k - 1].ring : land)), b.id);
  }
  // On the west the cone is cut where it should be; the crater is a pit, painted as the band it goes down into.
  assert.ok(Math.abs(Math.min(...t.bands[0].ring.map((p) => p[0])) + 4500) < 60);
  assert.ok(Math.abs(radius(t.bands[2].ring) - 3000) < 60);
  assert.ok(Math.abs(radius(t.bands[3].ring) - 889) < 60);
  // No band comes nearer the sea than a cell, though the cliff on the east stands at the water.
  const toSegment = (p, a, b) => {
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const u = Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy);
  };
  const toCoast = (p) => land.reduce((best, a, i) => Math.min(best, toSegment(p, a, land[(i + 1) % land.length])), Infinity);
  assert.ok(Math.min(...t.bands[0].ring.map(toCoast)) >= 100);
  assert.ok(Math.max(...t.bands[0].ring.map((p) => p[0])) > 4700);
  // The lake in the crater is kept, and the pond is not.
  assert.equal(t.lakes.length, 1);
  assert.ok(Math.abs(radius(t.lakes[0].ring) - 600) < 40 && pointInRing([0, 0], t.lakes[0].ring));
  // The river is one line from its first point to the coast, and no further.
  assert.deepEqual(t.rivers.map((r) => [r.id, r.name, r.lines.length]), [['river-testwater', 'Testwater', 1]]);
  const line = t.rivers[0].lines[0];
  assert.deepEqual(line[0], [1000, 0]);
  assert.ok(Math.abs(line[line.length - 1][0] - 5000) <= 50 && Math.abs(lengthOf(line) - 4044) < 60);
  // The same inputs give the same layer; a spec with no levels gets those its ground reaches.
  assert.equal(JSON.stringify(buildTerrain(spec, frame, { heightAt, seaAt, lakeAt, osm })), JSON.stringify(t));
  const plain = buildTerrain({ cell: 100 }, frame, { heightAt, seaAt });
  assert.deepEqual([plain.levels, plain.lakes.length, plain.rivers.length], [[25, 50, 100, 200], 0, 0]);
  // The sea may come as polygons instead, an island a hole in one: the land is the same island.
  const circle = Array.from({ length: 48 }, (_, k) => proj.inverse([5000 * Math.cos((k / 24) * Math.PI), 5000 * Math.sin((k / 24) * Math.PI)]));
  const square = [[-9000, -9000], [9000, -9000], [9000, 9000], [-9000, 9000]].map(proj.inverse);
  const drawn = buildTerrain({ cell: 100, levels: [50] }, frame, { heightAt, seaRings: [[square, circle]] });
  assert.ok(drawn.land.length === 1 && Math.abs(radius(drawn.land[0].ring) - 5000) < 60 && drawn.bands.length === 1);
  // A lake the spec leaves out is named by a place on it, and a place with no lake is an error.
  assert.equal(buildTerrain({ ...spec, lakes: { skip: [[10, 45]] } }, frame, { heightAt, seaAt, lakeAt }).lakes.length, 0);
  assert.throws(() => buildTerrain({ ...spec, lakes: { skip: [proj.inverse([3000, 3000])] } }, frame, { heightAt, seaAt, lakeAt }), /no lake/);
  assert.throws(() => buildTerrain({ cell: 100, levels: [100, 50] }, frame, { heightAt, seaAt }), /each above the one before/);
  // The grid is laid out by the scale: about 800 cells from south to north, and tiles are read as far as the smoothing reaches.
  assert.deepEqual([terrainCell(frame.box), terrainCell([0, 0, 160000, 96000])], [30, 120]);
  assert.deepEqual(terrainPlan({ cell: 100 }, frame.box), { cell: 100, smooth: 200, waterCell: 50, reach: [-7800, -7800, 7800, 7800] });
});

test('built-up: the body round the centre is the outline, and what a strait parts from it comes as a piece', () => {
  const proj = projection({ lon: 10, lat: 45 });
  const frame = { proj, box: [-6000, -4000, 6000, 4000] };
  // A town 4 km square round the centre, a suburb across a strait 1.4 km wide, and a hamlet too small to keep.
  const shareAt = (lonlat) => {
    const [x, y] = proj.forward(lonlat);
    return (Math.abs(x) < 2000 && Math.abs(y) < 2000) || (x > 3400 && x < 5400 && Math.abs(y) < 1500) || Math.hypot(x + 4500, y - 2500) < 150 ? 0.6 : 0;
  };
  const { ring, pieces } = buildBuiltUp({ cell: 50, bridge: 200 }, frame, { shareAt });
  assert.ok(signedArea(ring) > 0 && !crosses(ring, true));
  assert.ok(Math.abs(area(ring) - 4000 ** 2) / 4000 ** 2 < 0.05);
  assert.equal(pieces.length, 1);
  assert.ok(pointInRing([4400, 0], pieces[0]) && !pointInRing([4400, 0], ring));
  // With the strait bridged, the two are one body.
  const joined = buildBuiltUp({ cell: 50, bridge: 800 }, frame, { shareAt });
  assert.ok(pointInRing([4400, 0], joined.ring) && joined.pieces.length === 0);
  assert.throws(() => buildBuiltUp({ cell: 50 }, frame, { shareAt: () => 0 }), /nothing built/);
});

test('walls and epochs: ways join into one circuit, and every epoch gets a ring of the same number of points', () => {
  const proj = projection({ lon: 10, lat: 45 });
  const frame = { proj };
  const corner = (x, y) => proj.inverse([x, y]);
  // Three ways of a square wall, the fourth side left open by 30 m: a gate.
  const ways = [
    { line: [corner(0, 0), corner(1000, 0), corner(1000, 1000)] },
    { line: [corner(0, 1000), corner(1000, 1000)] },
    { line: [corner(0, 1000), corner(0, 30)] },
  ];
  const { wall, notes } = buildWall({ id: 'old', name: 'Old Wall', built: 1200 }, frame, ways);
  assert.deepEqual([wall.lengthKm, wall.areaHa, wall.built], [4, 100, 1200]);
  assert.match(notes.join(' '), /closed across 30 m/);
  assert.throws(() => buildWall({ id: 'open', name: 'Open' }, frame, ways.slice(0, 2)), /do not close into a circuit/);
  const builtUp = [{ year: 2000, ring: circle(500, 500, 3000, 400) }, { year: 2020, ring: circle(500, 500, 5000, 400) }];
  const epochs = buildEpochs([
    { id: 'today', year: 2020, name: 'Today', outline: { builtUp: true } },
    { id: 'walled', year: 1200, name: 'Walled', outline: { wall: 'old' } },
    { id: 'grown', year: 2000, name: 'Grown', outline: { builtUp: 2000 } },
    { id: 'drawn', year: 1700, name: 'Drawn', outline: { points: [corner(-500, -500), corner(1500, -500), corner(1500, 1500), corner(-500, 1500)] } },
  ], frame, { walls: [wall], hills: [], builtUp, points: 64 });
  assert.deepEqual(epochs.map((e) => e.id), ['walled', 'drawn', 'grown', 'today']);
  assert.ok(epochs.every((e) => e.morph.length === 64 && signedArea(e.ring) > 0));
  assert.ok(epochs.every((e, k) => k === 0 || e.areaHa > epochs[k - 1].areaHa));
  // In step: no point of one epoch's ring travels far round the next one's.
  const turn = (a, b) => Math.abs(Math.atan2(a[1] - 500, a[0] - 500) - Math.atan2(b[1] - 500, b[0] - 500));
  assert.ok(epochs[2].morph.every((p, k) => Math.min(turn(p, epochs[3].morph[k]), 2 * Math.PI - turn(p, epochs[3].morph[k])) < 0.2));
  assert.throws(() => buildEpochs([{ id: 'x', year: 1990, name: 'X', outline: { builtUp: 1990 } }], frame, { walls: [], hills: [], builtUp }), /no built-up outline of 1990/);
});

test('osm: the years of a mapped thing, and whether it stands in a year', () => {
  assert.deepEqual([yearOf('1748'), yearOf('-0399'), yearOf('1975-05'), yearOf(undefined)], [1748, -399, 1975, null]);
  assert.equal(alive({ start_date: '0271', end_date: '1870' }, 1000), true);
  assert.equal(alive({ start_date: '0271', end_date: '1870' }, 1900), false);
  assert.equal(alive({ start_date: '0271' }), true);
  assert.equal(alive({ end_date: '1870' }), false);
});

test('build: a new city starts from its box and years, and the requests and the text of a spec are fixed', () => {
  const spec = scaffold({ city: 'testville', name: 'Testville', bbox: [10, 44.8, 10.6, 45.2], country: 'ITA', years: [1975, 2020] });
  assert.deepEqual(spec.centre, [10.3, 45]);
  assert.deepEqual(spec.region.bbox, [1, 40, 19, 51]);
  assert.deepEqual(spec.epochs.map((e) => [e.id, e.outline.builtUp]), [['y1975', 1975], ['y2020', 2020]]);
  assert.throws(() => scaffold({ city: 'x', name: 'X', bbox: [10, 45, 9, 46] }), /west,south,east,north/);
  assert.throws(() => scaffold({ city: 'x', name: 'X', bbox: [10, 45, 11, 46], years: [1066] }), /no built-up layer of 1066/);
  const frames = framesOf(spec);
  assert.deepEqual(Object.keys(frames.city.views), ['metro']);
  assert.ok(Math.abs(frames.city.box[0] + frames.city.box[2]) < 200);
  // Nothing of a scaffold asks OpenStreetMap or OpenHistoricalMap; a spec that does asks the same text every time.
  assert.deepEqual(requestsOf(spec, frames), {});
  const asking = { ...spec, water: { view: 'metro', from: ['ohm'], rivers: ['Po'] }, streets: { view: 'metro', from: 'ohm' } };
  const requests = requestsOf(asking, framesOf(asking));
  assert.deepEqual(Object.values(requests).map((r) => r.source), ['ohm', 'ohm']);
  assert.deepEqual(requestsOf(asking, framesOf(asking)), requests);
  assert.equal(stringify(spec), stringify(JSON.parse(stringify(spec))));
  assert.ok(stringify(spec).endsWith('}\n'));
  // With a wider box round the first, the city also gets a wide view and its terrain.
  const far = scaffold({ city: 'testville', name: 'Testville', bbox: [10, 44.8, 10.6, 45.2], wide: [9.4, 44.4, 11.2, 45.6] });
  assert.deepEqual([far.views, far.terrain], [{ metro: [10, 44.8, 10.6, 45.2], wide: [9.4, 44.4, 11.2, 45.6] }, { view: 'wide' }]);
  assert.deepEqual(Object.keys(framesOf(far).city.views), ['metro', 'wide']);
  assert.deepEqual(requestsOf(far, framesOf(far)), {});
  assert.throws(() => scaffold({ city: 'x', name: 'X', bbox: [10, 44.8, 10.6, 45.2], wide: [10.1, 44.4, 11.2, 45.6] }), /a box that holds --bbox/);
  // The rivers of a terrain are asked for by name alone, in the wide box, from the source the spec names.
  const rivered = { ...far, terrain: { view: 'wide', rivers: { from: 'ohm', list: ['Po', { id: 'old', name: 'Old Canal', match: '^(Old|Great) Canal$' }] } } };
  const asked = requestsOf(rivered, framesOf(rivered))['terrain-rivers'];
  assert.deepEqual([asked.source, asked.id], ['ohm', 'testville-ohm-terrain-rivers']);
  assert.equal(asked.query.match(/way\["waterway"~"\^\(river\|canal\)\$"\]/g).length, 4);
  assert.ok(asked.query.includes('["name"~"^Po$"]') && asked.query.includes('["name:en"~"^(Old|Great) Canal$"]') && asked.query.includes('(44.4,9.4,45.6,11.2)'));
  assert.equal(requestsOf({ ...rivered, terrain: { view: 'wide', rivers: { list: ['Po'] } } }, framesOf(rivered))['terrain-rivers'].source, 'osm');
  assert.throws(() => requestsOf({ ...rivered, terrain: { view: 'wide', rivers: { from: 'atlas', list: ['Po'] } } }, framesOf(rivered)), /"osm" or "ohm"/);
});

test('build: a project of its own names its command, its paragraphs and its sources in SOURCES.md', () => {
  const used = new Map([
    ['region', [{ source: 'natural-earth', what: 'land and countries' }]],
    ['city.epochs: old', [{ source: 'own', what: 'drawn by hand from the sources named below' }]],
  ]);
  const plain = sourcesText({ city: 'testville', name: 'Testville' }, [], used, []);
  assert.ok(plain.startsWith('# Testville: the sources of its map\n\nWritten by `build.mjs testville` from `cities/testville.json`.'));
  assert.ok(plain.includes('| `city.epochs: old` | Drawn by hand |'));
  const own = sourcesText({ city: 'testville', name: 'Testville' }, [], used, [], { command: 'tools/maps.mjs', paragraphs: ['Our own terms.'], licences: licencesWith({ own: { name: 'Drawn for this project' } }) });
  assert.ok(own.includes('Written by `tools/maps.mjs testville`'));
  assert.ok(own.includes('\n\nOur own terms.\n\n## Where each layer comes from\n'));
  assert.ok(own.includes('| `city.epochs: old` | Drawn for this project |'));
  // The table itself is not changed by a user's copy of it, and a source it lacks is refused.
  assert.equal(licencesWith().own.name, 'Drawn by hand');
  // A coast of the ancient world comes from a file of its repository, named by its path there, and is credited.
  assert.ok(licencesWith().awmc.required && licencesWith().awmc.licence === 'ODbL 1.0');
  assert.ok(licencesWith().copernicus.credit.includes('produced using Copernicus WorldDEM-30'));
  assert.equal(awmcName('Some Folder/OW_Inner_Sea.geojson'), 'ow-inner-sea');
  assert.throws(() => awmc({ cache: '.', file: '../OW_Inner_Sea.geojson', offline: true }), /bad file/);
  assert.throws(() => awmc({ cache: '.', file: 'Some Folder/OW_Inner_Sea.shp', offline: true }), /bad file/);

  assert.throws(() => licencesWith({ almanac: { name: 'An almanac' } }), /no source "almanac"/);
});

test('build: the command line keeps to its root, and never builds without a spec', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cities-'));
  const said = [];
  const error = console.error;
  console.error = (line) => said.push(String(line));
  try {
    mkdirSync(join(root, 'cities'));
    assert.equal(await run([], { root, command: 'tools/maps.mjs' }), 2);
    assert.ok(said[0].startsWith('usage: node tools/maps.mjs <city>'));
    assert.equal(await run(['testville', '--offline'], { root }), 2);
    assert.ok(said[1].includes('no spec') && said[1].endsWith('testville.json'));
    assert.equal(await run(['testville', '--new', '--name', 'Testville'], { root }), 2);
    assert.ok(said[2].includes('--new needs --name and --bbox'));
    assert.equal(existsSync(join(root, 'cities', 'testville.json')), false);
    assert.equal(existsSync(join(root, 'testville')), false);
  } finally {
    console.error = error;
    rmSync(root, { recursive: true, force: true });
  }
});
