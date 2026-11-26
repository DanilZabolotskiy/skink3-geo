// A world map's thematic layers: first-level divisions thinned with their countries, rivers by rank and by name, towns
// by their people, and the water risk of an indicator by category, read from a file geodatabase in a ZIP; each made
// from collections, tables and archives made here, what each refuses, and that a map asks for each. Nothing is
// downloaded and no cache is read.
//
//   node --test "test/*.test.*"

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fitView, waterRiskOnStage, worldFaults, worldOnStage, type Point, type WorldLayers } from '../map.ts';
import { area, signedArea } from '../lib/geom.mjs';
import { readGdbCatalog, readGdbFields, readGdbOffsets, readGdbTable } from '../lib/gdb.mjs';
import { creditOf, LICENCES } from '../lib/sources.mjs';
import { thinTogether } from '../lib/topology.mjs';
import { buildWorld, worldFrame } from '../lib/world.mjs';
import { buildRivers, buildTowns, buildWaterRisk, readWaterRisk, riverPicks, waterRiskIndicators } from '../lib/worldthemes.mjs';
import { runWorld, worldSourcesText } from '../world.mjs';

type Ring = [number, number][];
const closed = (ring: Ring): Ring => [...ring, ring[0]!];
const key = (p: readonly number[]): string => `${p[0]},${p[1]}`;
const asLayers = (built: object): WorldLayers => ({ format: 'world-geo/1', id: 'test', name: 'Test', units: 'metres', ...built }) as WorldLayers;

/**
 * Two countries side by side on the equator, AAA from 0° to 10° E and BBB from 10° to 20° E, and their first-level
 * divisions as Natural Earth writes them: AAA in a west and an east half, the west with a small division inside it
 * (an enclave), BBB in a south and a north half whose ISO codes are one code given twice.
 */
function collections() {
  const country = (code: string, ring: Ring, label: [number, number]) => ({
    type: 'Feature',
    properties: { ADM0_A3: code, ISO_A3: code, NAME: `Land ${code}`, CONTINENT: 'Nowhere', LABEL_X: label[0], LABEL_Y: label[1] },
    geometry: { type: 'Polygon', coordinates: [closed(ring)] },
  });
  const division = (country: string, n: number, iso: string, name: string, rings: Ring[], at: [number, number]) => ({
    type: 'Feature',
    properties: { adm0_a3: country, adm1_code: `${country}-${n}`, iso_3166_2: iso, name: `${name} (local)`, name_en: name, type_en: 'Province', longitude: at[0], latitude: at[1] },
    geometry: { type: 'Polygon', coordinates: rings.map(closed) },
  });
  return {
    countries: { features: [country('AAA', [[0, 0], [10, 0], [10, 10], [0, 10]], [5, 5]), country('BBB', [[10, 0], [20, 0], [20, 10], [10, 10]], [15, 5])] },
    divisions: {
      features: [
        division('AAA', 1, 'AA-W', 'West', [[[0, 0], [5, 0], [5, 10], [0, 10]], [[2, 4], [2, 6], [3, 6], [3, 4]]], [1, 5]),
        division('AAA', 2, 'AA-E', 'East', [[[5, 0], [10, 0], [10, 10], [5, 10]]], [7.5, 5]),
        division('AAA', 3, 'AA-I', 'Inner', [[[2, 4], [3, 4], [3, 6], [2, 6]]], [2.5, 5]),
        division('BBB', 1, 'BB-X', 'South', [[[10, 0], [20, 0], [20, 5], [10, 5]]], [40, 40]),
        division('BBB', 2, 'BB-X', 'North', [[[10, 5], [20, 5], [20, 10], [10, 10]]], [15, 7.5]),
      ],
    },
  };
}

