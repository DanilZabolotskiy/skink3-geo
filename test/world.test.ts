// A flat map of the world with the outline of every country: the example world and the example box as they are
// committed, the Equal Earth projection, outlines thinned together so neighbours keep one border, a map fitted to a
// stage, and maps built from collections made here. Nothing is downloaded and no cache is read.
//
//   node --test "test/*.test.*"

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fitView, loadLayers, loadWorld, toFrame, worldFaults, worldOnStage, type Point, type WorldLayers } from '../map.ts';
import { area, crosses, pointInRing, signedArea } from '../lib/geom.mjs';
import { EARTH_RADIUS, equalEarth, projection } from '../lib/project.mjs';
import { densify, thinTogether, untangle } from '../lib/topology.mjs';
import { buildWorld, worldFrame, worldSources } from '../lib/world.mjs';
import { runWorld, worldText } from '../world.mjs';

const here = (path: string): URL => new URL(`../examples/${path}`, import.meta.url);
const km2 = (r: readonly Point[]): number => area(r) / 1e6;
const lockOf = (map: string) => JSON.parse(readFileSync(here(`${map}/sources.lock.json`), 'utf8')) as { format: string; downloads: { id: string; sha256: string; request: string }[] };

test('world: the example world has every country, each border once, its sources and its lock, and keeps to the format', () => {
  const w = loadWorld(here('world/world.json'));
  assert.deepEqual(worldFaults(w), []);
  assert.equal(w.frame.projection, 'equal-earth');
  assert.equal(w.made.scale, 50);
  assert.ok(w.countries.length > 200, `${w.countries.length} countries`);
  // The largest are Russia, then Antarctica, Canada, the United States and China: about 17, 12 and 10 million km² of the true Earth.
  assert.deepEqual(w.countries.slice(0, 5).map((c) => c.id), ['rus', 'ata', 'can', 'usa', 'chn']);
  assert.ok(w.countries[0]!.areaKm2 > 16.5e6 && w.countries[0]!.areaKm2 < 17.5e6, `${w.countries[0]!.areaKm2}`);
  // Areas are true, and the countries tile the land: the land less its gaps is the countries' area to a thousandth.
  const land = w.land.reduce((s, l) => s + km2(l.ring), 0) - w.gaps.reduce((s, g) => s + km2(g.ring), 0);
  const countries = w.countries.reduce((s, c) => s + c.rings.reduce((t, r) => t + km2(r), 0), 0);
  assert.ok(Math.abs(land - countries) / countries < 1e-3, `${land} against ${countries}`);
  assert.ok(countries > 1.4e8 && countries < 1.52e8, `${countries}`);
  // The one gap is the Caspian Sea, which no country holds.
  assert.equal(w.gaps.length, 1);
  assert.ok(km2(w.gaps[0]!.ring) > 3e5 && km2(w.gaps[0]!.ring) < 4.5e5);
  // A place falls in its country on the map: toFrame takes the world's projection.
  const to = toFrame(w.frame);
  const inside = (id: string, at: [number, number]) => w.countries.find((c) => c.id === id)!.rings.some((r) => pointInRing(to(at), r));
  assert.ok(inside('fra', [2.35, 48.86]) && inside('bra', [-47.9, -15.8]) && inside('aus', [149.1, -35.3]) && inside('jpn', [139.7, 35.7]));
  assert.ok(!inside('fra', [-3.7, 40.4]));
  const borders = new Set(w.boundaries.map((b) => b.id));
  assert.ok(borders.has('esp-fra') && borders.has('can-usa') && borders.has('arg-chl') && !borders.has('aus-nzl'));
  // Every country fits inside the edge of the world.
  assert.ok(w.countries.every((c) => c.rings.every((r) => r.every(([x, y]) => pointInRing([x * 0.999, y * 0.999], w.frame.outline!)))));
  assert.match(readFileSync(here('world/SOURCES.md'), 'utf8'), /Made with Natural Earth\./);
  const lock = lockOf('world');
  assert.equal(lock.format, 'world-geo-lock/1');
  assert.deepEqual(lock.downloads.map((d) => d.id).sort(), ['ne_50m_admin_0_countries', 'ne_50m_lakes']);
  for (const d of lock.downloads) {
    assert.match(d.sha256, /^[0-9a-f]{64}$/, d.id);
    assert.doesNotMatch(d.request, /\\|Users\/|[?&](key|token|api_key)=/i, d.id);
  }
});

