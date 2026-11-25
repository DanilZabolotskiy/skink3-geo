// A world map beyond its countries: the whole world round another meridian, a box across the 180th meridian, the sea
// lanes of a shipping network, named places and lines, and the heights and shallows of a relief model; each made from
// collections and grids made here, what each refuses, and that a map asks for each. Nothing is downloaded and no cache
// is read.
//
//   node --test "test/*.test.*"

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fitView, fromFrame, gridOnStage, heightAt, routeAlong, toFrame, worldFaults, type HeightGrid, type Point, type WorldLayers } from '../map.ts';
import { area, crosses, signedArea } from '../lib/geom.mjs';
import { EARTH_RADIUS } from '../lib/project.mjs';
import { arcLength } from '../lib/route.mjs';
import { etopoRequest } from '../lib/sources.mjs';
import { buildWorld, frameCut, stitchSeam, worldFrame } from '../lib/world.mjs';
import { buildHeights, degreesAt, heightsPlan, joinGrids, readEsriAscii, type DegreeGrid } from '../lib/worldheights.mjs';
import { buildLanes, buildWorldFeatures, checkWorldFeatures, laneRank } from '../lib/worldlines.mjs';
import { runWorld, worldSourcesText, worldText } from '../world.mjs';

const RAD = Math.PI / 180;
/** The area of a cell of the sphere between two meridians and two parallels, in km². */
const cellKm2 = (dLon: number, lat0: number, lat1: number): number => ((EARTH_RADIUS / 1000) ** 2 * dLon * RAD * (Math.sin(lat1 * RAD) - Math.sin(lat0 * RAD)));

/**
 * Countries as Natural Earth writes them: AAA and BBB side by side on the equator from 0° to 20° E; DDD from 170° E
 * to 170° W across the 180th meridian, in two pieces parted there whose points along it differ (the east piece has one
 * more, and one a hair off the meridian, as Natural Earth's are); EEE from 40° W to 20° W.
 */
function collection() {
  const feature = (code: string, polys: [number, number][][], label: [number, number]) => ({
    type: 'Feature',
    properties: { ADM0_A3: code, ISO_A3: code, NAME: `Land ${code}`, CONTINENT: 'Nowhere', LABEL_X: label[0], LABEL_Y: label[1] },
    geometry: { type: 'MultiPolygon', coordinates: polys.map((ring) => [[...ring, ring[0]!]]) },
  });
  return {
    countries: {
      features: [
        feature('AAA', [[[0, 0], [10, 0], [10, 10], [0, 10]]], [5, 5]),
        feature('BBB', [[[10, 0], [20, 0], [20, 10], [10, 10]]], [15, 5]),
        feature('DDD', [[[170, -10], [180, -10], [179.9995, 0], [180, 10], [170, 10]], [[-180, -10], [-170, -10], [-170, 10], [-180, 10]]], [175, 0]),
        feature('EEE', [[[-40, 20], [-20, 20], [-20, 30], [-40, 30]]], [-30, 25]),
      ],
    },
  };
}

const asLayers = (built: object): WorldLayers => ({ format: 'world-geo/1', id: 'test', name: 'Test', units: 'metres', ...built }) as WorldLayers;