test('thinTogether: shapes of level 1 share every arc with those of level 0, have borders of their own, and keep out of the land', () => {
  // As Natural Earth's countries do, the country has a point where a border of its divisions meets its edge.
  const a: Point[] = [[0, 0], [50, 0], [100, 0], [100, 100], [50, 100], [0, 100]];
  const b: Point[] = [[100, 0], [200, 0], [200, 100], [100, 100]];
  const west: Point[] = [[0, 0], [50, 0], [50, 100], [0, 100]];
  const east: Point[] = [[50, 0], [100, 0], [100, 100], [50, 100]];
  const t = thinTogether([{ rings: [{ points: a }] }, { rings: [{ points: b }] }, { rings: [{ points: west }], level: 1 }, { rings: [{ points: east }], level: 1 }], { tol: 1 });
  // The land and the borders are those of the countries alone.
  assert.equal(t.land.length, 1);
  assert.equal(area(t.land[0]!), 20000);
  assert.deepEqual(t.borders.map((x) => [x.a, x.b]), [[0, 1]]);
  // The divisions have one border between them, and their outer edges are the country's points.
  assert.deepEqual(t.inner!.borders.map((x) => [x.a, x.b]), [[2, 3]]);
  const country = new Set(t.shapes[0]!.rings.flat().map(key));
  for (const p of [...t.shapes[2]!.rings.flat(), ...t.shapes[3]!.rings.flat()]) if (p[0] !== 50) assert.ok(country.has(key(p)), `${key(p)} on the country`);
  assert.ok(country.has('50,0') && country.has('50,100'), 'the country takes the corners where its divisions meet its edge');
  // Opt-in: without a shape of level 1 and without groups, nothing more comes back, and level 0 is what it always was.
  const plain = thinTogether([{ rings: [{ points: a }] }, { rings: [{ points: b }] }], { tol: 1 });
  assert.ok(!('inner' in plain) && !('groups' in plain));
  assert.deepEqual(thinTogether([{ rings: [{ points: a }], level: 0 }, { rings: [{ points: b }], level: 0 }], { tol: 1 }), plain);
  assert.throws(() => thinTogether([{ rings: [{ points: a }], level: 2 as 0 }], { tol: 1 }), /a level is 0 or 1/);
  assert.throws(() => thinTogether([{ rings: [{ points: a }], level: 1, group: 'x' }], { tol: 1 }), /groups are of level 0/);
});

test('thinTogether: shapes in a group are one outline, its holes the other groups inside it; groups share their borders', () => {
  // Three pieces of group "hi" (an L round a hole) and two of group "lo": one in the hole, one beside. Pieces that
  // meet share their points where they meet.
  const shapes = [
    { rings: [{ points: [[0, 0], [100, 0], [100, 50], [40, 50], [0, 50]] as Point[] }], group: 'hi' },
    { rings: [{ points: [[0, 50], [40, 50], [40, 100], [0, 100]] as Point[] }], group: 'hi' },
    { rings: [{ points: [[40, 50], [100, 50], [100, 100], [40, 100]] as Point[] }, { points: [[60, 60], [80, 60], [80, 80], [60, 80]] as Point[], hole: true }], group: 'hi' },
    { rings: [{ points: [[60, 60], [80, 60], [80, 80], [60, 80]] as Point[] }], group: 'lo' },
    { rings: [{ points: [[100, 0], [150, 0], [150, 100], [100, 100]] as Point[] }], group: 'lo' },
  ];
  const t = thinTogether(shapes, { tol: 1 });
  assert.deepEqual(t.groups!.map((g) => g.key), ['hi', 'lo']);
  const [hi, lo] = t.groups!;
  assert.equal(hi!.land.length, 1);
  assert.equal(area(hi!.land[0]!), 10000);
  assert.equal(hi!.gaps.length, 1, 'the piece of the other group inside it is its hole');
  assert.equal(area(hi!.gaps[0]!), 400);
  assert.ok(signedArea(hi!.land[0]!) > 0 && signedArea(hi!.gaps[0]!) < 0);
  assert.equal(lo!.land.length, 2);
  // The border of the two groups is one set of points.
  const his = new Set(hi!.land[0]!.map(key));
  for (const p of lo!.land.flat()) if (p[0] === 100) assert.ok(his.has(key(p)));
});

