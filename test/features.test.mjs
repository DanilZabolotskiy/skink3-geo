// Named features beyond the fixed kinds (`features[]`), on made inputs: open lines and areas joined from the ways of
// mapped elements, drawn through points after a written source, or both; with their years and their stretches below
// the ground. What each builds, what it refuses, what the faults of the layers catch, and that a spec which asks for
// none asks, reads and writes nothing of theirs.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { framesOf, requestsOf, run, stringify } from '../build.mjs';
import { sha256 } from '../lib/fetch.mjs';
import { area, crosses, dist, lengthOf, signedArea, sliceLine } from '../lib/geom.mjs';
import { buildFeature, checkFeatures, elementLines } from '../lib/layers.mjs';
import { projection } from '../lib/project.mjs';
import { faultsOf } from '../map.ts';

const proj = projection({ lon: 10, lat: 45 });
const ll = (p) => {
  const [lon, lat] = proj.inverse(p);
  return { lon, lat };
};
const deg = (p) => {
  const { lon, lat } = ll(p);
  return [lon, lat];
};
const way = (id, points, tags = {}) => ({ type: 'way', id, tags, geometry: points.map(ll) });
const member = (points, role = 'outer') => ({ type: 'way', ref: 0, role, geometry: points.map(ll) });
const near = (p, q, eps = 0.2) => dist(p, q) <= eps;

const VIEW = [-2000, -2000, 3000, 3000];
const views = { metro: [...deg([VIEW[0], VIEW[1]]), ...deg([VIEW[2], VIEW[3]])].map((v) => Math.round(v * 1e6) / 1e6) };
const SPEC = { city: 'testville', name: 'Testville', centre: [10, 45], views };
const frame = () => {
  const { city } = framesOf(SPEC);
  return { ...city, box: city.views.metro };
};

/** A channel: two mapped ways that meet end to end (the second runs the other way), and a stretch drawn by hand from their east end north. */
const CHANNEL_WAYS = [way(11, [[-3000, 0], [-1000, 0]], { waterway: 'canal' }), way(12, [[1000, 0], [-1000, 0]], { waterway: 'canal' })];
const CHANNEL = { id: 'channel', name: 'The channel', kind: 'line', from: { ohm: ['way/11', 'way/12'], points: [deg([1000, 0]), deg([1000, 1500])] }, start: deg([1000, 1500]), built: -100, until: 540, under: [[1, 2.5]], source: 'Drawn after the account of its course in a written source.' };
/** A square yard as one closed way; a basin as a relation whose outer ring is two ways, with a hole that is not kept. */
const YARD = way(21, [[-1500, 500], [-500, 500], [-500, 1500], [-1500, 1500], [-1500, 500]], { landuse: 'yard' });
const BASIN = { type: 'relation', id: 22, tags: { type: 'multipolygon', natural: 'water' }, members: [member([[2000, -1500], [2800, -1500], [2800, -500]]), member([[2800, -500], [2000, -500], [2000, -1500]]), member([[2200, -1300], [2400, -1300], [2400, -1100], [2200, -1300]], 'inner')] };
/** A hall drawn as an arch whose top lies north of the view: the view cuts it into its two legs. */
const ARCH = [[0, 2000], [400, 2000], [400, 3600], [1600, 3600], [1600, 2000], [2000, 2000], [2000, 4000], [0, 4000]].map(deg);

