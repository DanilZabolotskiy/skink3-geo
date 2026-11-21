// A round body for a globe: the example Earth and Moon as they are committed, and the parts of their build:
// rings made whole on the sphere, measured and oriented there, thinned there, a shapefile read, and the layers
// from collections made here. Nothing is downloaded and no cache is read.
//
//   node --test "test/*.test.*"

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { globeFaults, loadGlobe, type GlobeLayers } from '../map.ts';
import { areaKm2, BODIES, buildEarth, buildMoon, earthSources, orientOnSphere, simplifyOnSphere, sphericalArea, wholeRing } from '../lib/globe.mjs';
import { readShapefile } from '../lib/shapefile.mjs';
import { globeText, runGlobe } from '../globe.mjs';

const here = (path: string): URL => new URL(`../examples/${path}`, import.meta.url);
type LL = [number, number];

const lockOf = (body: string) => JSON.parse(readFileSync(here(`${body}/sources.lock.json`), 'utf8')) as { downloads: { id: string; source: string; sha256: string; request: string }[] };

test('globe: the example Earth has its layers, its sources and its lock, and keeps to the format', () => {
  const g = loadGlobe(here('earth/globe.json'));
  assert.deepEqual(globeFaults(g), []);
  assert.equal(g.body, 'earth');
  assert.equal(g.made.scale, 110);
  const { land, lakes, ice } = g.layers;
  assert.ok(land!.length > 100 && lakes!.length > 10 && ice!.length > 10 && g.places!.length > 1000);
  // The largest land is Afro-Eurasia, then the Americas, then Antarctica: about 84, 38 and 12 million km² of the true Earth.
  const big = land!.slice(0, 3).map((p) => p.areaKm2 / 1e6);
  assert.ok(big[0]! > 75 && big[0]! < 92, `Afro-Eurasia ${big[0]}`);
  assert.ok(big[2]! > 10 && big[2]! < 15, `the third ${big[2]}`);
  // Antarctica is whole round its pole: no point on the pole, and its ring runs counter-clockwise seen from outside.
  const south = land!.find((p) => p.rings[0]!.every(([, lat]) => lat < -60))!;
  assert.ok(south && Math.abs(sphericalArea(south.rings[0]!)) * 6371 ** 2 > 1e7);
  assert.ok(south.rings[0]!.every(([, lat]) => lat > -89.99));
  // The largest towns come first.
  assert.ok(g.places![0]!.pop > 2e7 && g.places!.every((p) => p.pop >= g.made.minPop!));
  assert.match(readFileSync(here('earth/SOURCES.md'), 'utf8'), /Made with Natural Earth\./);
  const lock = lockOf('earth');
  assert.deepEqual(lock.downloads.map((d) => d.id).sort(), ['ne_10m_populated_places_simple', 'ne_110m_glaciated_areas', 'ne_110m_lakes', 'ne_110m_land', 'ne_50m_antarctic_ice_shelves_polys']);
  for (const d of lock.downloads) {
    assert.match(d.sha256, /^[0-9a-f]{64}$/, d.id);
    assert.doesNotMatch(d.request, /\\|Users\/|[?&](key|token|api_key)=/i, d.id);
  }
});

test('globe: the example Moon has its dark seas where they are, the near side holding most of them', () => {
  const g = loadGlobe(here('moon/globe.json'));
  assert.deepEqual(globeFaults(g), []);
  assert.equal(g.body, 'moon');
  assert.equal(g.radiusKm, BODIES.moon.radiusKm);
  assert.deepEqual(Object.keys(g.layers), ['maria']);
  assert.equal(g.places, undefined);
  const maria = g.layers.maria!;
  assert.ok(maria.length > 200, `${maria.length} maria`);
  // The largest is the Ocean of Storms, as the mapping cuts it from its neighbours, then the Sea of Rains.
  assert.equal(maria[0]!.name, 'Oceanus Procellarum');
  assert.ok(maria[0]!.areaKm2 > 1.5e6 && maria[0]!.areaKm2 < 2.5e6, `${maria[0]!.areaKm2}`);
  assert.equal(maria[1]!.name, 'Mare Imbrium');
  // The maria cover about a sixth of the Moon, and nearly all of them lie on the side that faces the Earth.
  const R = g.radiusKm;
  let all = 0;
  let near = 0;
  for (const p of maria) {
    const a = p.rings.reduce((s, r) => s + sphericalArea(r), 0) * R * R;
    all += a;
    if (Math.abs(p.rings[0]![0]![0]) < 90) near += a;
  }
  const share = all / (4 * Math.PI * R * R);
  assert.ok(share > 0.14 && share < 0.19, `the maria cover ${share}`);
  assert.ok(near / all > 0.85, `the near side holds ${near / all}`);
  assert.match(readFileSync(here('moon/SOURCES.md'), 'utf8'), /LROC Global Mare Boundaries \(Nelson et al\. 2014\)/);
  const lock = lockOf('moon');
  assert.deepEqual(lock.downloads.map((d) => [d.id, d.source]), [['lroc-global-mare-180', 'lroc']]);
  assert.match(lock.downloads[0]!.sha256, /^[0-9a-f]{64}$/);
});