test('worldFrame: the whole world round another meridian; the pieces parted at 180° made whole, those at the new edge parted', () => {
  const round = buildWorld(collection(), { scale: 110, centre: [180, 0] });
  assert.deepEqual(round.frame.centre, [180, 0]);
  assert.deepEqual(round.made.centre, [180, 0]);
  assert.deepEqual(worldFaults(asLayers(round)), []);
  // The land across the 180th meridian is one ring in the middle of the map, at its true area (thinning aside).
  const ddd = round.countries.find((c) => c.id === 'ddd')!;
  assert.equal(ddd.rings.length, 1);
  assert.ok(Math.abs(ddd.areaKm2 - cellKm2(20, -10, 10)) / cellKm2(20, -10, 10) < 1e-2, `${ddd.areaKm2}`);
  assert.ok(ddd.rings[0]!.every(([x]) => Math.abs(x) < 1.2e6));
  // Round 0° it is two pieces, one at each edge; so is EEE round 150° E, whose edge is the meridian 30° W through it.
  const zero = buildWorld(collection(), { scale: 110 });
  assert.equal(zero.countries.find((c) => c.id === 'ddd')!.rings.length, 2);
  const other = buildWorld(collection(), { scale: 110, centre: [150, 0] });
  assert.deepEqual(worldFaults(asLayers(other)), []);
  const eee = other.countries.find((c) => c.id === 'eee')!;
  assert.equal(eee.rings.length, 2);
  assert.ok(Math.abs(eee.areaKm2 - cellKm2(20, 20, 30)) / cellKm2(20, 20, 30) < 1e-2, `${eee.areaKm2}`);
  // A place goes where the map puts it, and comes back: the 180th meridian runs down the middle.
  const to = toFrame(round.frame);
  assert.ok(Math.abs(to([180, 0])[0]) < 1e-6 && Math.abs(to([-180, 0])[0]) < 1e-6);
  assert.ok(to([170, 0])[0] < 0 && to([-170, 0])[0] > 0);
  const back = fromFrame(round.frame)(to([-170, 5]));
  assert.ok(Math.abs(back[0] + 170) < 1e-9 && Math.abs(back[1] - 5) < 1e-9);
  // The edge of the world and the box are those of a world round 0°.
  assert.deepEqual(round.frame.box, zero.frame.box);
  assert.deepEqual(round.frame.outline, zero.frame.outline);
});

test('worldFrame: a box across the 180th meridian, its west east of its east, holds the land there whole', () => {
  const built = buildWorld(collection(), { scale: 10, bbox: [165, -15, -165, 15] });
  assert.equal(built.frame.projection, 'laea');
  assert.deepEqual(built.frame.centre, [180, 0]);
  assert.deepEqual(built.frame.lonlat, [165, -15, -165, 15]);
  assert.deepEqual(worldFaults(asLayers(built)), []);
  assert.deepEqual(built.countries.map((c) => c.id), ['ddd']);
  assert.equal(built.countries[0]!.rings.length, 1);
  // The box is as wide as it is tall, round the middle of the plane.
  const [x0, y0, x1, y1] = built.frame.box;
  assert.ok(Math.abs(x0 + x1) <= 2 && Math.abs(y0 + y1) <= 2 && Math.abs((x1 - x0) - (y1 - y0)) / (y1 - y0) < 0.02, JSON.stringify(built.frame.box));
  assert.throws(() => worldFrame({ bbox: [10, 0, 5, 5] }), /spans 180° of longitude at most, and \[10,0,5,5\] spans 355°: is it west and east the wrong way round/);
  assert.throws(() => worldFrame({ bbox: [10, 0, 10, 5] }), /west and east from -180 to 180 and apart/);
  assert.throws(() => worldFrame({ centre: [10, 5] }), /centred on a meridian, \[lon, 0\]/);
  assert.throws(() => worldFrame({ centre: [200, 0] }), /centred on a meridian/);
});

test('stitchSeam: pieces that meet along a meridian are joined into one ring; rings away from it are kept as they are', () => {
  const east: [number, number][] = [[-10, -10], [0, -10], [0, 0], [0, 10], [-10, 10]];
  const west: [number, number][] = [[0.004, -10], [10, -10], [10, 10], [0, 10]];
  const away: [number, number][] = [[20, 20], [30, 20], [30, 30]];
  const out = stitchSeam([east, west, away], 0);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], away);
  assert.ok(Math.abs(area(out[1]!) - 400) < 0.1 && signedArea(out[1]!) > 0 && !crosses(out[1]!, true), JSON.stringify(out[1]));
  assert.deepEqual(stitchSeam([away], 0), [away]);
  // The opt-in frame of a world round 0° and of a box that does not cross takes a ring as it is.
  const ring: [number, number][] = [[1, 1], [2, 1], [2, 2]];
  assert.deepEqual(frameCut(worldFrame().frame).rings(ring), [ring]);
  assert.deepEqual(frameCut(worldFrame({ bbox: [0, 0, 5, 5] }).frame).rings(ring), [ring]);
});

