// The blocks of a city, on made inputs: answers of Overpass shaped as the real ones are, and streets drawn by hand.
// What it builds (the land the streets leave, each street as wide as its class, the squares and the water open, inside
// the city's bounds), what it refuses, how a stage joins blocks across lanes too narrow to see, and that a spec which
// does not ask for blocks builds what it built before.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { framesOf, requestsOf, run, stringify } from '../build.mjs';
import { sha256 } from '../lib/fetch.mjs';
import { area, crosses, pointInRing, signedArea } from '../lib/geom.mjs';
import { BLOCK_CLASSES, blockStreets, buildBlocks, checkBlocks, mergeBlocks } from '../lib/blocks.mjs';
import { projection } from '../lib/project.mjs';
import { blocksOnStage, fitView, faultsOf } from '../map.ts';

const proj = projection({ lon: 10, lat: 45 });
const ll = (p) => {
  const [lon, lat] = proj.inverse(p);
  return { lon, lat };
};
const way = (id, tags, points) => ({ type: 'way', id, tags, geometry: points.map(ll) });

/**
 * A made town of 600 by 600 metres: a primary street across it from west to east, residential streets every 100
 * metres both ways, a lane (a service way) through one block, a square, and a footway, which parts nothing.
 */
function answer() {
  const out = [way(1, { highway: 'primary', name: 'High Street' }, [[-300, 0], [300, 0]])];
  let id = 2;
  for (let x = -300; x <= 300; x += 100) out.push(way(id++, { highway: 'residential' }, [[x, -300], [x, 300]]));
  for (let y = -300; y <= 300; y += 100) if (y !== 0) out.push(way(id++, { highway: 'residential' }, [[-300, y], [300, y]]));
  out.push(way(id++, { highway: 'service' }, [[150, 100], [150, 200]]));
  out.push(way(id++, { highway: 'footway' }, [[-250, -300], [-250, 300]]));
  out.push(way(id++, { place: 'square', name: 'Market' }, [[-180, 120], [-120, 120], [-120, 180], [-180, 180], [-180, 120]]));
  return out;
}

const frame = { proj, box: [-300, -300, 300, 300] };

test('blocks: the land the streets leave, each street as wide as its class, the lanes and the squares open', () => {
  const blocks = buildBlocks({}, frame, { streets: blockStreets({ from: 'osm' }, proj, answer()) });
  // 6 by 6 blocks of 100 metres, one cut in two by its lane: 37. The footway parts nothing.
  assert.equal(blocks.length, 37);
  for (const b of blocks) {
    assert.ok(signedArea(b.ring) > 0 && !crosses(b.ring, true), b.id);
    assert.ok(b.ring.every(([x, y]) => x >= -300 && x <= 300 && y >= -300 && y <= 300), b.id);
  }
  // A block between residential streets (9 m) is about 91 m a side; one along the primary street (18 m) is 4.5 m shorter.
  const at = (x, y) => blocks.find((b) => pointInRing([x, y], b.ring));
  assert.ok(Math.abs(Math.sqrt(area(at(-50, 250).ring)) - 91) < 3, `${area(at(-50, 250).ring)}`);
  assert.ok(area(at(-50, 50).ring) < area(at(-50, 250).ring) - 300);
  // The lane parts its block in two halves; the largest block comes first, the ids follow.
  assert.ok(at(120, 150) && at(180, 150) && at(120, 150) !== at(180, 150));
  assert.deepEqual(blocks.map((b) => b.id).slice(0, 2), ['block-0', 'block-1']);
  assert.ok(blocks[0].areaHa >= blocks[blocks.length - 1].areaHa);
  // A square inside a block is no hole of it: the block keeps its outline (a scene draws the square over it, from
  // city.squares). A square that opens on a street takes its land from the blocks round it.
  const square = [[-180, 120], [-120, 120], [-120, 180], [-180, 180]];
  const open = buildBlocks({}, frame, { streets: blockStreets({ from: 'osm' }, proj, answer()), squares: [square] });
  assert.equal(open.length, 37);
  assert.equal(area(open.find((b) => pointInRing([-190, 150], b.ring)).ring), area(at(-190, 150).ring));
  const onStreet = [[-130, 120], [-70, 120], [-70, 180], [-130, 180]];
  const cut = buildBlocks({}, frame, { streets: blockStreets({ from: 'osm' }, proj, answer()), squares: [onStreet] });
  assert.ok(area(cut.find((b) => pointInRing([-190, 150], b.ring)).ring) < area(at(-190, 150).ring) - 1000);
  // The same inputs give the same blocks.
  assert.equal(JSON.stringify(buildBlocks({}, frame, { streets: blockStreets({ from: 'osm' }, proj, answer()) })), JSON.stringify(blocks));
});