test('globe: a ring is measured and oriented on the sphere, a ring round a pole as well as any', () => {
  // A degree square on the equator is about 12 364 km²; counter-clockwise seen from outside means east, north, west, south.
  const square: LL[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  assert.ok(Math.abs(areaKm2(square) - 12364) < 15, `${areaKm2(square)}`);
  assert.ok(Math.abs(areaKm2(square, BODIES.moon.radiusKm) - 12364 * (1737.4 / 6371.0088) ** 2) < 2, 'on the Moon, by its radius');
  assert.ok(sphericalArea(square) > 0 && sphericalArea([...square].reverse()) < 0);
  assert.deepEqual(orientOnSphere([...square].reverse()), square);
  // A ring round the south pole at 60° S, going west: the cap holds 2π(1 - sin 60°) steradians.
  const cap: LL[] = Array.from({ length: 36 }, (_, k) => [180 - k * 10, -60] as LL);
  assert.ok(Math.abs(sphericalArea(cap) - 2 * Math.PI * (1 - Math.sin(Math.PI / 3))) < 0.01, `${sphericalArea(cap)}`);
});

test('globe: a ring is made whole: the cut of a flat map along the pole and down the 180th meridian goes', () => {
  // Natural Earth's Antarctica: down the meridian from the coast, along the pole, and up again on its other side.
  const ring: LL[] = [[170, -70], [180, -75], [180, -85], [180, -90], [-180, -90], [-180, -85], [-180, -75], [-170, -71], [0, -68], [170, -70]];
  assert.deepEqual(wholeRing(ring), [[170, -70], [180, -75], [-170, -71], [0, -68]]);
  // A half slit that turns back short of where it went down is gone too, and a short edge along the meridian stays.
  assert.deepEqual(wholeRing([[-170, -80], [-180, -84], [180, -89], [180, -85], [170, -82], [0, -70]]), [[-170, -80], [-180, -84], [180, -85], [170, -82], [0, -70]]);
  // A ring of two places is no ring.
  assert.equal(wholeRing([[0, 0], [1, 1], [0, 0]]), null);
});

test('globe: a ring is thinned on the sphere: it keeps its own points, and is thinned by a pole as by the equator', () => {
  const coast: LL[] = [];
  for (let k = 0; k <= 200; k++) coast.push([-60 + k * 0.6, 10 + Math.sin(k / 6) * 3 + (k % 2) * 0.01]);
  coast.push([60, 0], [-60, 0]);
  const thin = simplifyOnSphere(coast, 0.1)!;
  assert.ok(thin.length < coast.length / 2 && thin.length > 20, `${thin.length} of ${coast.length}`);
  for (const p of thin) assert.ok(coast.includes(p), 'a point kept is one of the ring');
  // The same zigzag laid round a pole is thinned to about as many points: degrees of arc, not of longitude.
  const polar: LL[] = coast.map(([lon, lat]) => [lon, lat - 80] as LL);
  const t = simplifyOnSphere(polar, 0.1)!;
  assert.ok(t.length <= thin.length * 1.5, `${t.length} by the pole, ${thin.length} by the equator`);
  // A neck so narrow the thinning cannot keep it open is thinned all the same, never kept at full detail.
  // Here a winding channel a hundredth of a degree wide is cut into a block of land.
  const neck: LL[] = [[0, 0], [4, 0], [4, 2]];
  for (let k = 0; k <= 300; k++) neck.push([2.005 + 0.3 * Math.sin(k / 10), 2 - k * 0.005]);
  for (let k = 300; k >= 0; k--) neck.push([1.995 + 0.3 * Math.sin(k / 10), 2 - k * 0.005]);
  neck.push([0, 2]);
  const n = simplifyOnSphere(neck, 0.1)!.length;
  assert.ok(n < 40, `${n} of ${neck.length}`);
});

/** A shapefile of polygons made here: its .shp and its .dbf, records of [rings, name, deleted]. */
function shapefile(records: readonly [LL[][] | null, string, boolean][]): { shp: Buffer; dbf: Buffer } {
  const bodies = records.map(([rings]) => {
    if (!rings) {
      const b = Buffer.alloc(4);
      b.writeInt32LE(0, 0);
      return b;
    }
    const n = rings.reduce((s, r) => s + r.length, 0);
    const b = Buffer.alloc(44 + 4 * rings.length + 16 * n);
    b.writeInt32LE(5, 0);
    b.writeInt32LE(rings.length, 36);
    b.writeInt32LE(n, 40);
    let i = 0;
    rings.forEach((r, k) => {
      b.writeInt32LE(i, 44 + 4 * k);
      for (const [x, y] of r) {
        b.writeDoubleLE(x, 44 + 4 * rings.length + 16 * i);
        b.writeDoubleLE(y, 44 + 4 * rings.length + 16 * i + 8);
        i++;
      }
    });
    return b;
  });
  const parts = [Buffer.alloc(100)];
  bodies.forEach((b, k) => {
    const h = Buffer.alloc(8);
    h.writeInt32BE(k + 1, 0);
    h.writeInt32BE(b.length / 2, 4);
    parts.push(h, b);
  });
  const shp = Buffer.concat(parts);
  shp.writeInt32BE(9994, 0);
  shp.writeInt32BE(shp.length / 2, 24);
  shp.writeInt32LE(1000, 28);
  shp.writeInt32LE(5, 32);
  const fields = [['MARE_NAME', 'C', 20], ['Area_km', 'N', 8]] as const;
  const head = Buffer.alloc(32 + 32 * fields.length + 1);
  const recordLength = 1 + fields.reduce((s, f) => s + f[2], 0);
  head[0] = 3;
  head.writeUInt32LE(records.length, 4);
  head.writeUInt16LE(head.length, 8);
  head.writeUInt16LE(recordLength, 10);
  fields.forEach(([name, type, length], k) => {
    head.write(name, 32 + 32 * k, 'latin1');
    head[32 + 32 * k + 11] = type.charCodeAt(0);
    head[32 + 32 * k + 16] = length;
  });
  head[head.length - 1] = 0x0d;
  const rows = records.map(([, name, deleted]) => Buffer.from(`${deleted ? '*' : ' '}${name.padEnd(20)}${'12'.padStart(8)}`, 'latin1'));
  return { shp, dbf: Buffer.concat([head, ...rows, Buffer.from([0x1a])]) };
}

test('globe: a shapefile is read: its polygons with their holes, its fields, a deleted record left out', () => {
  // As the format writes them, an outer ring runs clockwise on the plane of lon and lat, and a hole counter-clockwise.
  const outer: LL[] = [[0, 0], [0, 4], [4, 4], [4, 0], [0, 0]];
  const hole: LL[] = [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]];
  const other: LL[] = [[10, 0], [10, 1], [11, 1], [11, 0], [10, 0]];
  const { shp, dbf } = shapefile([[[outer, hole], 'Mare A', false], [null, 'No shape', false], [[other], 'Gone', true], [[outer, other], 'Two parts', false]]);
  const fc = readShapefile(shp, dbf);
  assert.deepEqual(fc.features.map((f) => f.properties), [{ MARE_NAME: 'Mare A', Area_km: 12 }, { MARE_NAME: 'No shape', Area_km: 12 }, { MARE_NAME: 'Two parts', Area_km: 12 }]);
  assert.deepEqual(fc.features[0]!.geometry, { type: 'Polygon', coordinates: [outer, hole] });
  assert.equal(fc.features[1]!.geometry, null);
  assert.deepEqual(fc.features[2]!.geometry, { type: 'MultiPolygon', coordinates: [[outer], [other]] });
  // A file that is not a shapefile, and one of lines, are refused.
  assert.throws(() => readShapefile(Buffer.alloc(100), null), /not a shapefile/);
  const lines = Buffer.from(shp);
  lines.writeInt32LE(3, 32);
  assert.throws(() => readShapefile(lines, null), /shape type 3 is not a polygon/);
  // And the Moon is built from what it reads: its maria named by their field, oriented on the sphere.
  const moon = buildMoon({ maria: fc }, { minArea: 100 });
  assert.deepEqual(moon.layers.maria.map((p) => [p.id, p.name]), [['mare-0', 'Mare A'], ['mare-1', 'Two parts'], ['mare-2', 'Two parts']]);
  const [o, h] = moon.layers.maria[0]!.rings;
  assert.ok(sphericalArea(o!) > 0 && sphericalArea(h!) < 0, 'outer counter-clockwise, hole clockwise');
  assert.ok(Math.abs(moon.layers.maria[0]!.areaKm2 - 16 * 12364 * (1737.4 / 6371.0088) ** 2) / moon.layers.maria[0]!.areaKm2 < 0.01, 'the area is of the Moon');
});