test('buildWorld: first-level divisions thinned with their countries: their outer edges the country, one border between two, a code or a name each', () => {
  const { countries, divisions } = collections();
  const built = buildWorld({ countries, divisions }, { scale: 10, divisions: ['aaa', 'bbb'] });
  assert.deepEqual(built.made.divisions, ['aaa', 'bbb']);
  assert.deepEqual(worldFaults(asLayers(built)), []);
  const ids = built.divisions!.map((d) => d.id);
  // By country as the countries come, in a country the largest first; a code given once is the id, one given twice is not.
  assert.deepEqual([...ids].sort(), ['aa-e', 'aa-i', 'aa-w', 'bbb-1', 'bbb-2']);
  assert.deepEqual(built.divisions!.map((d) => d.country), ['aaa', 'aaa', 'aaa', 'bbb', 'bbb']);
  assert.equal(ids[2], 'aa-i', 'the smallest of its country last');
  const west = built.divisions!.find((d) => d.id === 'aa-w')!;
  assert.equal(west.name, 'West');
  assert.equal(west.code, 'AA-W');
  assert.equal(west.country, 'aaa');
  assert.equal(west.kind, 'Province');
  assert.ok(built.divisions!.find((d) => d.id === 'bbb-1')!.code === 'BB-X');
  // A label of Natural Earth outside its division is replaced by a point inside it.
  const south = built.divisions!.find((d) => d.id === 'bbb-1')!;
  const box = (r: Point[]): number[] => [Math.min(...r.map((p) => p[0])), Math.min(...r.map((p) => p[1])), Math.max(...r.map((p) => p[0])), Math.max(...r.map((p) => p[1]))];
  const [x0, y0, x1, y1] = box(south.rings[0]!) as [number, number, number, number];
  assert.ok(south.label[0] > x0 && south.label[0] < x1 && south.label[1] > y0 && south.label[1] < y1);
  // Every point of a country's outline is a point of one of its divisions: they share it point for point.
  for (const id of ['aaa', 'bbb']) {
    const c = built.countries.find((x) => x.id === id)!;
    const on = new Set(built.divisions!.filter((d) => d.country === id).flatMap((d) => d.rings.flat().map(key)));
    for (const p of c.rings.flat()) assert.ok(on.has(key(p)), `${id}: ${key(p)} lies on a division`);
  }
  // A border between two divisions of one country; the border of the two countries is theirs alone.
  const borders = built.divisionBorders!.map((b) => b.id).sort();
  assert.deepEqual(borders, ['aa-e-aa-w', 'aa-i-aa-w', 'bbb-1-bbb-2']);
  assert.deepEqual(built.boundaries.map((b) => b.id), ['aaa-bbb']);
  // Divisions of one country alone.
  const one = buildWorld({ countries, divisions }, { scale: 10, divisions: ['bbb'] });
  assert.deepEqual(one.divisions!.map((d) => d.country), ['bbb', 'bbb']);
  assert.deepEqual(buildWorld({ countries, divisions }, { scale: 10, divisions: ['all'] }).divisions!.length, 5);
});

test('buildWorld: divisions are opt-in, and what they refuse', () => {
  const { countries, divisions } = collections();
  const plain = buildWorld({ countries }, { scale: 10 });
  assert.ok(!('divisions' in plain) && !('divisionBorders' in plain) && !('divisions' in plain.made));
  // Given the collection but not asked for, the map is the map it was.
  assert.deepEqual(buildWorld({ countries, divisions }, { scale: 10 }), plain);
  assert.throws(() => buildWorld({ countries, divisions }, { scale: 50, divisions: ['aaa'] }), /share their borders with the countries of 1:10m alone: build at --scale 10/);
  assert.throws(() => buildWorld({ countries, divisions }, { scale: 10, divisions: ['zzz'] }), /no first-level divisions of zzz/);
  assert.throws(() => buildWorld({ countries }, { scale: 10, divisions: ['aaa'] }), /no collection of them is given/);
});

test('worldOnStage: divisions on the stage keep their outer edges with their country and their borders', () => {
  const { countries, divisions } = collections();
  const world = asLayers(buildWorld({ countries, divisions }, { scale: 10, divisions: ['aaa', 'bbb'] }));
  const view = fitView([0, -200000, 2300000, 1300000], { w: 1920, h: 1080 }, { mode: 'contain' });
  const map = worldOnStage(view, world);
  assert.equal(map.divisions!.length, 5);
  for (const id of ['aaa', 'bbb']) {
    const c = map.countries.find((x) => x.id === id)!;
    const on = new Set(map.divisions!.filter((d) => d.country === id).flatMap((d) => d.rings.flat().map(key)));
    for (const p of c.rings.flat()) assert.ok(on.has(key(p)), `${id}: ${key(p)} lies on a division on the stage`);
  }
  assert.deepEqual(map.divisionBorders!.map((b) => b.id).sort(), ['aa-e-aa-w', 'aa-i-aa-w', 'bbb-1-bbb-2']);
  // Opt-in: a map without divisions gives none.
  const plain = worldOnStage(view, asLayers(buildWorld({ countries }, { scale: 10 })));
  assert.ok(!('divisions' in plain) && !('divisionBorders' in plain));
});