test('blocks: inside the city\'s bounds, without its water, and from streets drawn by hand after a plan', () => {
  const streets = blockStreets({ from: 'osm' }, proj, answer());
  const within = [[-300, -300], [0, -300], [0, 300], [-300, 300]];
  const west = buildBlocks({}, frame, { streets, within });
  assert.ok(west.length === 18 && west.every((b) => b.ring.every(([x]) => x <= 0.1)), `${west.length}`);
  const river = [[-300, -300], [300, -300], [300, -200], [-300, -200]];
  assert.equal(buildBlocks({}, frame, { streets, water: [river] }).length, 31);
  // A plan traced by hand: two streets that cross; the four quarters of the box are the blocks.
  const plan = { lines: [{ points: [[-300, 0], [300, 0]].map((p) => Object.values(ll(p))) }, { class: 'primary', points: [[0, -300], [0, 300]].map((p) => Object.values(ll(p))) }] };
  const quarters = buildBlocks(plan, frame, { streets: blockStreets(plan, proj, []) });
  assert.equal(quarters.length, 4);
  // A coarser raster and a larger least block.
  assert.ok(buildBlocks({ cell: 4, minArea: 9000 }, frame, { streets }).length < 37);
});

test('blocks: what a spec may not say', () => {
  assert.throws(() => checkBlocks({}), /give "from" \(osm or ohm\), or the streets as "lines" drawn by hand/);
  assert.throws(() => checkBlocks({ from: 'atlas' }), /"from" is "osm" or "ohm"/);
  assert.throws(() => checkBlocks({ from: 'osm', year: 1800 }), /"year" picks the streets of OpenHistoricalMap/);
  assert.throws(() => checkBlocks({ from: 'osm', classes: ['bridleway'] }), /the class "bridleway" has no width: give it in "widths"/);
  assert.doesNotThrow(() => checkBlocks({ from: 'osm', classes: ['bridleway'], widths: { bridleway: 3 } }));
  assert.throws(() => checkBlocks({ from: 'osm', within: { ring: [] } }), /"within" is \{ wall: <the id of a wall of the spec> \} or \{ points/);
  assert.throws(() => checkBlocks({ from: 'osm', cell: 0.1 }), /"cell" is 0\.5 to 20 metres/);
  assert.throws(() => checkBlocks({ from: 'osm', streets: true }), /unknown key "streets"/);
  assert.throws(() => checkBlocks({ lines: [{ class: 'alley', points: [[10, 45], [10.1, 45]] }] }), /lines\[0\] is of the class "alley", which has no width/);
  assert.deepEqual(BLOCK_CLASSES.slice(0, 3), ['motorway', 'trunk', 'primary']);
});

test('blocks on the stage: whole outlines in the view, and joined across lanes too narrow to see at that size', () => {
  const blocks = buildBlocks({}, frame, { streets: blockStreets({ from: 'osm' }, proj, answer()) });
  // The town 600 m across shown 300 units wide: a lane of 9 m is 4.5 units, the primary street 9 units.
  const view = fitView([-300, -300, 300, 300], { w: 300, h: 300 });
  const each = blocksOnStage(view, blocks);
  assert.equal(each.length, 37);
  const joined = blocksOnStage(view, blocks, { merge: 6 });
  // Across the residential streets and the lane, not across the primary street: two halves of the town.
  assert.equal(joined.length, 2, `${joined.length}`);
  for (const r of joined) assert.ok(!crosses(r, true) && area(r) > 300 * 150 * 0.8);
  // Wider still, one town.
  assert.equal(blocksOnStage(view, blocks, { merge: 12 }).length, 1);
  // mergeBlocks on its own: two squares 2 units apart, joined by a merge of 3 and not of 1.
  const a = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const b = [[12, 0], [22, 0], [22, 10], [12, 10]];
  assert.equal(mergeBlocks([a, b], { merge: 3 }).length, 1);
  assert.equal(mergeBlocks([a, b], { merge: 1 }).length, 2);
  assert.throws(() => mergeBlocks([a], { merge: 0 }), /merge must be above 0/);
});

/** A download put into a cache as the pipeline keeps it, so that an offline build reads it. */
function cached(cache, id, keyText, data) {
  const dir = join(cache, `${id}-${sha256(keyText).slice(0, 12)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'data.json'), data);
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id, url: 'https://overpass.example/', bytes: data.length, sha256: sha256(data), fetched: '2026-01-01' }));
}

test('build: a spec with blocks asks for its streets and squares, writes them, credits OpenStreetMap; one without them does not', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cities-'));
  const log = console.log;
  console.log = () => {};
  try {
    mkdirSync(join(root, 'cities'));
    const cache = join(root, 'cache');
    const views = { core: [ll([-300, -300]).lon, ll([-300, -300]).lat, ll([300, 300]).lon, ll([300, 300]).lat].map((v) => Math.round(v * 1e6) / 1e6) };
    const spec = { city: 'testville', name: 'Testville', centre: [10, 45], views, blocks: { view: 'core', from: 'osm' } };
    const requests = requestsOf(spec, framesOf(spec));
    assert.deepEqual(Object.keys(requests), ['blocks']);
    assert.ok(requests.blocks.query.includes(`way["highway"~"^(${BLOCK_CLASSES.join('|')})$"]`) && requests.blocks.query.includes('way["place"="square"]'));
    const data = Buffer.from(JSON.stringify({ version: 0.6, osm3s: { timestamp_osm_base: '2026-01-01T00:00:00Z' }, elements: answer() }));
    cached(cache, requests.blocks.id, `overpass-osm\ndata=${encodeURIComponent(requests.blocks.query)}`, data);
    writeFileSync(join(root, 'cities', 'testville.json'), stringify(spec));
    assert.equal(await run(['testville', '--offline'], { root }), 0);
    const layers = JSON.parse(readFileSync(join(root, 'testville', 'layers.json'), 'utf8'));
    assert.deepEqual(Object.keys(layers.city), ['blocks', 'squares']);
    assert.ok(layers.city.blocks.length >= 36 && layers.city.blocks.length <= 38, `${layers.city.blocks.length}`);
    assert.deepEqual(layers.city.squares.map((q) => q.name), ['Market']);
    assert.deepEqual(faultsOf(layers), []);
    const sources = readFileSync(join(root, 'testville', 'SOURCES.md'), 'utf8');
    assert.ok(sources.includes('© OpenStreetMap contributors') && sources.includes('| `city.blocks` | OpenStreetMap |') && sources.includes('| `city.squares` | OpenStreetMap |'));
    // Without them, nothing of theirs is asked, read or written.
    const { blocks: _b, ...plain } = spec;
    writeFileSync(join(root, 'cities', 'testville.json'), stringify(plain));
    assert.equal(await run(['testville', '--offline'], { root }), 0);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'testville', 'layers.json'), 'utf8')).city, {});
  } finally {
    console.log = log;
    rmSync(root, { recursive: true, force: true });
  }
});