test('worldFrame: opt-in: no centre is a world round 0°, built as before', () => {
  const plain = buildWorld(collection(), { scale: 110 });
  assert.equal(worldText(buildWorld(collection(), { scale: 110, centre: [0, 0] })), worldText(plain));
  assert.equal(plain.made.centre, undefined);
  assert.deepEqual(plain.frame.centre, [0, 0]);
});

/**
 * A shipping network as its links come, each in one direction: a link given both ways, links that run on one into
 * the next, a junction of three, a named strait, and a link across the 180th meridian.
 */
function network() {
  const link = (coords: [number, number][], freq: number, name = '') => ({ type: 'Feature', properties: { 'Route Freq': freq, Name0: name }, geometry: { type: 'LineString', coordinates: coords } });
  return {
    features: [
      link([[0, 0], [5, 0]], 120),
      link([[5, 0], [0, 0]], 30),
      link([[5, 0], [10, 0]], 200),
      link([[10, 0], [10, 5]], 5),
      link([[10, 0], [15, 0]], 150),
      link([[15, 0], [20, 0]], 150, 'Strait'),
      link([[176, 0], [-176, 0]], 0),
    ],
  };
}

test('buildLanes: links given both ways are one, links of one rank and name that run on are one lane, the busiest first', () => {
  assert.deepEqual([0, 1, 9, 10, 99, 100, 150000].map(laneRank), [0, 1, 1, 2, 2, 3, 6]);
  const { frame } = worldFrame();
  const lanes = buildLanes(network(), frame, { detail: 1 });
  assert.deepEqual(lanes.map((l) => [l.id, l.rank, l.name ?? '', l.lines.length]), [
    ['lane-0', 3, '', 1],
    ['lane-1', 3, '', 1],
    ['lane-2', 3, 'Strait', 1],
    ['lane-3', 1, '', 1],
    ['lane-4', 0, '', 2],
  ]);
  // The link both ways (150 routes) ran on into the next (200): one lane from 0° to 10°, through the junction at 5°.
  const to = toFrame(frame);
  assert.deepEqual(lanes[0]!.lines[0], [to([0, 0]), to([10, 0])].map(([x, y]) => [Math.round(x), Math.round(y)]));
  // Round 0° the link across the 180th meridian is two pieces, one at each edge; round 180° it is one.
  const across = buildLanes(network(), worldFrame({ centre: [180, 0] }).frame, { detail: 1 }).find((l) => l.rank === 0)!;
  assert.equal(across.lines.length, 1);
  // A box keeps the lanes that come into it, cut to its edge.
  const box = worldFrame({ bbox: [2, -3, 8, 3] }).frame;
  const inBox = buildLanes(network(), box, { detail: 1 });
  assert.deepEqual(inBox.map((l) => l.rank), [3]);
  assert.ok(inBox[0]!.lines[0]!.every(([x, y]) => x >= box.box[0] && x <= box.box[2] && y >= box.box[1] && y <= box.box[3]));
  // The lanes meet where their links met: a route runs along them from one end of the network to the other.
  const way = routeAlong(lanes.flatMap((l) => l.lines), to([0, 0]), to([20, 0]));
  assert.ok(Math.abs(way.length - (to([20, 0])[0] - to([0, 0])[0])) < 5, `${way.length}`);
  assert.deepEqual(worldFaults(asLayers({ ...buildWorld(collection(), { scale: 110 }), lanes })), []);
});

/** Natural Earth's ports and airports, as its collections hold them: two ports of one name, an airport by its code. */
function points() {
  const point = (properties: Record<string, unknown>, at: [number, number]) => ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: at } });
  return {
    ports: { features: [point({ name: 'Harbour' }, [4, 2]), point({ name: 'Bay' }, [16, 8]), point({ name: 'Bay' }, [-30, 25])] },
    airports: { features: [point({ name: 'Field Intl', iata_code: 'FLD' }, [8, 6])] },
  };
}