test('buildRivers: by rank and by name, the pieces of one name joined, cut to the map; a name the map does not hold is refused', () => {
  const line = (name: string, rank: number, coords: Ring, en = name) => ({ type: 'Feature', properties: { name, name_en: en, scalerank: rank }, geometry: { type: 'LineString', coordinates: coords } });
  const rivers = {
    features: [
      line('Alpha', 2, [[1, 1], [4, 2]]),
      line('Alpha', 3, [[4, 2], [8, 3]]),
      line('Beta', 6, [[2, 8], [6, 8]]),
      line('Gamma (local)', 7, [[12, 2], [18, 4]], 'Gamma'),
      line('Far', 1, [[100, 50], [110, 50]]),
      line('', 1, [[3, 3], [4, 4]]),
    ],
  };
  const { frame, made } = buildWorld(collections(), { scale: 10, bbox: [-1, -1, 21, 11] });
  const picked = buildRivers(rivers, frame, { detail: made.detail, rank: 3, names: ['Gamma'] });
  assert.deepEqual(picked.map((r) => [r.id, r.name, r.rank, r.lines.length]), [['river-alpha', 'Alpha', 2, 1], ['river-gamma-local', 'Gamma', 7, 1]]);
  // The two pieces of Alpha are one line, from its first point to its last.
  assert.equal(picked[0]!.lines[0]!.length >= 3, true);
  assert.throws(() => buildRivers(rivers, frame, { detail: made.detail, names: ['Delta'] }), /no river "Delta" in this map/);
  assert.throws(() => buildRivers(rivers, frame, { detail: made.detail, names: ['Far'] }), /no river "Far" in this map/);
  assert.deepEqual(riverPicks('3,Ebro, Rhine'), { rank: 3, names: ['Ebro', 'Rhine'] });
  assert.deepEqual(riverPicks('Danube'), { rank: null, names: ['Danube'] });
  assert.throws(() => riverPicks('3,4'), /takes one rank/);
  assert.throws(() => riverPicks('13'), /0 to 12/);
  assert.throws(() => riverPicks(' , '), /takes a rank/);
});

test('buildTowns: the towns of at least so many people that stand on the map, the largest first', () => {
  const town = (name: string, pop: number | null, at: [number, number], cap = 0) => ({ type: 'Feature', properties: { name, pop_max: pop, adm0_a3: 'AAA', adm0cap: cap }, geometry: { type: 'Point', coordinates: at } });
  const places = { features: [town('Small', 5000, [2, 2]), town('Big', 900000, [5, 5], 1), town('Middle', 60000, [15, 5]), town('Away', 2000000, [80, 40]), town('Unknown', null, [3, 3])] };
  const { frame } = buildWorld(collections(), { scale: 10, bbox: [-1, -1, 21, 11] });
  const towns = buildTowns(places, frame, { minPop: 10000 });
  assert.deepEqual(towns.map((t) => [t.id, t.name, t.pop, t.capital ?? false, t.country]), [['town-0', 'Big', 900000, true, 'aaa'], ['town-1', 'Middle', 60000, false, 'aaa']]);
  assert.deepEqual(towns[0]!.lonlat, [5, 5]);
  // On the whole world every town stands.
  assert.equal(buildTowns(places, worldFrame().frame, { minPop: 0 }).length, 4);
});

/** A water risk collection as readWaterRisk gives it: pieces with a category and its label. */
function riskCollection() {
  const piece = (cat: number, rings: Ring[]) => ({ type: 'Feature', properties: { cat, label: `Category ${cat}` }, geometry: { type: 'Polygon', coordinates: rings.map(closed) } });
  return {
    features: [
      piece(4, [[[0, 0], [5, 0], [5, 10], [0, 10]], [[2, 2], [2, 3], [3, 3], [3, 2]]]),
      piece(4, [[[5, 0], [10, 0], [10, 5], [5, 5]]]),
      piece(1, [[[5, 5], [10, 5], [10, 10], [5, 10]]]),
      piece(2, [[[2, 2], [3, 2], [3, 3], [2, 3]]]),
      piece(-9999, [[[10, 0], [12, 0], [12, 10], [10, 10]]]),
    ],
  };
}

