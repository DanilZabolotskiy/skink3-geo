// The sea floor of a world map and of a globe: netCDF classic files read with Node alone, bands of a value and groups
// of kinds, grids of classes traced along their cells and thinned together, on a map's plane and on the sphere cut
// into lunes; each made from grids made here, what each refuses, and that the commands ask for them. Nothing is
// downloaded and no cache is read.
//
//   node --test "test/*.test.*"

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { areasOnStage, fitView, globeFaults, worldFaults, type GlobeLayers, type WorldLayers } from '../map.ts';
import { area, signedArea } from '../lib/geom.mjs';
import { sphericalArea } from '../lib/globe.mjs';
import { readNetcdfHeader, readNetcdfVariable } from '../lib/netcdf.mjs';
import { bandIndex, bandsOf, buildGlobeBands, buildWorldAge, buildWorldSediments, cellOutlines, degreeGridOf, nearestAt, planeClasses, sedimentGroups, sphereClasses, type ClassGrid } from '../lib/seafloor.mjs';
import { creditOf, LICENCES, SEAFLOOR_AGE, SEAFLOOR_LITHOLOGY } from '../lib/sources.mjs';
import { worldFrame } from '../lib/world.mjs';
import { runGlobe } from '../globe.mjs';
import { runWorld } from '../world.mjs';

/** A netCDF classic file (CDF-1) of a grid over lon and lat, the south first, as GMT writes one: z as floats, or shorts with a fill value. */
function netcdf(lon: number[], lat: number[], z: number[], type: 'float' | 'short' = 'float', fill: number | null = null): Buffer {
  const parts: Buffer[] = [];
  const u32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v);
    parts.push(b);
  };
  const name = (s: string) => {
    u32(s.length);
    const b = Buffer.alloc(Math.ceil(s.length / 4) * 4);
    b.write(s, 'latin1');
    parts.push(b);
  };
  const t = type === 'float' ? 5 : 3;
  const size = type === 'float' ? 4 : 2;
  // The header, with the offsets of the values worked out once its length is known.
  const header = (begins: number[]): Buffer => {
    parts.length = 0;
    parts.push(Buffer.from('CDF\x01', 'latin1'));
    u32(0);
    u32(10);
    u32(2);
    name('lon');
    u32(lon.length);
    name('lat');
    u32(lat.length);
    u32(0);
    u32(0); // no global attributes
    u32(11);
    u32(3);
    const variable = (n: string, dims: number[], type: number, vsize: number, begin: number, attrs: [string, number, number][] = []) => {
      name(n);
      u32(dims.length);
      for (const d of dims) u32(d);
      if (attrs.length === 0) {
        u32(0);
        u32(0);
      } else {
        u32(12);
        u32(attrs.length);
        for (const [an, at, v] of attrs) {
          name(an);
          u32(at);
          u32(1);
          const b = Buffer.alloc(4);
          if (at === 3) b.writeInt16BE(v);
          else b.writeFloatBE(v);
          parts.push(b);
        }
      }
      u32(type);
      u32(vsize);
      u32(begin);
    };
    variable('lon', [0], 6, lon.length * 8, begins[0]!);
    variable('lat', [1], 6, lat.length * 8, begins[1]!);
    variable('z', [1, 0], t, Math.ceil((z.length * size) / 4) * 4, begins[2]!, fill === null ? [] : [['_FillValue', t, fill]]);
    return Buffer.concat(parts);
  };
  const length = header([0, 0, 0]).length;
  const begins = [length, length + lon.length * 8, length + lon.length * 8 + lat.length * 8];
  const head = header(begins);
  const values = Buffer.alloc(begins[2]! - length + Math.ceil((z.length * size) / 4) * 4);
  lon.forEach((v, i) => values.writeDoubleBE(v, i * 8));
  lat.forEach((v, i) => values.writeDoubleBE(v, lon.length * 8 + i * 8));
  z.forEach((v, i) => (type === 'float' ? values.writeFloatBE(v, begins[2]! - length + i * 4) : values.writeInt16BE(v, begins[2]! - length + i * 2)));
  return Buffer.concat([head, values]);
}