test('world: the example box holds every country round its middle, cut to its edge, in the projection of a region', () => {
  const w = loadWorld(here('slovenia/world.json'));
  assert.deepEqual(worldFaults(w), []);
  assert.equal(w.frame.projection, 'laea');
  assert.deepEqual(w.frame.centre, [15, 46.1]);
  const ids = 'alb aut bih che cze deu fra hrv hun ita kos lie mne pol rou smr srb svk svn ukr';
  assert.equal(w.countries.map((c) => c.id).sort().join(' '), ids);
  // The country in the middle is whole, at its true area (20,273 km²); its neighbours are the parts of them in the box.
  const svn = w.countries.find((c) => c.id === 'svn')!;
  assert.ok(Math.abs(svn.areaKm2 - 20273) < 200, `${svn.areaKm2}`);
  const to = toFrame(w.frame);
  assert.ok(svn.rings.some((r) => pointInRing(to([14.506, 46.057]), r)));
  for (const id of ['aut-svn', 'hrv-svn', 'hun-svn', 'ita-svn']) assert.ok(w.boundaries.some((b) => b.id === id), id);
  // The land is cut along the edge of the box, the sea left out; the lakes asked for are there.
  assert.ok(w.land.length >= 1 && w.lakes.some((l) => l.name === 'Lake Balaton') && w.lakes.some((l) => l.name === 'Bodensee'));
  // The smallest states stay, however small: San Marino and Liechtenstein.
  for (const id of ['smr', 'lie']) assert.ok(w.countries.some((c) => c.id === id && c.rings.length > 0 && c.areaKm2 < 200), id);
  assert.equal(lockOf('slovenia').downloads.map((d) => d.id).sort().join(' '), 'ne_10m_admin_0_countries ne_10m_lakes');
});

test('equalEarth: the published projection, areas true, and its inverse', () => {
  const p = equalEarth();
  assert.deepEqual(p.forward([0, 0]), [0, 0]);
  // The equator ends at 2.706629 radii from the middle, the pole lines lie at 1.317363 radii (Šavrič and others, 2018).
  assert.ok(Math.abs(p.forward([180, 0])[0] / EARTH_RADIUS - 2.706629) < 1e-6);
  assert.ok(Math.abs(p.forward([0, 90])[1] / EARTH_RADIUS - 1.317363) < 1e-6);
  // Parallels are straight: a latitude has one y.
  assert.equal(p.forward([-120, 40])[1], p.forward([75, 40])[1]);
  for (const ll of [[0, 0], [12.5, 41.9], [-70.6, -33.4], [179.9, 89], [-179.9, -89]] as [number, number][]) {
    const back = p.inverse(p.forward(ll));
    assert.ok(Math.abs(back[0] - ll[0]) < 1e-9 && Math.abs(back[1] - ll[1]) < 1e-9, `${ll} came back as ${back}`);
  }
  // A cell of 10° by 10° has its area on the sphere wherever it is.
  for (const lat of [0, 30, 70]) {
    const cell = densify([[20, lat], [30, lat], [30, lat + 10], [20, lat + 10]], 0.1).map(p.forward);
    const sphere = EARTH_RADIUS ** 2 * (Math.PI / 18) * (Math.sin(((lat + 10) * Math.PI) / 180) - Math.sin((lat * Math.PI) / 180));
    assert.ok(Math.abs(area(cell) - sphere) / sphere < 1e-4, `at ${lat}°: ${area(cell)} against ${sphere}`);
  }
});

