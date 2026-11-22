// The layers of administrative divisions, named places and main roads, on made inputs: answers of Overpass and a file
// of Natural Earth's roads shaped as the real ones are. What each builds, what it refuses, and that a spec which does
// not ask for one builds what it built before.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { framesOf, requestsOf, run, stringify } from '../build.mjs';
import { sha256 } from '../lib/fetch.mjs';
import { area, crosses, pointInRing, signedArea } from '../lib/geom.mjs';
import { buildDivisions, buildPlaces, buildStreets, divisionLevels, placeKinds, roadsOf, streetClasses } from '../lib/layers.mjs';
import { NATURAL_EARTH_VERSION } from '../lib/sources.mjs';
import { projection } from '../lib/project.mjs';

const proj = projection({ lon: 10, lat: 45 });
const ll = (p) => {
  const [lon, lat] = proj.inverse(p);
  return { lon, lat };
};
const way = (points, role = 'outer') => ({ type: 'way', ref: 0, role, geometry: points.map(ll) });
const node = (p, role) => ({ type: 'node', ref: 0, role, ...ll(p) });
const relation = (id, tags, members) => ({ type: 'relation', id, tags, members });
const inBox = (p, [x0, y0, x1, y1]) => p[0] >= x0 - 0.05 && p[0] <= x1 + 0.05 && p[1] >= y0 - 0.05 && p[1] <= y1 + 0.05;

/**
 * Two divisions of level 8 side by side, west and east of a border that wiggles from the south to the north; their
 * south edge runs across the view. A quarter of level 9 inside the west one with its label node, a division with no
 * name, and a boundary of another kind.
 */
function divisionsAnswer() {
  const border = [[0, -1500], [30, -500], [-20, 300], [10, 1200], [0, 4000]];
  const adm = (level, name) => ({ boundary: 'administrative', admin_level: String(level), ...(name ? { name } : {}) });
  return [
    relation(1, adm(8, 'West'), [way([[0, 4000], [-6000, 4000], [-6000, -1500], [0, -1500]]), way(border), node([-3000, 1000], 'admin_centre')]),
    relation(2, { ...adm(8, 'East'), 'name:en': 'East Side' }, [way([...border].reverse()), way([[0, 4000], [6000, 4000], [6000, -1500], [0, -1500]].reverse()), node([9000, 0], 'label')]),
    relation(3, adm(9, 'Quarter'), [way([[-2000, -1000], [-1000, -1000], [-1000, 0], [-2000, 0], [-2000, -1000]]), node([-1200, -800], 'label')]),
    relation(4, adm(8), [way([[-500, 2500], [500, 2500], [500, 3500], [-500, 2500]])]),
    relation(5, { boundary: 'postal_code', admin_level: '8', name: 'Post' }, [way([[-500, -500], [500, -500], [500, 500], [-500, -500]])]),
  ];
}

test('divisions: neighbours share their border point for point, cut to the view, with a label point and the lines to stroke them', () => {
  const frame = { proj, box: [-3000, -2000, 2000, 2000] };
  const { divisions, borders } = buildDivisions({ level: 8 }, frame, divisionsAnswer());
  // The largest in the view first; ids from the names; the area is that of what lies in the view.
  assert.deepEqual(divisions.map((d) => [d.id, d.name, d.level, d.osm]), [['west', 'West', 8, 'relation/1'], ['east', 'East', 8, 'relation/2']]);
  assert.ok(Math.abs(divisions[0].areaKm2 - 3 * 3.5) < 0.05 && Math.abs(divisions[1].areaKm2 - 2 * 3.5) < 0.05);
  for (const d of divisions) {
    assert.ok(signedArea(d.ring) > 0 && !crosses(d.ring, true), d.id);
    assert.ok(d.ring.every((p) => inBox(p, frame.box)), d.id);
    assert.deepEqual(d.pieces, []);
    assert.ok(pointInRing(d.at, d.ring), d.id);
  }
  // The label node of the east division lies outside it: its point is found inside instead.
  assert.ok(divisions[1].at[0] > 0);
  // The border is the same points on both sides, wiggles and all.
  const onBorder = (ring) => ring.filter((p) => Math.abs(p[0]) < 100 && p[1] > -1500 && p[1] < 2000).map((p) => p.join(',')).sort();
  assert.deepEqual(onBorder(divisions[0].ring), onBorder(divisions[1].ring));
  assert.ok(onBorder(divisions[0].ring).includes('30,-500') && onBorder(divisions[0].ring).includes('-20,300'));
  // The lines to stroke: the border between the two, and their outline along the south, never the edge of the view.
  assert.deepEqual(borders.map((b) => [b.id, b.level, b.between]), [['east-west', 8, ['east', 'west']], ['outline-8', 8, []]]);
  const [between, outline] = borders;
  assert.equal(between.lines.length, 1);
  assert.deepEqual([between.lines[0][0][1], between.lines[0].at(-1)[1]].sort((a, b) => a - b), [-1500, 2000]);
  assert.ok(outline.lines.every((l) => l.every((p) => Math.abs(p[1] + 1500) < 0.05)));
  assert.ok(outline.lines.flat().every((p) => inBox(p, frame.box)));
  // The same inputs give the same layers.
  assert.equal(JSON.stringify(buildDivisions({ level: 8 }, frame, divisionsAnswer())), JSON.stringify({ divisions, borders }));
});