/** A grid of degrees round the whole Earth, every `step` degrees, of the value `f(lon, lat)`, as a classic netCDF file holds it. */
function earthFile(step: number, f: (lon: number, lat: number) => number, type: 'float' | 'short' = 'float', fill: number | null = null): Buffer {
  const lon = Array.from({ length: Math.round(360 / step) + 1 }, (_, i) => -180 + i * step);
  const lat = Array.from({ length: Math.round(180 / step) + 1 }, (_, j) => -90 + j * step);
  const z: number[] = [];
  for (const la of lat) for (const lo of lon) z.push(f(lo, la));
  return netcdf(lon, lat, z, type, fill);
}

test('netcdf: the header and the values of a classic file; what it refuses', () => {
  const bytes = netcdf([0, 1, 2], [10, 11], [1, 2, 3, -5, 5, 6], 'short', -5);
  const h = readNetcdfHeader(bytes);
  assert.deepEqual(h.dims, [{ name: 'lon', size: 3 }, { name: 'lat', size: 2 }]);
  assert.deepEqual(h.vars.map((v) => [v.name, v.type, v.dims]), [['lon', 'double', ['lon']], ['lat', 'double', ['lat']], ['z', 'short', ['lat', 'lon']]]);
  const z = readNetcdfVariable(bytes, 'z');
  assert.deepEqual(z.shape, [2, 3]);
  assert.deepEqual([...z.values].map((v) => (Number.isNaN(v) ? 'none' : v)), [1, 2, 3, 'none', 5, 6], 'the fill value reads as none');
  // A grid of the Earth reads north first, with the place of its first sample.
  const grid = degreeGridOf(bytes);
  assert.deepEqual([grid.cols, grid.rows, grid.west, grid.south, grid.cell], [3, 2, 0, 10, 1]);
  assert.deepEqual([...grid.values].slice(0, 3), [Number.NaN, 5, 6]);
  assert.equal(nearestAt(grid, 2.2, 10.9), 6);
  assert.throws(() => readNetcdfHeader(Buffer.from('\x89HDF\r\n\x1a\n', 'latin1')), /netCDF-4 \(HDF5\); only the classic format is read/);
  assert.throws(() => readNetcdfHeader(Buffer.from('PK\x03\x04', 'latin1')), /not a netCDF classic file/);
  assert.throws(() => readNetcdfVariable(bytes, 'age'), /no variable "age" \(the file has lon, lat, z\)/);
});

test('seafloor: bands of a value and groups of kinds; what they refuse', () => {
  assert.deepEqual(bandsOf('age', [20, 60]), [
    { id: 'age-0-20', from: 0, to: 20 },
    { id: 'age-20-60', from: 20, to: 60 },
    { id: 'age-60-more', from: 60, to: null },
  ]);
  assert.deepEqual([-1, 0, 19.9, 20, 59, 60, 900, Number.NaN].map((v) => bandIndex([20, 60], v)), [-1, 0, 0, 1, 1, 2, 2, -1]);
  assert.throws(() => bandsOf('age', [60, 20]), /numbers above 0, in order, each once/);
  assert.equal(sedimentGroups('all').length, 13);
  const groups = sedimentGroups('carbonate=5+9+13,clay=4,other=rest');
  assert.deepEqual(groups.map((g) => [g.id, g.codes]), [['carbonate', [5, 9, 13]], ['clay', [4]], ['other', [1, 2, 3, 6, 7, 8, 10, 11, 12]]]);
  assert.deepEqual(groups[0]!.names, ['Calcareous ooze', 'Mixed calcareous/siliceous ooze', 'Fine-grained calcareous sediment']);
  assert.throws(() => sedimentGroups('carbonate=5+99'), /has no code 99/);
  assert.throws(() => sedimentGroups('a=5,b=5'), /the code 5 is in two groups/);
  assert.throws(() => sedimentGroups('a=rest,b=rest'), /rest is given to one group/);
  assert.throws(() => sedimentGroups('Carbonate=5'), /in small letters/);
});