/** Three shapes: A and B side by side with a jagged border, and C an enclave in A, a hole in it. */
function neighbours() {
  const jag: Point[] = [];
  for (let y = 0; y <= 1000; y += 10) jag.push([500 + (y % 20 === 0 ? 0 : 3) + Math.round(40 * Math.sin(y / 120)), y]);
  const a: Point[] = [[0, 0], ...jag, [0, 1000]];
  const b: Point[] = [[1000, 0], [1000, 1000], ...[...jag].reverse()];
  const hole: Point[] = [[100, 100], [100, 300], [300, 300], [300, 100]];
  const islet: Point[] = [[2000, 0], [2004, 0], [2004, 4], [2000, 4]];
  return { a, b, hole, islet };
}

test('thinTogether: neighbours keep one border, point for point; the land is their outline as one; an enclave borders the country round it', () => {
  const { a, b, hole, islet } = neighbours();
  const t = thinTogether([{ rings: [{ points: a }, { points: hole, hole: true }, { points: islet }] }, { rings: [{ points: b }] }, { rings: [{ points: hole }] }], { tol: 20, minArea: 100 });
  assert.equal(t.stats.crossing, 0);
  const [ra, rb, rc] = t.shapes.map((s) => s.rings);
  // The islet of A is too small and goes; B and the enclave keep their one ring.
  assert.equal(ra!.length, 1);
  assert.ok(rb!.length === 1 && rc!.length === 1);
  for (const r of [...ra!, ...rb!, ...rc!]) assert.ok(signedArea(r) > 0 && !crosses(r, true));
  // The border was thinned once: B runs back along A's points.
  const keys = (r: Point[]) => new Set(r.map((p) => `${p[0]},${p[1]}`));
  const shared = [...keys(ra![0]!)].filter((k) => keys(rb![0]!).has(k));
  assert.ok(shared.length > 4 && shared.length < 101, `${shared.length} shared points`);
  assert.ok(Math.abs(area(ra![0]!) + area(rb![0]!) - 1e6) < 1e-6, 'no gap and no overlap');
  // The land is the square round both, with nothing inside it; the borders are A-B, open, and A-C, a ring.
  assert.equal(t.land.length, 1);
  assert.equal(t.gaps.length, 0);
  assert.equal(area(t.land[0]!), 1e6);
  assert.deepEqual(t.borders.map((x) => [x.a, x.b, x.lines.length]), [[0, 1, 1], [0, 2, 1]]);
  const ring = t.borders[1]!.lines[0]!;
  assert.deepEqual(ring[0], ring.at(-1));
  // A hole that no shape fills is water inside the land.
  const lake = thinTogether([{ rings: [{ points: a }, { points: hole, hole: true }] }, { rings: [{ points: b }] }], { tol: 20, minArea: 100 });
  assert.equal(lake.gaps.length, 1);
  assert.equal(area(lake.gaps[0]!), 40000);
  // The same shapes give the same rings.
  assert.deepEqual(thinTogether([{ rings: [{ points: a }] }, { rings: [{ points: b }] }], { tol: 20 }).shapes, thinTogether([{ rings: [{ points: a }] }, { rings: [{ points: b }] }], { tol: 20 }).shapes);
});

test('thinTogether: a ring that crosses itself in the data is mended by taking out the point that makes it cross', () => {
  // A square whose top edge loops over itself: the edge from (60, 100) to (40, 90) crosses the one from (60, 90) to (40, 100).
  const loop: Point[] = [[0, 0], [100, 0], [100, 100], [60, 100], [40, 90], [60, 90], [40, 100], [0, 100]];
  assert.ok(crosses(loop, true));
  const t = thinTogether([{ rings: [{ points: loop }] }], { tol: 0.5 });
  assert.equal(t.stats.crossing, 0);
  assert.ok(t.stats.mended >= 1);
  assert.ok(!crosses(t.shapes[0]!.rings[0]!, true) && signedArea(t.shapes[0]!.rings[0]!) > 0);
  assert.ok(t.shapes[0]!.rings[0]!.length >= 6);
});