test('globe: the Earth from collections: whole, thinned, oriented, the small left out, the towns by their people', () => {
  const poly = (rings: LL[][], properties: Record<string, unknown> = {}) => ({ type: 'Feature', properties, geometry: { type: 'Polygon', coordinates: rings.map((r) => [...r, r[0]!]) } });
  // Clockwise as Natural Earth writes them: an island of 4 degrees with a lake hole, a rock too small to keep.
  const island: LL[] = [[0, 0], [0, 4], [4, 4], [4, 0]];
  const hole: LL[] = [[1, 1], [3, 1], [3, 3], [1, 3]];
  const rock: LL[] = [[10, 10], [10, 10.05], [10.05, 10.05], [10.05, 10]];
  const land = { features: [poly([island, hole]), poly([rock])] };
  const places = { features: [{ properties: { name: 'Small', pop_max: 1000 }, geometry: { type: 'Point', coordinates: [1, 1] } }, { properties: { name: 'B', pop_max: 5e5 }, geometry: { type: 'Point', coordinates: [2.123, 2.456] } }, { properties: { name: 'A', pop_max: 9e5 }, geometry: { type: 'Point', coordinates: [3, 3] } }] };
  const e = buildEarth({ land, places }, { minArea: 300, minPop: 2e5 });
  assert.equal(e.layers.land.length, 1);
  const [outer, inner] = e.layers.land[0]!.rings;
  assert.ok(sphericalArea(outer!) > 0 && sphericalArea(inner!) < 0, 'outer counter-clockwise, hole clockwise');
  assert.deepEqual(e.places, [{ name: 'A', at: [3, 3], pop: 9e5 }, { name: 'B', at: [2.12, 2.46], pop: 5e5 }]);
  assert.equal(e.layers.lakes, undefined);
  // The same collections give the same layers, and the file is written the same way every time.
  assert.equal(globeText(buildEarth({ land, places }, { minArea: 300, minPop: 2e5 })), globeText(e));
  const bad = { format: 'globe-geo/1', body: 'earth', name: 'x', radiusKm: 6371, made: { tolerance: 0.08, minArea: 300, digits: 2 }, layers: { land: [{ id: 'a', areaKm2: 1, rings: [island] }] } } as GlobeLayers;
  assert.match(globeFaults(bad).join('\n'), /land\.a\.0: an outer ring that runs clockwise/);
  assert.throws(() => earthSources(10), /110 or 50/);
});

test('globe: the command refuses an unknown body, an option out of range or of another body, and builds nothing offline without its cache', async () => {
  const root = mkdtempSync(join(tmpdir(), 'globe-'));
  const log = console.log;
  console.log = (): void => {};
  try {
    await assert.rejects(runGlobe(['--root', root, '--body', 'mars']), /--body is one of earth, moon/);
    await assert.rejects(runGlobe(['--root', root, '--tolerance', '9']), /--tolerance must be a number from 0 to 5/);
    await assert.rejects(runGlobe(['--root', root, '--body', 'moon', '--min-pop', '5']), /--min-pop is an option of the Earth/);
    await assert.rejects(runGlobe(['--root', root, '--offline']), /not in the cache/);
    await assert.rejects(runGlobe(['--root', root, '--body', 'moon', '--offline']), /not in the cache/);
  } finally {
    console.log = log;
    rmSync(root, { recursive: true, force: true });
  }
});