test('features: a line joins its ways and its points end to end, begins at its start, is cut to its view, and splits into stretches above and below the ground', () => {
  const { lines } = elementLines(CHANNEL_WAYS, CHANNEL.from.ohm);
  assert.deepEqual(elementLines(CHANNEL_WAYS, ['way/11', 'way/99', 'relation/5']).missing, ['way/99', 'relation/5'], 'what the answer lacks is named, and the build stops on it');
  const f = buildFeature(CHANNEL, frame(), lines);
  assert.deepEqual([f.id, f.name, f.kind, f.built, f.until], ['channel', 'The channel', 'line', -100, 540]);
  assert.equal(f.lengthKm, 5.5, 'the whole line, also where the view cuts it');
  assert.equal(f.lines.length, 1);
  const line = f.lines[0];
  assert.ok(near(line[0], [1000, 1500]) && near(line[line.length - 1], [-2000, 0], 1), 'from its start to the edge of the view');
  assert.ok(Math.abs(lengthOf(line) - 4500) < 2);
  // The stretches: 0 to 1 km above, 1 to 2.5 below, 2.5 to the end above, each cut to the view; one runs into the next.
  assert.deepEqual(f.stretches.map((s) => [s.under, s.fromKm, s.toKm]), [[false, 0, 1], [true, 1, 2.5], [false, 2.5, 5.5]]);
  const [a, b, c] = f.stretches.map((s) => s.lines[0]);
  assert.ok(near(a[a.length - 1], [1000, 500]) && near(b[0], [1000, 500]) && near(b[b.length - 1], [0, 0]) && near(c[0], [0, 0]));
  assert.ok(near(b[1], [1000, 0]), 'the corner stays in the stretch below the ground');
  assert.ok(Math.abs(lengthOf(b) - 1500) < 1 && Math.abs(lengthOf(c) - 2000) < 2);
  // A line given the other way round, with no start, begins at its first point given.
  const reversed = buildFeature({ ...CHANNEL, start: undefined, under: undefined, from: { points: [deg([1000, 1500]), deg([1000, 0]), deg([-1000, 0])] } }, frame());
  assert.ok(near(reversed.lines[0][0], [1000, 1500]) && reversed.stretches === undefined && reversed.lengthKm === 3.5);
  // Thinned to its detail, and a smoothed line rounds its corner.
  const smooth = buildFeature({ ...CHANNEL, under: undefined, smooth: 3, detail: 4 }, frame(), lines);
  assert.ok(smooth.lines[0].length > line.length && !smooth.lines[0].some((p) => near(p, [1000, 0], 5)));
  assert.deepEqual(sliceLine([[0, 0], [10, 0], [10, 10]], 5, 15), [[5, 0], [10, 0], [10, 5]]);
});

test('features: an area closes its ways into rings without holes, a drawn one is a ring of its points, and the view cuts it into pieces', () => {
  const yard = buildFeature({ id: 'yard', name: 'The yard', kind: 'area', from: { ohm: ['way/21'] }, source: 'Mapped.' }, frame(), elementLines([YARD], ['way/21']).lines);
  assert.equal(yard.areaHa, 100);
  assert.ok(signedArea(yard.ring) > 0 && !crosses(yard.ring) && yard.pieces.length === 0);
  const basin = buildFeature({ id: 'basin', name: 'The basin', kind: 'area', from: { osm: ['relation/22'] }, source: 'Mapped.' }, frame(), elementLines([BASIN], ['relation/22'], (role) => role !== 'inner').lines);
  assert.equal(basin.areaHa, 80, 'its two outer ways join into one ring; its hole is not cut out');
  const hall = buildFeature({ id: 'hall', name: 'The hall', kind: 'area', from: { points: ARCH }, built: 80, source: 'Drawn after a plan in a written source.' }, frame());
  assert.deepEqual([hall.areaHa, hall.pieces.length, hall.built], [80, 1, 80], 'two legs of 40 ha, the larger first');
  assert.ok(Math.abs(area(hall.ring) - 400000) < 10 && Math.abs(area(hall.pieces[0]) - 400000) < 10);
  assert.ok([hall.ring, ...hall.pieces].every((r) => r.every(([, y]) => y <= 3000.05)));
  // A drawn outline may be rounded.
  const round = buildFeature({ id: 'yard', name: 'The yard', kind: 'area', from: { points: [[-1500, 500], [-500, 500], [-500, 1500], [-1500, 1500]].map(deg) }, smooth: 2, source: 'Drawn.' }, frame());
  assert.ok(round.ring.length > 4 && round.areaHa < 90 && round.areaHa > 80, `${round.ring.length} points, ${round.areaHa} ha`);
});