/** A grid of classes made here: rows from the south. */
function grid(rows: string[], cell = 1): ClassGrid {
  const r = rows.length;
  const c = rows[0]!.length;
  const classes = new Int32Array(r * c);
  rows.forEach((row, k) => [...row].forEach((ch, i) => (classes[(r - 1 - k) * c + i] = ch === '.' ? -1 : Number(ch))));
  return { x0: 0, y0: 0, cell, cols: c, rows: r, box: [0, 0, c * cell, r * cell], classes };
}

test('seafloor: classes traced along their cells: every cell once, holes, and cells that touch at a corner kept apart', () => {
  const g = grid([
    '00000',
    '01110',
    '01210',
    '01110',
    '0000.',
  ]);
  const out = cellOutlines(g);
  // Every class covers its cells exactly: its outer rings less its holes.
  const covered = (c: number) => (out.get(c) ?? []).reduce((s, r) => s + signedArea(r.points), 0);
  assert.equal(covered(0), 15);
  assert.equal(covered(1), 8);
  assert.equal(covered(2), 1);
  assert.deepEqual(out.get(1)!.map((r) => r.hole), [false, true], 'class 1 is a ring with a hole round class 2');
  // Two cells of one class that touch at a corner are two rings, and no ring passes a corner twice.
  const diagonal = cellOutlines(grid(['10', '01']));
  assert.equal(diagonal.get(1)!.length, 2);
  for (const rings of [...out.values(), ...diagonal.values()]) for (const r of rings) assert.equal(new Set(r.points.map((p) => p.join())).size, r.points.length);
});

test('seafloor: a world map\'s bands and kinds share their borders, cover what they hold, and keep to the format', () => {
  const { frame } = worldFrame({ bbox: [0, -20, 40, 20], centre: [20, 0] });
  // The age grows with the longitude; nothing east of 35°: crust that is not oceanic.
  const ages = degreeGridOf(earthFile(1, (lon) => (lon > 35 ? Number.NaN : Math.max(0, lon * 3))));
  const age = buildWorldAge(ages, frame, { levels: [20, 60], cell: 50000, tol: 75000 });
  assert.deepEqual(age.map((b) => b.id), ['age-0-20', 'age-20-60', 'age-60-more']);
  // Neighbouring bands share their border point for point: the points of a band's outline on its neighbour's.
  const pts = (rings: number[][][]) => new Set(rings.flat().map((p) => p.join()));
  const [young, middle] = [pts(age[0]!.rings), pts(age[1]!.rings)];
  assert.ok([...young].filter((p) => middle.has(p)).length >= 2, 'the youngest band and the next share their border');
  const kinds = degreeGridOf(earthFile(1, (lon, lat) => (lon > 35 ? -32768 : lat > 0 ? 5 : 4), 'short', -32768));
  const sediments = buildWorldSediments(kinds, frame, { groups: sedimentGroups('carbonate=5+9+13,other=rest'), cell: 50000, tol: 75000 });
  assert.deepEqual(sediments.map((g) => [g.id, g.codes.length]), [['carbonate', 3], ['other', 10]]);
  // The two groups cover the floor they hold once, with no gap and no overlap: the sum of their areas is the area of its cells.
  const cells = planeClasses(frame, 50000, (lon, lat) => (lon > 35 ? -1 : lat > 0 ? 0 : 1));
  const floor = [...cells.classes].filter((c) => c >= 0).length * 50000 ** 2;
  const sum = sediments.reduce((s, g) => s + g.rings.reduce((a, r) => a + area(r), 0) - g.holes.reduce((a, r) => a + area(r), 0), 0);
  assert.ok(Math.abs(sum - floor) / floor < 0.03, `${sum} ${floor}`);
  const world = { format: 'world-geo/1', id: 'test', name: 'Test', units: 'metres', made: { scale: 10, detail: 1000, minArea: 0, lakes: null }, frame, land: [], gaps: [], countries: [], boundaries: [], lakes: [], seafloorAge: age, sediments } as unknown as WorldLayers;
  assert.deepEqual(worldFaults(world), []);
  // On the stage: each keeps its fields, and its rings are cut to the view and thinned together again.
  const view = fitView(frame.box, { w: 1920, h: 1080 }, { mode: 'contain' });
  const staged = areasOnStage(view, sediments);
  assert.deepEqual(staged.map((g) => g.id), ['carbonate', 'other']);
  assert.ok(staged.every((g) => g.rings.length > 0 && g.rings.flat().every(([x, y]) => Math.abs(x) <= 960 + 120 && Math.abs(y) <= 540 + 120)));
});