test('buildWorldFeatures: places by hand, ports and airports of Natural Earth; lines mapped, drawn through places, or great circles', () => {
  const { frame } = worldFrame({ bbox: [-2, -2, 22, 12] });
  const spec = {
    places: [
      { id: 'harbour', port: 'Harbour' },
      { id: 'bay', port: 'Bay', near: [15, 7] as [number, number] },
      { id: 'field', airport: 'fld', name: 'The field' },
      { id: 'mark', name: 'A mark', at: [12, 1] as [number, number] },
      { id: 'far', name: 'Far away', at: [60, 40] as [number, number] },
    ],
    lines: [
      { id: 'flight', name: 'A flight', from: { great: ['field', 'bay'] as [string, string] }, step: 0.5, source: 'The great circle between two places.' },
      { id: 'voyage', name: 'A voyage', from: { through: ['harbour', 'mark', [18, 4]] as (string | [number, number])[] }, source: 'Drawn after a written account.' },
      { id: 'road', name: 'A road', from: { osm: ['way/1', 'way/2'] }, source: 'Mapped ways.' },
    ],
  };
  const mapped = { road: [[[2, 9], [6, 9]], [[10, 9], [6, 9]]] as [number, number][][] };
  const built = buildWorldFeatures(spec, frame, { ...points(), mapped, detail: 100 });
  assert.deepEqual(built.places.map((p) => [p.id, p.name, p.kind, p.lonlat]), [
    ['harbour', 'Harbour', 'port', [4, 2]],
    ['bay', 'Bay', 'port', [16, 8]],
    ['field', 'The field', 'airport', [8, 6]],
    ['mark', 'A mark', 'place', [12, 1]],
    ['far', 'Far away', 'place', [60, 40]],
  ]);
  const to = toFrame(frame);
  assert.deepEqual(built.places[2]!.at, to([8, 6]).map((v) => Math.round(v)));
  const [flight, voyage, road] = built.lines;
  assert.deepEqual([flight!.kind, voyage!.kind, road!.kind], ['great', 'drawn', 'mapped']);
  assert.equal(voyage!.approximate, true);
  assert.ok(flight!.approximate === undefined && road!.approximate === undefined);
  assert.ok(Math.abs(flight!.lengthKm - arcLength([8, 6], [16, 8]) / 1000) < 0.1, `${flight!.lengthKm}`);
  assert.deepEqual([flight!.lines[0]![0], flight!.lines[0]!.at(-1)], [built.places[2]!.at, built.places[1]!.at]);
  assert.equal(voyage!.source, 'Drawn after a written account.');
  // The two ways of the road meet end to end: one line of 8° of the parallel 9° N.
  assert.equal(road!.lines.length, 1);
  assert.ok(Math.abs(road!.lengthKm - (8 * 111.195 * Math.cos(9 * RAD))) < 1, `${road!.lengthKm}`);
  assert.deepEqual(worldFaults(asLayers({ ...buildWorld(collection(), { scale: 10, bbox: [-2, -2, 22, 12] }), ...built })), []);
  // What it refuses: two ports of one name without "near", a name Natural Earth has not, a line off the map.
  assert.throws(() => buildWorldFeatures({ places: [{ id: 'bay', port: 'Bay' }] }, frame, { ...points(), detail: 1 }), /2 ports "Bay".*give "near"/);
  assert.throws(() => buildWorldFeatures({ places: [{ id: 'x', airport: 'ZZZ' }] }, frame, { ...points(), detail: 1 }), /no airport "ZZZ"/);
  assert.throws(() => buildWorldFeatures({ places: [{ id: 'x', port: 'Harbour' }] }, frame, { detail: 1 }), /ports of Natural Earth were not read/);
  assert.throws(() => buildWorldFeatures({ lines: [{ id: 'off', name: 'Off', from: { through: [[60, 40], [70, 45]] }, source: 'x' }] }, frame, { detail: 1 }), /no part of it lies on the map/);
});