test('buildWaterRisk: the pieces of each category as one, its holes the categories inside it, neighbours on one border, no data last', () => {
  const { frame, made } = buildWorld(collections(), { scale: 10, bbox: [-1, -1, 21, 11] });
  const risk = buildWaterRisk(riskCollection(), frame, { detail: made.detail, minArea: made.minArea * 1e6, indicator: 'bws' });
  assert.equal(risk.indicator, 'bws');
  assert.deepEqual(risk.classes.map((c) => [c.cat, c.label, c.rings.length, c.holes.length]), [[1, 'Category 1', 1, 0], [2, 'Category 2', 1, 0], [4, 'Category 4', 1, 1], [-9999, 'Category -9999', 1, 0]]);
  const four = risk.classes.find((c) => c.cat === 4)!;
  for (const r of [...four.rings, ...four.holes]) assert.ok(signedArea(r) > 0, 'every ring and hole runs counter-clockwise, as the format has it');
  // The category inside the hole has the hole's points; the border of 4 and 1 is one set of points.
  assert.deepEqual(new Set(risk.classes.find((c) => c.cat === 2)!.rings[0]!.map(key)), new Set(four.holes[0]!.map(key)));
  const fours = new Set(four.rings[0]!.map(key));
  const shared = risk.classes.find((c) => c.cat === 1)!.rings[0]!.filter((p) => fours.has(key(p)));
  assert.ok(shared.length >= 3, `categories 4 and 1 share their border: ${shared.length} points`);
  assert.deepEqual(worldFaults(asLayers({ ...buildWorld(collections(), { scale: 10, bbox: [-1, -1, 21, 11] }), waterRisk: risk })), []);
  // On the stage: thinned together again, each category's holes wound against its rings.
  const world = asLayers({ ...buildWorld(collections(), { scale: 10, bbox: [-1, -1, 21, 11] }), waterRisk: risk });
  const view = fitView(world.frame.box, { w: 1920, h: 1080 }, { mode: 'contain' });
  const staged = waterRiskOnStage(view, world);
  assert.deepEqual(staged.map((c) => c.cat), [1, 2, 4, -9999]);
  const s4 = staged.find((c) => c.cat === 4)!;
  assert.equal(s4.holes.length, 1);
  assert.ok(Math.sign(signedArea(s4.rings[0]!)) === -Math.sign(signedArea(s4.holes[0]!)));
  assert.throws(() => waterRiskOnStage(view, asLayers(buildWorld(collections(), { scale: 10 }))), /has no water risk/);
});

// --- A file geodatabase made here --------------------------------------------------------------------------------

const varuint = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return out;
};
const varint = (n: number): number[] => {
  let v = Math.abs(n);
  const out = [(v % 64) | (n < 0 ? 0x40 : 0)];
  v = Math.floor(v / 64);
  if (v > 0) out[0]! |= 0x80;
  while (v > 0) {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  }
  return out;
};
const u8 = (n: number): Buffer => Buffer.from([n]);
const u16 = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const f64 = (n: number): Buffer => { const b = Buffer.alloc(8); b.writeDoubleLE(n); return b; };
const utf16 = (s: string): Buffer => Buffer.concat([u8(s.length), Buffer.from(s, 'utf16le')]);

type Field = { name: string; type: 'oid' | 'shape' | 'string' | 'double' | 'int' | 'raster'; nullable?: boolean };
const GEO = { x0: -400, y0: -400, scale: 1e6 };

/** A `.gdbtable` and its `.gdbtablx` of these fields and rows (a row: its values by name, a polygon as rings, Esri's way round). */
function gdbTable(fields: Field[], rows: Record<string, unknown>[]): { table: Buffer; tablx: Buffer } {
  const desc: Buffer[] = [u32(4), u32(fields.some((f) => f.type === 'shape') ? 4 : 0), u16(fields.length)];
  for (const f of fields) {
    desc.push(utf16(f.name), utf16(''));
    const flag = f.nullable ? 1 : 0;
    if (f.type === 'oid') desc.push(u8(6), u8(4), u8(2));
    else if (f.type === 'string') desc.push(u8(4), u32(0), u8(flag), u8(0));
    else if (f.type === 'double') desc.push(u8(3), u8(8), u8(flag), u8(0));
    else if (f.type === 'int') desc.push(u8(1), u8(4), u8(flag), u8(0));
    else if (f.type === 'raster') desc.push(u8(9), u8(0), u8(flag));
    else {
      const wkt = Buffer.from('GEOGCS["WGS 84"]', 'utf16le');
      desc.push(u8(7), u8(0), u8(flag), u16(wkt.length), wkt, u8(1), f64(GEO.x0), f64(GEO.y0), f64(GEO.scale), f64(1e-6), f64(-180), f64(-90), f64(180), f64(90), u8(0), u32(1), f64(1));
    }
  }
  const head = Buffer.concat(desc);
  const fieldSection = Buffer.concat([u32(head.length), head]);
  const nullable = fields.filter((f) => f.nullable);
  const rowBufs = rows.map((row) => {
    const flags = Buffer.alloc(Math.ceil(nullable.length / 8));
    nullable.forEach((f, k) => {
      if (row[f.name] === null || row[f.name] === undefined) flags[k >> 3]! |= 1 << (k & 7);
    });
    const parts: Buffer[] = [flags];
    for (const f of fields) {
      const v = row[f.name];
      if (f.type === 'oid' || (f.nullable && (v === null || v === undefined))) continue;
      if (f.type === 'string') {
        const b = Buffer.from(String(v), 'utf8');
        parts.push(Buffer.from(varuint(b.length)), b);
      } else if (f.type === 'double') parts.push(f64(v as number));
      else if (f.type === 'int') { const b = Buffer.alloc(4); b.writeInt32LE(v as number); parts.push(b); }
      else if (f.type === 'shape') {
        const rings = v as Ring[];
        const n = rings.reduce((s, r) => s + r.length, 0);
        const bytes = [...varuint(5), ...varuint(n), ...varuint(rings.length), ...varuint(0), ...varuint(0), ...varuint(0), ...varuint(0)];
        for (const r of rings.slice(0, -1)) bytes.push(...varuint(r.length));
        let [px, py] = [0, 0];
        for (const r of rings) {
          for (const [x, y] of r) {
            const [ix, iy] = [Math.round((x - GEO.x0) * GEO.scale), Math.round((y - GEO.y0) * GEO.scale)];
            bytes.push(...varint(ix - px), ...varint(iy - py));
            [px, py] = [ix, iy];
          }
        }
        parts.push(Buffer.from(varuint(bytes.length)), Buffer.from(bytes));
      }
    }
    const body = Buffer.concat(parts);
    return Buffer.concat([u32(body.length), body]);
  });
  const header = Buffer.alloc(40);
  header.writeInt32LE(3, 0);
  header.writeInt32LE(rows.length, 4);
  header.writeBigUInt64LE(40n, 32);
  const offsets: number[] = [];
  let at = 40 + fieldSection.length;
  for (const r of rowBufs) {
    offsets.push(at);
    at += r.length;
  }
  const table = Buffer.concat([header, fieldSection, ...rowBufs]);
  const tablx = Buffer.alloc(16 + 1024 * 4 + 16);
  tablx.writeInt32LE(3, 0);
  tablx.writeInt32LE(1, 4);
  tablx.writeInt32LE(rows.length, 8);
  tablx.writeInt32LE(4, 12);
  offsets.forEach((o, k) => tablx.writeUInt32LE(o, 16 + 4 * k));
  return { table, tablx };
}