test('seafloor: a globe\'s bands are polygons whole on the sphere, each in a lune, and cover what they hold', () => {
  // Bands of the distance from the equator: a belt round the Earth, two rings of middle latitudes, and two caps.
  const layers = buildGlobeBands('lat', (_lon, lat) => Math.abs(lat), { levels: [30, 60], cell: 1, tolerance: 0.08, minArea: 0, digits: 2 });
  assert.deepEqual(Object.keys(layers), ['lat-0-30', 'lat-30-60', 'lat-60-more']);
  // The belt is parted at the four meridians of the lunes, so no polygon is larger than a quarter of the sphere.
  assert.equal(layers['lat-0-30']!.length, 4);
  const globe = { format: 'globe-geo/1', body: 'earth', name: 'Test', radiusKm: 6371, units: '', made: { tolerance: 0.08, minArea: 0, digits: 2 }, layers } as unknown as GlobeLayers;
  assert.deepEqual(globeFaults(globe), []);
  const total = (k: string) => layers[k]!.reduce((s, p) => s + p.areaKm2, 0);
  const sphere = 4 * Math.PI * 6371 ** 2;
  // The belt of |lat| < 30 is half the sphere, each band of middle latitudes a third of a hemisphere... as the sines say.
  assert.ok(Math.abs(total('lat-0-30') / sphere - 0.5) < 0.01, `${total('lat-0-30') / sphere}`);
  assert.ok(Math.abs(total('lat-30-60') / sphere - (Math.sin(Math.PI / 3) - 0.5)) < 0.01);
  assert.ok(Math.abs(total('lat-60-more') / sphere - (1 - Math.sin(Math.PI / 3))) < 0.01);
  for (const list of Object.values(layers)) for (const p of list) assert.ok(sphericalArea(p.rings[0]!) > 0 && sphericalArea(p.rings[0]!) < Math.PI + 1e-6);
  // A grid of the sphere is of cells that divide 90 degrees.
  assert.throws(() => sphereClasses(0.7, () => 0), /degrees that divide 90/);
});

test('seafloor: the sources are in the table, with their credit; the commands ask for them and build nothing offline without the cache', async () => {
  assert.equal(LICENCES['earthbyte-age']!.licence, 'CC BY 4.0');
  assert.ok(LICENCES['earthbyte-age']!.required && LICENCES['earthbyte-lithology']!.required);
  assert.match(creditOf(LICENCES['earthbyte-age']!, 'earthbyte-age'), /Seton, M\., et al\. \(2020\).*CC BY 4\.0/);
  assert.match(LICENCES['earthbyte-lithology']!.credit, /Dutkiewicz.*CC BY 3\.0/);
  assert.match(SEAFLOOR_LITHOLOGY.url, new RegExp(SEAFLOOR_LITHOLOGY.commit));
  assert.match(SEAFLOOR_AGE.url, /age\.2020\.1\.GTS2012\.6m\.grd$/);
  const root = mkdtempSync(join(tmpdir(), 'seafloor-'));
  try {
    await assert.rejects(runWorld(['--root', root, '--seafloor-age', '40,20']), /run from the youngest up/);
    await assert.rejects(runWorld(['--root', root, '--sediments', 'x=99']), /has no code 99/);
    await assert.rejects(runWorld(['--root', root, '--seafloor-cell', '5000']), /give --seafloor-age or --sediments with it/);
    await assert.rejects(runGlobe(['--root', root, '--depths', '2000,200']), /run up, each once/);
    await assert.rejects(runGlobe(['--root', root, '--seafloor-cell', '0.7', '--depths', '200']), /degrees that divide 90/);
    await assert.rejects(runGlobe(['--root', root, '--body', 'moon', '--depths', '200']), /--depths is an option of the Earth/);
    await assert.rejects(runGlobe(['--root', root, '--depths', '200', '--offline']), /not in the cache/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