test('checkWorldFeatures: what a features file may hold', () => {
  const ok = { places: [{ id: 'a', name: 'A', at: [1, 2] }], lines: [{ id: 'l', name: 'L', from: { through: ['a', [3, 4]] }, source: 'S.' }] };
  checkWorldFeatures(ok);
  const bad: [unknown, RegExp][] = [
    [[], /a features file is \{ places, lines \}/],
    [{ roads: [] }, /no key "roads"/],
    [{ places: [{ id: 'A', at: [1, 2], name: 'A' }] }, /its id is lower-case/],
    [{ places: [{ id: 'a', at: [1, 2], name: 'A' }, { id: 'a', at: [1, 2], name: 'B' }] }, /given twice/],
    [{ places: [{ id: 'a', at: [1, 2] }] }, /a place given by hand has a name/],
    [{ places: [{ id: 'a', at: [1, 2], port: 'P', name: 'A' }] }, /given one way/],
    [{ places: [{ id: 'a', port: 'P', colour: 'red' }] }, /no key "colour"/],
    [{ places: [{ id: 'a', at: [200, 2], name: 'A' }] }, /"at" is \[lon, lat\]/],
    [{ lines: [{ id: 'l', name: 'L', from: { through: ['a', [3, 4]] } }] }, /it names its source/],
    [{ lines: [{ id: 'l', name: 'L', from: { through: ['nowhere', [3, 4]] }, source: 'S.' }] }, /no place "nowhere"/],
    [{ lines: [{ id: 'l', name: 'L', from: { osm: ['node/1'] }, source: 'S.' }] }, /way\/<id> and relation\/<id>/],
    [{ lines: [{ id: 'l', name: 'L', from: { great: [[1, 2]] }, source: 'S.' }] }, /two places, the ends of the great circle/],
    [{ lines: [{ id: 'l', name: 'L', from: { through: [[1, 2], [3, 4]] }, step: 1, source: 'S.' }] }, /"step" is the degrees of arc/],
    [{ lines: [{ id: 'l', name: 'L', from: { drawn: [] }, source: 'S.' }] }, /not "drawn"/],
  ];
  for (const [spec, why] of bad) assert.throws(() => checkWorldFeatures(spec), why, JSON.stringify(spec));
});

/** A relief model in degrees from 10° S to 10° N and 10° W to 10° E, every half degree: a round island, 1000 m high, whose shore is 5° from its middle; the sea floor falls 200 m a degree beyond it. */
function island(): DegreeGrid {
  const [cols, rows, cell] = [41, 41, 0.5];
  const values = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) values[r * cols + c] = 1000 - 200 * Math.hypot(-10 + c * cell, 10 - r * cell);
  return { cols, rows, west: -10, south: -10, cell, values };
}