/** A ZIP of stored files. */
function zipOf(files: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let at = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(n.length, 28);
    entry.writeUInt32LE(at, 42);
    locals.push(local, n, data);
    central.push(entry, n);
    at += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(at, 16);
  return Buffer.concat([...locals, dir, end]);
}

const RISK_FIELDS: Field[] = [
  { name: 'OBJECTID', type: 'oid' },
  { name: 'Shape', type: 'shape', nullable: true },
  { name: 'name_0', type: 'string', nullable: true },
  { name: 'bws_raw', type: 'double', nullable: true },
  { name: 'bws_cat', type: 'double', nullable: true },
  { name: 'bws_label', type: 'string', nullable: true },
];
/** Esri's way round: an outer ring clockwise, a hole counter-clockwise, each closed. */
const esri = (ring: Ring, hole = false): Ring => closed(hole ? ring : [...ring].reverse());

test('gdb: the fields, the row offsets, the rows and the polygons of a table of a file geodatabase', () => {
  const { table, tablx } = gdbTable(RISK_FIELDS, [
    { Shape: [esri([[0, 0], [5, 0], [5, 10], [0, 10]]), esri([[2, 2], [3, 2], [3, 3], [2, 3]], true)], name_0: 'Alpha', bws_raw: 0.9, bws_cat: 4, bws_label: 'Extremely High (>80%)' },
    { Shape: [esri([[5, 0], [10, 0], [10, 5], [5, 5]]), esri([[30, 30], [31, 30], [31, 31], [30, 31]])], name_0: null, bws_raw: null, bws_cat: null, bws_label: 'No Data' },
    { Shape: null, name_0: 'Empty', bws_raw: 0.1, bws_cat: 0, bws_label: 'Low (<10%)' },
  ]);
  const read = readGdbFields(table);
  assert.equal(read.geometry, 'polygon');
  assert.deepEqual(read.fields.map((f) => [f.name, f.type, f.nullable]), [['OBJECTID', 6, false], ['Shape', 7, true], ['name_0', 4, true], ['bws_raw', 3, true], ['bws_cat', 3, true], ['bws_label', 4, true]]);
  assert.deepEqual(waterRiskIndicators(read.fields), ['bws']);
  assert.equal(readGdbOffsets(tablx).length, 3);
  const fc = readGdbTable(table, tablx);
  assert.deepEqual(fc.features!.map((f) => f.properties), [
    { OBJECTID: 1, name_0: 'Alpha', bws_raw: 0.9, bws_cat: 4, bws_label: 'Extremely High (>80%)' },
    { OBJECTID: 2, name_0: null, bws_raw: null, bws_cat: null, bws_label: 'No Data' },
    { OBJECTID: 3, name_0: 'Empty', bws_raw: 0.1, bws_cat: 0, bws_label: 'Low (<10%)' },
  ]);
  const [first, second, third] = fc.features!.map((f) => f.geometry as { type: string; coordinates: number[][][][] | number[][][] } | null);
  assert.equal(first!.type, 'Polygon');
  assert.equal((first!.coordinates as number[][][]).length, 2, 'the hole goes to its outer ring');
  assert.deepEqual((first!.coordinates as number[][][])[0]![0], [0, 10]);
  assert.equal(second!.type, 'MultiPolygon');
  assert.equal(third, null);
  // A row left out by `want` before its geometry is read.
  assert.deepEqual(readGdbTable(table, tablx, { want: (p) => p.name_0 === 'Alpha' }).features!.map((f) => f.properties!.OBJECTID), [1]);
});