/** Two countries of 10° by 10° side by side on the equator, in a collection as Natural Earth writes it. */
function collection() {
  const feature = (code: string, ring: [number, number][], label: [number, number]) => ({
    type: 'Feature',
    properties: { ADM0_A3: code, ISO_A3: code, NAME: `Land ${code}`, CONTINENT: 'Nowhere', LABEL_X: label[0], LABEL_Y: label[1] },
    geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]!]] },
  });
  return {
    countries: { features: [feature('AAA', [[0, 0], [0, 10], [10, 10], [10, 0]], [5, 5]), feature('BBB', [[10, 0], [10, 10], [20, 10], [20, 0]], [15, 5]), { type: 'Feature', properties: { ADM0_A3: 'CCC' }, geometry: null }] },
    lakes: { features: [{ type: 'Feature', properties: { name: 'Pond', scalerank: 1 }, geometry: { type: 'Polygon', coordinates: [[[2, 2], [2, 4], [4, 4], [4, 2], [2, 2]]] } }] },
  };
}

const asLayers = (built: ReturnType<typeof buildWorld>): WorldLayers => ({ format: 'world-geo/1', id: 'test', name: 'Test', units: 'metres', ...built });

test('buildWorld: the whole world from collections: countries at their true area, one border between them, the land as one', () => {
  const built = buildWorld(collection(), { scale: 110, lakes: 2 });
  assert.equal(built.frame.projection, 'equal-earth');
  assert.deepEqual(built.frame.box, [-17243964, -8392930, 17243964, 8392930]);
  assert.deepEqual(worldFaults(asLayers(built)), []);
  assert.deepEqual(built.countries.map((c) => [c.id, c.iso, c.name]), [['aaa', 'AAA', 'Land AAA'], ['bbb', 'BBB', 'Land BBB']]);
  // A cell of 10° by 10° on the equator: 1,230,174 km² on the sphere.
  for (const c of built.countries) assert.ok(Math.abs(c.areaKm2 - 1230174) / 1230174 < 2e-3, `${c.id}: ${c.areaKm2}`);
  assert.deepEqual(built.boundaries.map((b) => [b.id, b.between]), [['aaa-bbb', ['aaa', 'bbb']]]);
  assert.equal(built.land.length, 1);
  assert.deepEqual(built.lakes.map((l) => l.name), ['Pond']);
  // Lakes only when asked for, and the same collections give the same file.
  assert.deepEqual(buildWorld(collection(), { scale: 110 }).lakes, []);
  assert.equal(worldText(buildWorld(collection(), { scale: 110, lakes: 2 })), worldText(built));
});

test('buildWorld: a box keeps the countries round it, cut to its edge, on the plane round its middle', () => {
  const built = buildWorld(collection(), { scale: 10, bbox: [5, 2, 15, 8] });
  assert.equal(built.frame.projection, 'laea');
  assert.deepEqual(built.frame.centre, [10, 5]);
  assert.deepEqual(worldFaults(asLayers(built)), []);
  assert.deepEqual(built.countries.map((c) => c.id).sort(), ['aaa', 'bbb']);
  const [x0, y0, x1, y1] = built.frame.box;
  for (const c of built.countries) for (const r of c.rings) assert.ok(r.every(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1));
  // The border is the meridian 10° E, through the middle of the box.
  const line = built.boundaries[0]!.lines[0]!;
  assert.ok(line.every(([x]) => Math.abs(x) < 1), JSON.stringify(line));
  assert.equal(built.made.centre![0], 10);
});