test('buildHeights: a relief model on the plane of a map, its heights and depths, and the shallows above a depth as regions', () => {
  const { frame } = worldFrame({ bbox: [-8, -8, 8, 8] });
  const { heights, shallows } = buildHeights(island(), frame, { cell: 20000, detail: 500, shallows: [100, 200] });
  assert.equal(heights.cell, 20000);
  assert.equal(heights.values.length, heights.cols * heights.rows);
  assert.equal(heights.box[2] - heights.box[0], (heights.cols - 1) * heights.cell);
  // The middle is the island's top; a corner of the box, near 8° from the middle along both axes, is deep sea.
  const middle = heightAt(heights as HeightGrid, [0, 0])!;
  assert.ok(Math.abs(middle - 1000) < 50, `${middle}`);
  assert.ok(heights.values[0]! < -1000);
  // The ground above 200 m below the sea: one ring 6° round the middle, counter-clockwise, at about its true area.
  assert.deepEqual(shallows.map((s) => [s.id, s.depth, s.rings.length, s.holes.length]), [['shallows-100', 100, 1, 0], ['shallows-200', 200, 1, 0]]);
  const want = Math.PI * (6 * 111.195) ** 2;
  const got = area(shallows[1]!.rings[0]!) / 1e6;
  assert.ok(Math.abs(got - want) / want < 0.03, `${got} against ${want}`);
  assert.ok(area(shallows[0]!.rings[0]!) < area(shallows[1]!.rings[0]!));
  const layers = asLayers({ ...buildWorld(collection(), { scale: 10, bbox: [-8, -8, 8, 8] }), heights, shallows });
  assert.deepEqual(worldFaults(layers), []);
  // A relief of the land alone: below the floor the grid is flat at it; without a floor it is as it was.
  const view = fitView(heights.box, { w: 1920, h: 1080 }, { mode: 'contain' });
  const land = gridOnStage(view, heights as HeightGrid, { floor: 0 });
  const all = gridOnStage(view, heights as HeightGrid);
  assert.ok(Math.min(...land.heights.values) === 0 && Math.min(...all.heights.values) < -1000);
  assert.deepEqual(land.heights.values.map((v, k) => (v > 0 ? v : all.heights.values[k]! > 0 ? NaN : 0)), all.heights.values.map((v) => Math.max(0, v)));
  assert.throws(() => gridOnStage(view, heights as HeightGrid, { floor: Number.NaN }), /"floor" is a height/);
  assert.throws(() => buildHeights(island(), frame, { cell: 20000, detail: 500, shallows: [-5] }), /a depth of the shallows/);
});