test('divisions: levels, names, and what is refused', () => {
  const frame = { proj, box: [-3000, -2000, 2000, 2000] };
  // Two levels: the lower first, the order to paint them in; the quarter stands at its label node.
  const both = buildDivisions({ level: [9, 8] }, frame, divisionsAnswer()).divisions;
  assert.deepEqual(both.map((d) => [d.id, d.level]), [['west', 8], ['east', 8], ['quarter', 9]]);
  assert.deepEqual(both[2].at, [-1200, -800]);
  assert.ok(Math.abs(area(both[2].ring) - 1e6) < 10);
  // A name, as the source writes it or in English, keeps only that division; its outline is then its whole edge in the view.
  const one = buildDivisions({ level: 8, names: ['East Side'] }, frame, divisionsAnswer());
  assert.deepEqual([one.divisions.map((d) => d.id), one.borders.map((b) => b.id)], [['east'], ['outline-8']]);
  assert.throws(() => buildDivisions({ level: 8, names: ['North'] }, frame, divisionsAnswer()), /no division named "North"/);
  assert.throws(() => buildDivisions({ level: 7 }, frame, divisionsAnswer()), /no division of admin_level 7/);
  for (const level of [0, 13, 8.5, '8', [], undefined]) assert.throws(() => divisionLevels({ level }), /admin_level/, String(level));
  assert.deepEqual(divisionLevels({ level: [9, 8, 9] }), [8, 9]);
  // What the cut leaves of a division that only grazes the view, under `minArea`, is left out, and its border with it.
  const grazed = buildDivisions({ level: 8, minArea: 1.5e6 }, { proj, box: [-500, -1000, 6000, 1000] }, divisionsAnswer());
  assert.deepEqual([grazed.divisions.map((d) => d.id), grazed.borders.some((b) => b.id === 'east-west')], [['east'], false]);
  // A view the divisions do not reach gives none of them.
  assert.throws(() => buildDivisions({ level: 9 }, { proj, box: [1000, 1000, 2000, 2000] }, divisionsAnswer()), /no division/);
});