test('world: what it refuses, and what is wrong with a map is named', async () => {
  assert.throws(() => worldSources(20), /10, 50 or 110/);
  assert.throws(() => worldFrame({ bbox: [10, 0, 5, 5] }), /is it west and east the wrong way round/);
  assert.throws(() => loadWorld(here('earth/globe.json')), /not world-geo\/1/);
  const base = asLayers(buildWorld(collection(), { scale: 110 }));
  const clockwise = { ...base, countries: base.countries.map((c, k) => (k === 0 ? { ...c, rings: [[...c.rings[0]!].reverse()] } : c)) };
  assert.match(worldFaults(clockwise).join('\n'), /countries\.aaa\.0: runs clockwise/);
  const stray = { ...base, boundaries: [{ id: 'aaa-zzz', between: ['aaa', 'zzz'] as [string, string], lines: base.boundaries[0]!.lines }] };
  assert.match(worldFaults(stray).join('\n'), /between countries the map does not hold/);
  const order = { ...base, countries: [...base.countries].reverse().map((c, k) => ({ ...c, areaKm2: k + 1 })) };
  assert.match(worldFaults(order).join('\n'), /larger than the country before it/);
  const out = { ...base, land: [{ id: 'land-0', ring: [[0, 0], [9e7, 0], [0, 10]] as Point[] }] };
  assert.match(worldFaults(out).join('\n'), /outside the frame's box/);

  const root = mkdtempSync(join(tmpdir(), 'world-'));
  const log = console.log;
  console.log = (): void => {};
  try {
    await assert.rejects(runWorld(['--root', root, '--centre', '1,2']), /give --bbox with it/);
    await assert.rejects(runWorld(['--root', root, '--map', 'x', '--bbox', '1,2,3']), /--bbox takes 4 numbers/);
    await assert.rejects(runWorld(['--root', root, '--bbox', '1,2,3,4']), /a box has no default name/);
    await assert.rejects(runWorld(['--root', root, '--map', 'Big Map']), /--map names the map/);
    await assert.rejects(runWorld(['--root', root, '--scale', '20']), /10, 50 or 110/);
    await assert.rejects(runWorld(['--root', root, '--offline']), /not in the cache/);
  } finally {
    console.log = log;
    rmSync(root, { recursive: true, force: true });
  }
});

test('world: opt-in: a frame of a city or its region projects as it did, and their layers keep their format', () => {
  const town = loadLayers(here('valletta/layers.json'));
  for (const frame of [town.frames.region!, town.frames.city]) {
    const was = projection({ lon: frame.centre[0], lat: frame.centre[1] }).forward;
    for (const ll of [[14.5, 35.9], [14.3, 36.05]] as [number, number][]) assert.deepEqual(toFrame(frame)(ll), was(ll));
  }
  assert.equal(JSON.parse(readFileSync(here('valletta/layers.json'), 'utf8')).format, 'cities-geo/1');
});

test('worldOnStage: the whole world on a stage: every country with its borders shared point for point, the enclaves too, and no outline crossing itself', () => {
  const w = loadWorld(here('world/world.json'));
  const view = fitView(w.frame.box, { w: 1800, h: 1000 }, { mode: 'contain' });
  const s = worldOnStage(view, w);
  // The world fills the width of the stage, its sea one outline; nothing is lost but the specks smaller than the stage shows.
  assert.equal(s.sea.length, 1);
  const xs = s.sea[0]!.map(([x]) => x);
  assert.ok(Math.abs(Math.min(...xs) + 900) < 1 && Math.abs(Math.max(...xs) - 900) < 1, `${Math.min(...xs)} to ${Math.max(...xs)}`);
  assert.ok(s.countries.length >= w.countries.length - 2, `${s.countries.length} of ${w.countries.length}`);
  const all = [...s.sea, ...s.land, ...s.gaps, ...s.countries.flatMap((c) => c.rings), ...s.lakes.flatMap((l) => l.rings)];
  assert.deepEqual(all.filter((r) => crosses(r, true)).length, 0);
  assert.ok(all.every((r) => r.length >= 3 && r.length <= 4000 && r.every(([x, y]) => Math.round(x * 10) === x * 10 && Math.round(y * 10) === y * 10)), 'within a flat region, in tenths');
  // Neighbours share their border on the stage: the points of France's border with Spain are points of both.
  const keys = (id: string) => new Set(s.countries.find((c) => c.id === id)!.rings.flat().map((p) => `${p[0]},${p[1]}`));
  const [fra, esp] = [keys('fra'), keys('esp')];
  const line = s.borders.find((b) => b.id === 'esp-fra')!.lines.flat();
  assert.ok(line.length > 5 && line.every((p) => fra.has(`${p[0]},${p[1]}`) && esp.has(`${p[0]},${p[1]}`)));
  // An enclave borders the country round it; its label falls in it on the stage.
  assert.ok(s.borders.some((b) => b.id === 'lso-zaf'));
  const lso = s.countries.find((c) => c.id === 'lso')!;
  assert.ok(lso.rings.some((r) => pointInRing(lso.label, r)));
  // The land tiles with the countries: the land less its gaps is the countries' area to a hundredth.
  const land = s.land.reduce((a, r) => a + area(r), 0) - s.gaps.reduce((a, r) => a + area(r), 0);
  const countries = s.countries.filter((c) => c.id !== 'lso').reduce((a, c) => a + c.rings.reduce((b, r) => b + area(r), 0), 0);
  assert.ok(Math.abs(land - countries) / countries < 0.01, `${land} against ${countries}`);
  // The same map and view give the same outlines.
  assert.deepEqual(worldOnStage(view, w).countries.slice(0, 5), s.countries.slice(0, 5));
});

test('worldOnStage: a closer view keeps what it holds, cut to its edge and margin; a small stage still gives outlines that do not cross', () => {
  const w = loadWorld(here('world/world.json'));
  const close = worldOnStage(fitView(w.frame.box, { w: 1920, h: 1080 }, { mode: 'contain', zoom: 6, shift: [1.5e6, 5.5e6] }), w, { margin: 60 });
  const ids = new Set(close.countries.map((c) => c.id));
  assert.ok(ids.has('fra') && ids.has('deu') && !ids.has('bra') && !ids.has('aus'), [...ids].join(' '));
  for (const c of close.countries) for (const r of c.rings) assert.ok(r.every(([x, y]) => Math.abs(x) <= 1021 && Math.abs(y) <= 601), c.id);
  // Inside the edge of the world the sea is the whole view, with its margin.
  assert.equal(close.sea.length, 1);
  assert.equal(close.sea[0]!.length, 4);
  const small = worldOnStage(fitView(w.frame.box, { w: 300, h: 160 }, { mode: 'contain' }), w);
  assert.equal([...small.land, ...small.countries.flatMap((c) => c.rings)].filter((r) => crosses(r, true)).length, 0);
  // A box on a wide stage: its middle country whole among its neighbours, and what the stage crops away left out.
  const b = loadWorld(here('slovenia/world.json'));
  const near = worldOnStage(fitView(b.frame.box, { w: 1920, h: 1080 }, { mode: 'cover' }), b);
  const held = near.countries.map((c) => c.id);
  assert.ok(['svn', 'aut', 'ita', 'hrv', 'hun', 'bih'].every((id) => held.includes(id)) && !held.includes('alb'), held.join(' '));
  const svn = near.countries.find((c) => c.id === 'svn')!;
  assert.equal(svn.rings.length, 1);
  assert.ok(pointInRing(svn.label, svn.rings[0]!) && svn.rings[0]!.every(([x, y]) => Math.abs(x) < 400 && Math.abs(y) < 300));
  for (const id of ['aut-svn', 'hrv-svn', 'hun-svn', 'ita-svn']) assert.ok(near.borders.some((x) => x.id === id), id);
  assert.ok(near.lakes.some((l) => l.name === 'Lake Balaton'));
  assert.throws(() => worldOnStage(fitView(b.frame.box, { w: 1920, h: 1080 }), b, { detail: 0 }), /detail must be above 0/);
});

test('untangle: a ring that touches itself loses the point that makes it touch; a speck becomes its hull', () => {
  // A square whose top edge comes back on itself at (50, 100).
  const touch: Point[] = [[0, 0], [100, 0], [100, 100], [50, 100], [60, 90], [50, 100], [0, 100]];
  assert.ok(crosses(touch, true));
  const fixed = untangle(touch)!;
  assert.ok(!crosses(fixed, true) && fixed.length >= 4 && fixed.every((p) => touch.some((q) => q[0] === p[0] && q[1] === p[1])));
  const bow: Point[] = [[0, 0], [10, 10], [10, 0], [0, 10]];
  const hull = untangle(bow)!;
  assert.ok(!crosses(hull, true) && signedArea(hull) > 0 && area(hull) === 100);
  assert.equal(untangle([[0, 0], [1, 1], [2, 2], [1, 1]]), null);
  const square: Point[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  assert.equal(untangle(square), square);
});