test('features: what they refuse', () => {
  const bad = (run, message) => assert.throws(run, (e) => e instanceof Error && message.test(e.message), String(message));
  const line = (more) => ({ id: 'x', name: 'X', kind: 'line', from: { points: [deg([0, 0]), deg([100, 0])] }, source: 'Drawn.', ...more });
  bad(() => checkFeatures([line({ kind: 'road' })]), /feature x: its kind is "line" or "area", not "road"/);
  bad(() => checkFeatures([line({ source: undefined })]), /feature x: it names its source/);
  bad(() => checkFeatures([line({ colour: 'red' })]), /feature x: no key "colour"/);
  bad(() => checkFeatures([line({ from: {} })]), /feature x: "from" names elements \(ohm, osm\) or points drawn by hand/);
  bad(() => checkFeatures([line({ from: { osm: ['node/5'] } })]), /node\/5 is a point; a feature is made of ways and relations/);
  bad(() => checkFeatures([line({ from: { points: [deg([0, 0])] } })]), /"from\.points" is a list of 2 \[lon, lat\] or more/);
  bad(() => checkFeatures([line({ kind: 'area', from: { points: [deg([0, 0]), deg([1, 0])] } })]), /"from\.points" is a list of 3 \[lon, lat\] or more/);
  bad(() => checkFeatures([line({ kind: 'area', under: [[0, 1]], from: { points: ARCH } })]), /"under" is for a line, and it is an area/);
  bad(() => checkFeatures([line({ under: [[0.5, 1], [0.8, 2]] })]), /none over another/);
  bad(() => checkFeatures([line({ built: 300, until: 200 })]), /it ends \(200\) before it is built \(300\)/);
  bad(() => checkFeatures([line({ built: 1.5 })]), /"built" is a year/);
  bad(() => checkFeatures([line(), line()]), /the id "x" is given twice/);
  bad(() => requestsOf({ ...SPEC, features: [line({ view: 'close' })] }, framesOf(SPEC)), /no view "close" in the spec/);
  bad(() => buildFeature(line({ under: [[0, 1]] }), frame()), /"under" runs to 1 km, and the line is 0\.1 km long/);
  bad(() => buildFeature(line({ under: [[0, 0.05]], from: { points: [deg([0, 0]), deg([100, 0])], osm: ['way/1'] } }), frame(), [[deg([500, 500]), deg([600, 500])]]), /"under" needs a line that joins into one, and its ways and points make 2 lines/);
  bad(() => buildFeature(line({ from: { points: [deg([9000, 9000]), deg([9100, 9000])] } }), frame()), /feature x: no part of it lies in its view/);
  bad(() => buildFeature(line({ kind: 'area', from: { osm: ['way/1'] } }), frame(), [[deg([0, 0]), deg([100, 0]), deg([100, 100])]]), /its ways do not close into rings \(1 open line\(s\)\)/);
  bad(() => buildFeature(line({ kind: 'area', from: { points: [[0, 0], [1000, 1000], [1000, 0], [0, 1000]].map(deg) } }), frame()), /its outline crosses itself/);
});