test('places: points and areas of the kinds asked for, a place mapped both ways once (spelled apart, or by its Wikidata item), in the order of the kinds', () => {
  const frame = { proj, box: [-3000, -2000, 3000, 2000] };
  const n = (id, p, tags) => ({ type: 'node', id, tags, ...ll(p) });
  const elements = [
    n(11, [500, 1000], { place: 'suburb', name: 'Northside' }),
    n(12, [-1000, 500], { place: 'quarter', name: 'Old Town' }),
    { type: 'way', id: 21, tags: { place: 'quarter', name: 'Old Town' }, geometry: [[-1500, 0], [-500, 0], [-500, 1000], [-1500, 1000], [-1500, 0]].map(ll) },
    relation(31, { place: 'neighbourhood', name: 'Docks', type: 'multipolygon' }, [way([[1000, -1800], [3500, -1800], [3500, -500], [1000, -500], [1000, -1800]]), node([1500, -1000], 'label')]),
    n(13, [-500, -500], { place: 'neighbourhood', name: 'Docks' }),
    n(14, [9000, 0], { place: 'suburb', name: 'Far Away' }),
    n(15, [0, 0], { place: 'city', name: 'Testville' }),
    n(16, [100, 100], { place: 'suburb' }),
    // The same place as an area and a point, spelled apart, or named apart but the same item of Wikidata; a name with accents.
    { type: 'way', id: 22, tags: { place: 'suburb', name: 'Lake-Side' }, geometry: [[-2500, -1500], [-1800, -1500], [-1800, -800], [-2500, -800], [-2500, -1500]].map(ll) },
    n(18, [-2200, -1200], { place: 'suburb', name: 'Lake Side' }),
    { type: 'way', id: 23, tags: { place: 'suburb', name: 'Hill', wikidata: 'Q2' }, geometry: [[1000, 500], [2000, 500], [2000, 1500], [1000, 1500], [1000, 500]].map(ll) },
    n(19, [1500, 1000], { place: 'suburb', name: 'Hillcrest', wikidata: 'Q2' }),
    n(20, [2500, 1500], { place: 'suburb', name: 'Grünau' }),
  ];
  const places = buildPlaces({}, frame, elements);
  assert.deepEqual(places.map((p) => [p.id, p.name, p.kind, p.osm, p.ring ? 'ring' : 'point']), [
    ['grunau', 'Grünau', 'suburb', 'node/20', 'point'],
    ['hill', 'Hill', 'suburb', 'way/23', 'ring'],
    ['lake-side', 'Lake-Side', 'suburb', 'way/22', 'ring'],
    ['northside', 'Northside', 'suburb', 'node/11', 'point'],
    ['old-town', 'Old Town', 'quarter', 'way/21', 'ring'],
    ['docks', 'Docks', 'neighbourhood', 'node/13', 'point'],
    ['docks-relation-31', 'Docks', 'neighbourhood', 'relation/31', 'ring'],
  ]);
  const byOsm = Object.fromEntries(places.map((p) => [p.osm, p]));
  // The point of a place mapped both ways is its node; an area stands at its label node; lon/lat come with the point.
  assert.deepEqual(byOsm['way/21'].at, [-1000, 500]);
  assert.deepEqual(byOsm['relation/31'].at, [1500, -1000]);
  assert.deepEqual([byOsm['way/22'].at, byOsm['way/23'].at], [[-2200, -1200], [1500, 1000]]);
  assert.ok(Math.abs(byOsm['node/11'].lonlat[0] - ll([500, 1000]).lon) < 1e-6);
  // An area's outline is cut to the view.
  const docks = byOsm['relation/31'].ring;
  assert.ok(signedArea(docks) > 0 && docks.every((p) => inBox(p, frame.box)) && Math.max(...docks.map((p) => p[0])) === 3000);
  // Other kinds on request, in their order; a kind that is not one is refused.
  assert.deepEqual(buildPlaces({ kinds: ['city', 'suburb'] }, frame, elements).map((p) => p.id), ['testville', 'grunau', 'hill', 'lake-side', 'northside']);
  assert.throws(() => placeKinds({ kinds: ['metropolis'] }), /"metropolis" is not a kind of place/);
  assert.throws(() => placeKinds({ kinds: [] }), /is a list of values/);
  assert.equal(JSON.stringify(buildPlaces({}, frame, elements)), JSON.stringify(places));
});

/** A file of roads shaped as Natural Earth's: a major highway in two pieces with its route numbers, a secondary one, a road, a ferry, one far away. */
function roadsFile(dir) {
  const feature = (props, coordinates, type = 'LineString') => ({ type: 'Feature', properties: { featurecla: 'Road', routeraw: null, label: null, name: null, ...props }, geometry: { type, coordinates } });
  const line = (points) => points.map((p) => [ll(p).lon, ll(p).lat]);
  const file = join(dir, 'roads.geojson');
  writeFileSync(
    file,
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        feature({ type: 'Major Highway', routeraw: 'E1 A1', label: 'E1', name: '1' }, line([[-9000, 0], [0, 100]])),
        feature({ type: 'Major Highway', routeraw: 'E1 A1', label: 'E1', name: '1' }, line([[0, 100], [9000, 0]])),
        feature({ type: 'Secondary Highway', routeraw: '_untitled_7', label: 'N5' }, [line([[0, -9000], [0, -3000]]), line([[0, -3000], [200, 9000]])], 'MultiLineString'),
        feature({ type: 'Secondary Highway', name: '2' }, line([[-4000, 4000], [-3000, -4000]])),
        feature({ type: 'Road' }, line([[-2000, -2000], [2000, 2000]])),
        feature({ type: 'Ferry Route', featurecla: 'Ferry' }, line([[-2000, 2000], [2000, -2000]])),
        feature({ type: 'Major Highway', routeraw: 'E9' }, line([[90000, 0], [99000, 0]])),
      ],
    }),
  );
  return file;
}