test('the relief model: an Esri ASCII grid read, a grid of the whole Earth read round, and what a map asks of it', () => {
  const text = 'ncols 3\nnrows 2\nxllcenter -180\nyllcenter 0\ncellsize 180\nnodata_value -9999\n1 2 3\n4 5 6\n';
  const g = readEsriAscii(text);
  assert.deepEqual([g.cols, g.rows, g.west, g.south, g.cell, [...g.values]], [3, 2, -180, 0, 180, [1, 2, 3, 4, 5, 6]]);
  // The top row is the north: 180° N... and the grid round the Earth meets itself at 180°.
  assert.equal(degreesAt(g, [-180, 180]), 1);
  assert.equal(degreesAt(g, [0, 0]), 5);
  assert.equal(degreesAt(g, [-90, 90]), 3);
  assert.throws(() => readEsriAscii(text.replace('6\n', '-9999\n')), /no height at its sample 5/);
  assert.throws(() => readEsriAscii('ncols 3\n1 2 3\n'), /not an Esri ASCII grid/);
  assert.throws(() => readEsriAscii(text.replace('6\n', '')), /holds 5 heights, not 3 by 2/);
  // A whole world: all of the model, a sample every quarter degree for a cell of 57 km.
  assert.deepEqual(heightsPlan(worldFrame().frame), { cell: 57000, stride: 15, boxes: [[-180, -90, 180, 90]] });
  // A box on one side of 180°: one part, on the model's own samples, a little wider than the box.
  const atlantic = heightsPlan(worldFrame({ bbox: [-40, 10, -20, 30] }).frame, 20000);
  assert.equal(atlantic.stride, 5);
  assert.equal(atlantic.boxes.length, 1);
  const [aw, as, ae, an] = atlantic.boxes[0]!;
  assert.ok(aw < -40 && aw > -45 && ae > -20 && ae < -15 && as < 10 && an > 30, JSON.stringify(atlantic.boxes));
  for (const v of [aw, ae]) assert.ok(Math.abs(((v + 180) * 60) / 5 - Math.round(((v + 180) * 60) / 5)) < 1e-9, `${v} is not on a sample`);
  // A box across 180°: two parts that meet on it, each a request of its own.
  const pacific = heightsPlan(worldFrame({ bbox: [170, -10, -170, 10] }).frame, 5000);
  assert.equal(pacific.stride, 1);
  const [west, east] = pacific.boxes;
  assert.ok(west![0] >= 160 && west![0] < 170 && west![2] === 180 && east![0] === -180 && east![2] > -170 && east![2] < -160, JSON.stringify(pacific.boxes));
  assert.deepEqual([west![1], west![3]], [east![1], east![3]]);
  for (const box of pacific.boxes) assert.match(etopoRequest(box, 1).url, /^https:\/\/coastwatch\.pfeg\.noaa\.gov\/erddap\/griddap\/etopo180\.esriAscii\?altitude%5B\(-1?\d(\.\d+)?\):1:\(/);
  assert.equal(etopoRequest([-10, -5, 10, 5], 15).url, 'https://coastwatch.pfeg.noaa.gov/erddap/griddap/etopo180.esriAscii?altitude%5B(-5):15:(5)%5D%5B(-10):15:(10)%5D');
  assert.throws(() => etopoRequest([-10, -5, 10, 5], 0), /whole minutes from 1 to 60/);
  assert.throws(() => etopoRequest([10, -5, -10, 5], 15), /bad box/);
  assert.throws(() => etopoRequest([170, -5, 190, 5], 15), /bad box/);
  assert.throws(() => heightsPlan(worldFrame().frame, 10), /100 or more/);
});

test('joinGrids: the two parts of a box across 180° read as one grid, a longitude named either way round', () => {
  // The west part ends on 180°, the east begins on -180°: the same column, kept once.
  const west = readEsriAscii('ncols 3\nnrows 2\nxllcenter 178\nyllcenter 0\ncellsize 1\n1 2 3\n4 5 6\n');
  const east = readEsriAscii('ncols 3\nnrows 2\nxllcenter -180\nyllcenter 0\ncellsize 1\n3 7 8\n6 9 10\n');
  const g = joinGrids(west, east);
  assert.deepEqual([g.cols, g.rows, g.west, g.south, g.cell, [...g.values]], [5, 2, 178, 0, 1, [1, 2, 3, 7, 8, 4, 5, 6, 9, 10]]);
  assert.equal(degreesAt(g, [-179, 1]), 7);
  assert.equal(degreesAt(g, [181, 1]), 7);
  assert.equal(degreesAt(g, [-178.5, 0]), 9.5);
  assert.equal(degreesAt(g, [179, 0]), 5);
  // Parts that meet a sample apart are laid side by side whole.
  const next = readEsriAscii('ncols 2\nnrows 2\nxllcenter -179\nyllcenter 0\ncellsize 1\n7 8\n9 10\n');
  assert.deepEqual([...joinGrids(west, next).values], [1, 2, 3, 7, 8, 4, 5, 6, 9, 10]);
  assert.throws(() => joinGrids(west, readEsriAscii('ncols 2\nnrows 2\nxllcenter -170\nyllcenter 0\ncellsize 1\n7 8\n9 10\n')), /do not meet \(the west ends at 180°, the east begins at -170°\)/);
  assert.throws(() => joinGrids(west, readEsriAscii('ncols 2\nnrows 3\nxllcenter -179\nyllcenter 0\ncellsize 1\n7 8\n9 10\n1 1\n')), /row for row/);
});

test('worldFaults: what is wrong with the layers beyond the countries is named', () => {
  const base = buildWorld(collection(), { scale: 10, bbox: [-2, -2, 22, 12] });
  const line: Point[] = [toFrame(base.frame)([1, 1]), toFrame(base.frame)([3, 1])];
  const lanes = [{ id: 'lane-0', rank: 1, lines: [line] }, { id: 'lane-1', rank: 4, lines: [line] }];
  assert.match(worldFaults(asLayers({ ...base, lanes })).join('\n'), /lanes\.lane-1: of a higher rank than the lane before it/);
  const lines = [{ id: 'l', name: 'L', kind: 'great', approximate: true, source: 'S.', lengthKm: 10, lines: [line] }];
  assert.match(worldFaults(asLayers({ ...base, lines })).join('\n'), /lines\.l: a line drawn through places, and it alone, is approximate/);
  const ring: Point[] = [line[0]!, line[1]!, [line[1]![0], line[1]![1] + 1e5]];
  const shallows = [{ id: 'shallows-200', depth: 200, rings: [[...ring].reverse()], holes: [] }, { id: 'shallows-50', depth: 50, rings: [ring], holes: [] }];
  const faults = worldFaults(asLayers({ ...base, shallows })).join('\n');
  assert.match(faults, /shallows\.shallows-200\.0: runs clockwise/);
  assert.match(faults, /shallows\.shallows-50: not deeper than the shallows before it/);
  const heights = { box: [0, 0, 100, 100], cell: 50, cols: 3, rows: 3, values: [1, 2, 3] };
  assert.match(worldFaults(asLayers({ ...base, heights })).join('\n'), /heights: 3 heights, not 3 by 3/);
  const places = [{ id: 'p', name: 'P', kind: 'town', at: [0, 0], lonlat: [0, 0] }];
  assert.match(worldFaults(asLayers({ ...base, places })).join('\n'), /places\.p: no kind "town"/);
});

test('world: the options beyond the countries, what they refuse, and the sources they credit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'world-layers-'));
  const log = console.log;
  console.log = (): void => {};
  try {
    await assert.rejects(runWorld(['--root', root, '--heights-cell', '5000']), /give --heights or --shallows with it/);
    await assert.rejects(runWorld(['--root', root, '--shallows', '200,50']), /from the shallowest down/);
    await assert.rejects(runWorld(['--root', root, '--shallows', '0']), /--shallows must be a number from 1/);
    const file = join(root, 'features.json');
    writeFileSync(file, JSON.stringify({ places: [{ id: 'x' }] }));
    await assert.rejects(runWorld(['--root', root, '--features', file]), /place x: it is given one way/);
    await assert.rejects(runWorld(['--root', root, '--lanes', '--offline']), /not in the cache/);
  } finally {
    console.log = log;
    rmSync(root, { recursive: true, force: true });
  }
  const built = buildWorld(collection(), { scale: 50, centre: [150, 0] });
  const world = {
    name: 'Test',
    ...built,
    made: { ...built.made, lanes: true, heights: { cell: 57000, stride: 15, shallows: [200] } },
    lanes: [{ id: 'lane-0', rank: 1, lines: [] }],
    places: [{ id: 'p', name: 'A port', kind: 'port', lonlat: [4, 2] }],
    lines: [{ id: 'l', name: 'A route', kind: 'drawn', approximate: true, source: 'Drawn after a written account.', lengthKm: 12.5 }],
    heights: {},
    shallows: [{ id: 'shallows-200', depth: 200 }],
  };
  const lock = [
    { id: 'ne_50m_admin_0_countries', source: 'natural-earth', bytes: 1, sha256: 'a'.repeat(64) },
    { id: 'ornl-shipping-lanes', source: 'ornl-lanes', bytes: 1, sha256: 'b'.repeat(64) },
    { id: 'etopo1-15m', source: 'etopo', bytes: 1, sha256: 'c'.repeat(64) },
  ];
  const text = worldSourcesText(world, lock);
  assert.match(text, /centred on the meridian 150°/);
  assert.match(text, /Sea lanes: Global Shipping Lane Network, Oak Ridge National Laboratory\./);
  assert.match(text, /Heights and depths: ETOPO1/);
  assert.match(text, /\| `places`: `p` \| Natural Earth 5\.1\.2, 1:10m ports \| A port, at 4, 2 \|/);
  assert.match(text, /\| `lines`: `l` \| drawn through places by hand \| A route \(approximate\), 12\.5 km: Drawn after a written account\. \|/);
  assert.match(text, /a sample every 15 arc-minutes/);
  assert.match(text, /\| `shallows`: `shallows-200` \|/);
  assert.match(text, /may carry this line in its description \(a courtesy/);
  // OpenStreetMap's credit is required: the text says so.
  assert.match(worldSourcesText(world, [...lock, { id: 'x-osm-lines', source: 'osm', bytes: 1, sha256: 'd'.repeat(64) }]), /carries these lines in its description[\s\S]*© OpenStreetMap contributors/);
});