test('gdb: what it refuses', () => {
  assert.throws(() => readGdbFields(Buffer.alloc(40)), /not a table of a file geodatabase/);
  assert.throws(() => readGdbOffsets(Buffer.alloc(16)), /not the row index of a file geodatabase/);
  const { table } = gdbTable([{ name: 'OBJECTID', type: 'oid' }, { name: 'Picture', type: 'raster' }], []);
  assert.throws(() => readGdbFields(table), /the raster field "Picture" is not read/);
});

test('readWaterRisk: the table of the archive by its name in the catalog, the rows near the map, an indicator it lacks refused', () => {
  const catalog = gdbTable([{ name: 'OBJECTID', type: 'oid' }, { name: 'Name', type: 'string' }, { name: 'FileFormat', type: 'int' }], [
    { Name: 'GDB_SystemCatalog', FileFormat: 0 },
    { Name: 'other', FileFormat: 0 },
    { Name: 'baseline_annual', FileFormat: 0 },
  ]);
  assert.deepEqual(readGdbCatalog(catalog.table, catalog.tablx), [{ name: 'GDB_SystemCatalog', file: 'a00000001' }, { name: 'other', file: 'a00000002' }, { name: 'baseline_annual', file: 'a00000003' }]);
  const rows = gdbTable(RISK_FIELDS, [
    { Shape: [esri([[0, 0], [5, 0], [5, 10], [0, 10]])], name_0: 'A', bws_raw: 0.9, bws_cat: 4, bws_label: 'Extremely High (>80%)' },
    { Shape: [esri([[5, 0], [10, 0], [10, 10], [5, 10]])], name_0: 'A', bws_raw: null, bws_cat: null, bws_label: null },
    { Shape: [esri([[60, 40], [61, 40], [61, 41], [60, 41]])], name_0: 'Far', bws_raw: 0.1, bws_cat: 0, bws_label: 'Low (<10%)' },
  ]);
  const zip = zipOf({
    'atlas/GDB/x.gdb/a00000001.gdbtable': catalog.table,
    'atlas/GDB/x.gdb/a00000001.gdbtablx': catalog.tablx,
    'atlas/GDB/x.gdb/a00000003.gdbtable': rows.table,
    'atlas/GDB/x.gdb/a00000003.gdbtablx': rows.tablx,
  });
  const { frame } = buildWorld(collections(), { scale: 10, bbox: [-1, -1, 21, 11] });
  const fc = readWaterRisk(zip, { indicator: 'bws', frame });
  assert.deepEqual(fc.features!.map((f) => f.properties), [{ cat: 4, label: 'Extremely High (>80%)' }, { cat: -9999, label: 'No Data' }]);
  assert.equal(readWaterRisk(zip, { indicator: 'bws', frame: worldFrame().frame }).features!.length, 3);
  assert.throws(() => readWaterRisk(zip, { indicator: 'bwd', frame }), /no indicator "bwd" \(it has bws\)/);
  assert.throws(() => readWaterRisk(zip, { indicator: 'bws', frame, table: 'future_annual' }), /has no table future_annual/);
  assert.throws(() => readWaterRisk(zipOf({ 'a.txt': Buffer.from('x') }), { indicator: 'bws', frame }), /holds no file geodatabase/);
});