test('streets from Natural Earth: its roads by their class, with their route numbers, joined and cut to the view', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roads-'));
  try {
    const frame = { proj, box: [-5000, -5000, 5000, 5000] };
    const lonlat = [ll([-5000, -5000]).lon, ll([-5000, -5000]).lat, ll([5000, 5000]).lon, ll([5000, 5000]).lat];
    const ways = roadsOf(roadsFile(dir), lonlat);
    // The road far away is not read; a piece of a multi-line is a way of its own; the classes are Natural Earth's types.
    assert.deepEqual(ways.map((w) => [w.tags.highway, w.tags.ref ?? null]), [['major-highway', 'E1 A1'], ['major-highway', 'E1 A1'], ['secondary-highway', 'N5'], ['secondary-highway', 'N5'], ['secondary-highway', '2'], ['road', null], ['ferry-route', null]]);
    const streets = buildStreets({ from: 'natural-earth' }, frame, ways);
    assert.deepEqual(streets.map((s) => [s.id, s.class, s.ref]), [['street-0', 'major-highway', 'E1 A1'], ['street-1', 'secondary-highway', 'N5'], ['street-2', 'secondary-highway', '2']]);
    // A road in two pieces is one line, cut at the edge of the view.
    assert.equal(streets[0].lines.length, 1);
    assert.deepEqual([streets[0].lines[0][0][0], streets[0].lines[0].at(-1)[0]], [-5000, 5000]);
    assert.ok(Math.abs(streets[0].lengthKm - 10) < 0.05);
    // Other classes on request; a class Natural Earth does not have is refused, and the classes of the other sources stand as they were.
    assert.deepEqual(buildStreets({ from: 'natural-earth', classes: ['road', 'ferry-route'] }, frame, ways).map((s) => s.class), ['road', 'ferry-route']);
    assert.throws(() => streetClasses({ from: 'natural-earth', classes: ['motorway'] }), /Natural Earth has no road class "motorway"/);
    assert.deepEqual([streetClasses({}), streetClasses({ from: 'ohm', classes: ['primary'] })], [['motorway', 'trunk', 'primary'], ['primary']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('requests: divisions and places are asked of OpenStreetMap only when a spec names them; roads of Natural Earth ask nothing', () => {
  const spec = { city: 'testville', name: 'Testville', centre: [10, 45], views: { metro: [9.9, 44.95, 10.1, 45.05] } };
  const frames = framesOf(spec);
  assert.deepEqual(requestsOf(spec, frames), {});
  const asking = { ...spec, divisions: { view: 'metro', level: [9, 8] }, places: { view: 'metro', kinds: ['suburb', 'quarter'] }, streets: { view: 'metro', from: 'natural-earth' } };
  const requests = requestsOf(asking, frames);
  assert.deepEqual(Object.keys(requests), ['divisions', 'places']);
  assert.deepEqual([requests.divisions.id, requests.places.id], ['testville-osm-divisions', 'testville-osm-places']);
  assert.ok(requests.divisions.query.includes('relation["boundary"="administrative"]["admin_level"~"^(8|9)$"](44.95,9.9,45.05,10.1);'));
  assert.deepEqual(requests.places.query.match(/^ {2}(node|way|relation)\["place"~"\^\(suburb\|quarter\)\$"\]\["name"\]/gm).length, 3);
  assert.deepEqual(requestsOf(asking, frames), requests);
  assert.throws(() => requestsOf({ ...spec, divisions: { level: 8, from: 'ohm' } }, frames), /divisions: "from" is "osm"/);
  assert.throws(() => requestsOf({ ...spec, places: { from: 'ohm' } }, frames), /places: "from" is "osm"/);
  assert.throws(() => requestsOf({ ...spec, places: { kinds: ['capital'] } }, frames), /not a kind of place/);
  assert.throws(() => requestsOf({ ...spec, streets: { from: 'atlas' } }, frames), /"osm", "ohm" or "natural-earth"/);
  assert.throws(() => requestsOf({ ...spec, streets: { from: 'natural-earth', classes: ['trunk'] } }, frames), /no road class "trunk"/);
  // The streets of OpenStreetMap are asked as before.
  assert.equal(requestsOf({ ...spec, streets: { view: 'metro' } }, frames).streets.query, '[out:json][timeout:240];\n(\n  way["highway"~"^(motorway|trunk|primary)$"](44.95,9.9,45.05,10.1);\n);\nout geom;\n');
});

/** A download put into a cache as the pipeline keeps it, so that an offline build reads it. */
function cached(cache, id, keyText, ext, data, url) {
  const dir = join(cache, `${id}-${sha256(keyText).slice(0, 12)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `data.${ext}`), data);
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id, url, bytes: data.length, sha256: sha256(data), fetched: '2026-01-01' }));
}

test('build: a spec with divisions, places and roads of Natural Earth writes them, credits OpenStreetMap, and one without them does not', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cities-'));
  const log = console.log;
  console.log = () => {};
  try {
    mkdirSync(join(root, 'cities'));
    const cache = join(root, 'cache');
    const views = { metro: [ll([-3000, -2000]).lon, ll([-3000, -2000]).lat, ll([2000, 2000]).lon, ll([2000, 2000]).lat].map((v) => Math.round(v * 1e5) / 1e5) };
    const spec = { city: 'testville', name: 'Testville', centre: [10, 45], views, divisions: { view: 'metro', level: 8 }, places: { view: 'metro' }, streets: { view: 'metro', from: 'natural-earth' } };
    const requests = requestsOf(spec, framesOf(spec));
    const answer = (elements) => Buffer.from(JSON.stringify({ version: 0.6, osm3s: { timestamp_osm_base: '2026-01-01T00:00:00Z' }, elements }));
    cached(cache, requests.divisions.id, `overpass-osm\ndata=${encodeURIComponent(requests.divisions.query)}`, 'json', answer(divisionsAnswer()), 'https://overpass.example/');
    cached(cache, requests.places.id, `overpass-osm\ndata=${encodeURIComponent(requests.places.query)}`, 'json', answer([{ type: 'node', id: 7, tags: { place: 'suburb', name: 'Northside' }, ...ll([500, 1000]) }]), 'https://overpass.example/');
    const url = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v${NATURAL_EARTH_VERSION}/geojson/ne_10m_roads.geojson`;
    cached(cache, 'ne-10m-roads', `${url}\n`, 'geojson', readFileSync(roadsFile(root)), url);
    writeFileSync(join(root, 'cities', 'testville.json'), stringify(spec));
    assert.equal(await run(['testville', '--offline'], { root }), 0);
    const layers = JSON.parse(readFileSync(join(root, 'testville', 'layers.json'), 'utf8'));
    assert.deepEqual(Object.keys(layers.city), ['streets', 'divisions', 'divisionBorders', 'places']);
    assert.deepEqual([layers.city.divisions.map((d) => d.id), layers.city.places.map((p) => p.id), layers.city.streets.map((s) => s.ref)], [['west', 'east'], ['northside'], ['E1 A1', 'N5']]);
    const sources = readFileSync(join(root, 'testville', 'SOURCES.md'), 'utf8');
    assert.ok(sources.includes('© OpenStreetMap contributors') && sources.includes('| `city.divisions` | OpenStreetMap |') && sources.includes('| `city.places` | OpenStreetMap |') && sources.includes('| `city.streets` | Natural Earth | roads of Natural Earth'));
    const lock = JSON.parse(readFileSync(join(root, 'testville', 'sources.lock.json'), 'utf8'));
    assert.deepEqual(lock.downloads.map((d) => [d.id, d.source, d.dataDate]), [['ne_10m_roads', 'natural-earth', NATURAL_EARTH_VERSION], ['testville-osm-divisions', 'osm', '2026-01-01'], ['testville-osm-places', 'osm', '2026-01-01']]);
    // Without them, nothing of theirs is asked, read or written.
    const { divisions: _d, places: _p, streets: _s, ...plain } = spec;
    writeFileSync(join(root, 'cities', 'testville.json'), stringify(plain));
    assert.equal(await run(['testville', '--offline'], { root }), 0);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'testville', 'layers.json'), 'utf8')).city, {});
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'testville', 'sources.lock.json'), 'utf8')).downloads, []);
  } finally {
    console.log = log;
    rmSync(root, { recursive: true, force: true });
  }
});