/** A download put into a cache as the pipeline keeps it, so that an offline build reads it. */
function cached(cache, id, keyText, data) {
  const dir = join(cache, `${id}-${sha256(keyText).slice(0, 12)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'data.json'), data);
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id, url: 'https://overpass.example/', bytes: data.length, sha256: sha256(data), fetched: '2026-01-01' }));
}

test('features: asked for only when a spec names them; a build writes them last, credits each source, and passes the faults; one without them is as it was', async () => {
  const frames = framesOf(SPEC);
  assert.deepEqual(requestsOf(SPEC, frames), {});
  const HALL = { id: 'hall', name: 'The hall', kind: 'area', from: { points: ARCH }, source: 'Drawn after a plan in a written source.' };
  const features = [CHANNEL, { id: 'yard', name: 'The yard', kind: 'area', from: { ohm: ['way/21'] }, source: 'The yard as OpenHistoricalMap maps it.' }, { id: 'basin', name: 'The basin', kind: 'area', from: { osm: ['relation/22'] }, until: 1900, source: 'The basin as OpenStreetMap maps it.' }, HALL];
  const spec = { ...SPEC, places: { view: 'metro' }, features };
  const requests = requestsOf(spec, frames);
  assert.deepEqual(Object.keys(requests), ['places', 'features-ohm', 'features-osm']);
  assert.equal(requests['features-ohm'].query, '[out:json][timeout:120];\n(\n  way(11);\n  way(12);\n  way(21);\n);\nout geom;\n', 'each element once');
  assert.equal(requests['features-osm'].id, 'testville-osm-features');
  assert.deepEqual(Object.keys(requestsOf({ ...SPEC, features: [HALL] }, frames)), [], 'points drawn by hand ask nothing');

  const root = mkdtempSync(join(tmpdir(), 'cities-'));
  const log = console.log;
  console.log = () => {};
  try {
    mkdirSync(join(root, 'cities'));
    const cache = join(root, 'cache');
    const answer = (elements) => Buffer.from(JSON.stringify({ version: 0.6, osm3s: { timestamp_osm_base: '2026-01-01T00:00:00Z' }, elements }));
    const put = (key, source, elements) => cached(cache, requests[key].id, `overpass-${source}\ndata=${encodeURIComponent(requests[key].query)}`, answer(elements));
    put('places', 'osm', [{ type: 'node', id: 7, tags: { place: 'suburb', name: 'Northside' }, ...ll([500, 1000]) }]);
    put('features-ohm', 'ohm', [...CHANNEL_WAYS, YARD]);
    put('features-osm', 'osm', [BASIN]);
    writeFileSync(join(root, 'cities', 'testville.json'), stringify(spec));
    assert.equal(await run(['testville', '--offline'], { root }), 0);
    const layers = JSON.parse(readFileSync(join(root, 'testville', 'layers.json'), 'utf8'));
    assert.deepEqual(Object.keys(layers.city), ['places', 'features'], 'written last');
    assert.deepEqual(layers.city.features.map((f) => [f.id, f.kind, f.lengthKm ?? f.areaHa]), [['channel', 'line', 5.5], ['yard', 'area', 100], ['basin', 'area', 80], ['hall', 'area', 80]]);
    assert.equal(layers.city.features[2].until, 1900);
    assert.deepEqual(faultsOf(layers), []);
    const sources = readFileSync(join(root, 'testville', 'SOURCES.md'), 'utf8');
    assert.ok(sources.includes('| `city.features: channel` | OpenHistoricalMap | OpenHistoricalMap way/11, way/12; drawn by hand through 2 points |'));
    assert.ok(sources.includes('| `city.features: basin` | OpenStreetMap |') && sources.includes('| `city.features: hall` | Drawn by hand | drawn by hand through 8 points |'));
    assert.ok(sources.includes('- **The channel** (`city.features: channel`): Drawn after the account of its course in a written source.'));
    assert.ok(sources.includes('  - built 100 BC, gone by AD 540') && sources.includes('  - below the ground: 1 to 2.5 km of its 5.5 km'));
    const lock = JSON.parse(readFileSync(join(root, 'testville', 'sources.lock.json'), 'utf8'));
    assert.deepEqual(lock.downloads.map((d) => [d.id, d.source]), [['testville-ohm-features', 'ohm'], ['testville-osm-features', 'osm'], ['testville-osm-places', 'osm']]);
    // Without them, nothing of theirs is asked, read or written, and the rest is as it was.
    writeFileSync(join(root, 'cities', 'testville.json'), stringify({ ...SPEC, places: { view: 'metro' } }));
    assert.equal(await run(['testville', '--offline'], { root }), 0);
    const plain = JSON.parse(readFileSync(join(root, 'testville', 'layers.json'), 'utf8'));
    assert.deepEqual(plain.city, { places: layers.city.places });
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'testville', 'sources.lock.json'), 'utf8')).downloads.map((d) => d.id), ['testville-osm-places']);
    assert.ok(!readFileSync(join(root, 'testville', 'SOURCES.md'), 'utf8').includes('city.features'));
  } finally {
    console.log = log;
    rmSync(root, { recursive: true, force: true });
  }
});

test('features: the faults of the layers catch a line out of its frame, stretches out of order, a clockwise area and an id given twice', () => {
  const { city } = framesOf(SPEC);
  const layers = (features) => ({ format: 'cities-geo/1', id: 'testville', name: 'Testville', frames: { city: { centre: SPEC.centre, projection: 'laea', box: city.box, lonlat: city.lonlat, views: city.views } }, city: { features } });
  const good = buildFeature(CHANNEL, frame(), elementLines(CHANNEL_WAYS, CHANNEL.from.ohm).lines);
  const yard = buildFeature({ id: 'yard', name: 'The yard', kind: 'area', from: { ohm: ['way/21'] }, source: 'Mapped.' }, frame(), elementLines([YARD], ['way/21']).lines);
  assert.deepEqual(faultsOf(layers([good, yard])), []);
  assert.deepEqual(faultsOf(layers([{ ...good, lines: [[[0, 0], [90000, 0]]] }])), ['city.features.channel.lines.0: a point outside its frame']);
  assert.deepEqual(faultsOf(layers([{ ...good, stretches: [good.stretches[1], good.stretches[0]] }])), ['city.features.channel.stretches.1: not in order along the line']);
  assert.deepEqual(faultsOf(layers([{ ...yard, ring: [...yard.ring].reverse() }])), ['city.features.yard: clockwise']);
  assert.deepEqual(faultsOf(layers([yard, yard])), ['city.features: an id given twice']);
  assert.deepEqual(faultsOf(layers([{ ...yard, built: 500, until: 100 }])), ['city.features.yard: it ends before it is built']);
});