test('worldFaults: what is wrong with divisions, rivers, towns and water risk is named', () => {
  const { countries, divisions } = collections();
  const built = buildWorld({ countries, divisions }, { scale: 10, divisions: ['aaa', 'bbb'] });
  const ring: Point[] = [[0, 0], [10, 0], [10, 10]];
  const faults = worldFaults(
    asLayers({
      ...built,
      divisions: [...built.divisions!, { ...built.divisions![0]!, id: 'x', country: 'zzz' }],
      divisionBorders: [{ id: 'aa-w-bbb-1', between: ['aa-w', 'bbb-1'], lines: [[[1, 1], [2, 2]]] }],
      rivers: [{ id: 'r', name: 'R', rank: 3, lines: [[[1, 1], [2, 2]]] }, { id: 's', name: 'S', rank: 1, lines: [] }],
      towns: [{ id: 't', name: 'T', country: 'aaa', pop: 10, at: [1, 1], lonlat: [0, 0] }, { id: 'u', name: 'U', country: 'aaa', pop: 20, at: [1, 1], lonlat: [0, 0] }],
      waterRisk: { indicator: 'bws', classes: [{ cat: 1, label: 'a', rings: [ring], holes: [] }, { cat: 1, label: 'b', rings: [], holes: [] }] },
    }),
  );
  for (const f of [
    'divisions.x: of a country the map does not hold (zzz)',
    'divisionBorders.aa-w-bbb-1: between divisions of two countries, whose border is theirs',
    'rivers.s: of a lower rank than the river before it',
    'rivers.s: no lines',
    'towns.u: larger than the town before it',
    'waterRisk.1: twice',
    'waterRisk.1: no rings',
  ]) assert.ok(faults.includes(f), `${f} in ${JSON.stringify(faults)}`);
});

test('world: the options of the thematic layers, what they refuse, and the credit of the water risk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'world-themes-'));
  const log = console.log;
  console.log = (): void => {};
  try {
    await assert.rejects(runWorld(['--root', root, '--map', 'x', '--bbox', '0,0,10,10', '--divisions', 'DEU']), /--divisions takes the ids of countries/);
    await assert.rejects(runWorld(['--root', root, '--map', 'x', '--bbox', '0,0,10,10', '--divisions', 'all,deu']), /name no others with it/);
    await assert.rejects(runWorld(['--root', root, '--divisions', 'deu']), /build at --scale 10, not 50/);
    await assert.rejects(runWorld(['--root', root, '--rivers', '3,4']), /takes one rank/);
    await assert.rejects(runWorld(['--root', root, '--towns=-5']), /--towns must be a number from 0/);
    await assert.rejects(runWorld(['--root', root, '--water-risk', 'BWS']), /names an indicator of Aqueduct in small letters/);
    await assert.rejects(runWorld(['--root', root, '--map', 'x', '--bbox', '0,0,10,10', '--divisions', 'deu', '--offline']), /not in the cache/);
  } finally {
    console.log = log;
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(creditOf(LICENCES.aqueduct!, 'aqueduct', [{ source: 'aqueduct', retrieved: '2026-11-26' }]), 'Water risk: Source: WRI Aqueduct, accessed on 2026-11-26, aqueduct.wri.org. © 2023 World Resources Institute, CC BY 4.0 (creativecommons.org/licenses/by/4.0); cut to the map, merged by category and simplified.');
  assert.equal(creditOf(LICENCES['natural-earth']!, 'natural-earth', []), 'Made with Natural Earth.');
  const { countries, divisions } = collections();
  const built = buildWorld({ countries, divisions }, { scale: 10, bbox: [-1, -1, 21, 11], divisions: ['aaa'] });
  const world = {
    name: 'Test',
    ...built,
    made: { ...built.made, rivers: { rank: 4, names: ['Alpha'] }, towns: 50000, waterRisk: 'bws' },
    rivers: [{}],
    towns: [{}, {}],
    waterRisk: { indicator: 'bws', classes: [{ cat: 4, label: 'Extremely High (>80%)' }] },
  };
  const lock = [
    { id: 'ne_10m_admin_0_countries', source: 'natural-earth', bytes: 1, sha256: 'a'.repeat(64) },
    { id: 'wri-aqueduct-4-0', source: 'aqueduct', bytes: 1, sha256: 'b'.repeat(64), retrieved: '2026-11-26' },
  ];
  const text = worldSourcesText(world, lock);
  assert.match(text, /carries these lines in its description[\s\S]*Water risk: Source: WRI Aqueduct, accessed on 2026-11-26/);
  assert.match(text, /\| `divisions`, `divisionBorders` \| Natural Earth 5\.1\.2, 1:10m admin-1 states and provinces \| the first-level divisions of aaa,/);
  assert.match(text, /\| `rivers` \| Natural Earth 5\.1\.2, 1:10m rivers and lake centerlines \| the rivers of rank 4 and below; by name: Alpha;/);
  assert.match(text, /\| `towns` \| Natural Earth 5\.1\.2, 1:10m populated places \| the towns of at least 50000 people/);
  assert.match(text, /\| `waterRisk` \| WRI Aqueduct 4\.0 water risk atlas, baseline annual \(World Resources Institute\) \| the indicator `bws` by category:/);
});
