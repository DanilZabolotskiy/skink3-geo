// The example city as it is committed, and what a scene makes of it with map.ts: sound outlines,
// epochs in step, and outlines that fit a stage. Nothing is downloaded and no cache is read.
//
//   node --test "test/*.test.*"

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { area, crosses, pointInRing, type Point } from '../lib/geom.mjs';
import { faultsOf, fitView, linesOnStage, loadLayers, morphOnStage, ringsInTiles, ringsOnStage, toFrame, type Layers } from '../map.ts';

const here = (path: string): URL => new URL(`../examples/${path}`, import.meta.url);
const town = (): Layers => loadLayers(here('valletta/layers.json'));

test('example: the city has its spec, its layers, its sources and its lock', () => {
  const spec = JSON.parse(readFileSync(here('cities/valletta.json'), 'utf8')) as { city: string };
  assert.equal(spec.city, 'valletta');
  assert.ok(existsSync(here('valletta/layers.json')));
  assert.match(readFileSync(here('valletta/SOURCES.md'), 'utf8'), /## Credits for the description of a film/);
  const lock = JSON.parse(readFileSync(here('valletta/sources.lock.json'), 'utf8')) as { downloads: { id: string; sha256: string; licence: string; request: string }[] };
  assert.ok(lock.downloads.length > 0);
  for (const d of lock.downloads) assert.match(d.sha256, /^[0-9a-f]{64}$/, d.id);
  // The lock holds requests, never a key or a path of the machine that built it.
  for (const d of lock.downloads) assert.doesNotMatch(d.request, /\\|Users\/|[?&](key|token|api_key)=/i, d.id);
});

test('example: every outline runs counter-clockwise, does not cross itself and lies in its frame; the epochs are in step', () => {
  const l = town();
  assert.equal(l.id, 'valletta');
  assert.deepEqual(faultsOf(l), []);
  const epochs = l.city.epochs ?? [];
  assert.deepEqual(epochs.map((e) => e.year), [1975, 2020]);
  assert.ok(epochs[1]!.areaHa > epochs[0]!.areaHa);
  // An island: the sea is there, and the built-up city of each year with it.
  assert.ok((l.city.water ?? []).length > 0 && (l.city.builtUp ?? []).length === 2 && (l.city.relief?.contours ?? []).length > 0);
});

test('faultsOf: a ring that runs clockwise, one that crosses itself, and epochs out of order are named', () => {
  const l = town();
  const first = l.city.water![0]!;
  const bow: Point[] = [[0, 0], [1000, 1000], [1000, 0], [0, 1000]];
  const bad: Layers = {
    ...l,
    city: {
      ...l.city,
      water: [{ ...first, id: 'turned', ring: [...first.ring].reverse() }],
      islands: [{ id: 'bow', areaHa: 1, ring: bow }],
      epochs: [...l.city.epochs!].reverse(),
    },
  };
  const faults = faultsOf(bad);
  assert.ok(faults.includes('city.water.turned: clockwise'), faults.join('; '));
  assert.ok(faults.some((f) => f.startsWith('city.islands.bow: ')), faults.join('; '));
  assert.ok(faults.includes('city.epochs: not in the order of their years'), faults.join('; '));
});

test('example: it fits a stage: outlines of at most 200 points that do not cross, and a morph point for point', () => {
  const l = town();
  const stage = { w: 1920, h: 1080 };
  for (const [name, box] of Object.entries(l.frames.city.views)) {
    const view = fitView(box, stage);
    // The view fills the stage: its box has the stage's shape and lies inside the box asked for.
    assert.ok(Math.abs((view.box[2] - view.box[0]) / (view.box[3] - view.box[1]) - 16 / 9) < 1e-9, name);
    assert.ok(view.box[0] >= box[0] - 1e-6 && view.box[2] <= box[2] + 1e-6 && view.box[1] >= box[1] - 1e-6 && view.box[3] <= box[3] + 1e-6, name);
    const water = ringsOnStage(view, (l.city.water ?? []).map((f) => f.ring));
    assert.ok(water.length > 0, name);
    for (const ring of water) {
      assert.ok(ring.length >= 3 && ring.length <= 200 && !crosses(ring, true), name);
      assert.ok(ring.every((p) => Math.abs(p[0]) <= 960 + 121 && Math.abs(p[1]) <= 540 + 121), name);
    }
    const contours = linesOnStage(view, (l.city.relief?.contours ?? []).flatMap((c) => c.lines));
    for (const line of contours) assert.ok(line.length >= 2 && line.length <= 200, name);
    const [from, to] = [l.city.epochs![0]!, l.city.epochs![1]!];
    const morph = morphOnStage(view, from, to);
    assert.equal(morph.at(0.5).length, morph.from.length);
    assert.deepEqual(morph.at(0), morph.from);
    assert.deepEqual(morph.at(1), morph.to);
  }
  // The whole box shown: nothing of it is cropped.
  const whole = fitView(l.frames.city.box, stage, { mode: 'contain' });
  assert.ok(whole.box[0] <= l.frames.city.box[0] + 1e-6 && whole.box[3] >= l.frames.city.box[3] - 1e-6);
  // The centre of the frame is the middle of the plane, and the city stands in its region where its centre is.
  const [x, y] = toFrame(l.frames.city)(l.frames.city.centre);
  assert.ok(Math.hypot(x, y) < 1e-6);
  const at = toFrame(l.frames.region!)(l.frames.city.centre);
  assert.ok(Math.hypot(at[0] - l.region!.city.at[0], at[1] - l.region!.city.at[1]) < 1);
});

test('example: its terrain is the land with its ground in bands, and fits a stage in tiles that keep its detail', () => {
  const l = town();
  const t = l.city.terrain!;
  assert.equal(t.view, 'wide');
  assert.deepEqual(t.box, l.frames.city.views.wide);
  // Two large islands and the small ones between and beside them; the ground of the largest in every band.
  assert.ok(t.land.length >= 3 && t.land[0]!.areaHa > 20000 && t.land[1]!.areaHa > 5000);
  assert.deepEqual(t.levels, [25, 50, 100, 200]);
  assert.deepEqual([...new Set(t.bands.map((b) => b.band))].sort(), [1, 2, 3, 4]);
  assert.deepEqual([t.lakes, t.rivers], [[], []]);
  // Every band lies on the land: a place of each is inside one of the islands.
  for (const b of t.bands) assert.ok(t.land.some((f) => pointInRing(b.ring[0]!, f.ring)), b.id);
  const view = fitView(l.frames.city.views.wide!, { w: 1920, h: 1080 });
  const island = t.land[0]!.ring;
  // As one outline the coast of the island is thinned to 200 points at most; in tiles every piece keeps to that limit,
  // together they hold more of the coast, and they are the island.
  const pieces = ringsInTiles(view, [island]);
  assert.ok(pieces.length > 1);
  for (const piece of pieces) assert.ok(piece.length >= 3 && piece.length <= 200 && !crosses(piece, true));
  assert.ok(pieces.reduce((n, piece) => n + piece.length, 0) > ringsOnStage(view, [island])[0]!.length);
  const onStage = area(island) * view.scale * view.scale;
  const covered = pieces.reduce((sum, piece) => sum + area(piece), 0);
  // The pieces overlap by a hair along the tiles, so they cover a little more than the island.
  assert.ok(covered > onStage * 0.995 && covered < onStage * 1.06, `${covered} of ${onStage}`);
  // The pieces of a ring come together, in the order of the rings: the order to paint the bands in holds.
  const first = ringsInTiles(view, [t.bands[0]!.ring]);
  const both = ringsInTiles(view, [t.bands[0]!.ring, t.bands[1]!.ring]);
  assert.deepEqual(both.slice(0, first.length), first);
  for (const b of t.bands) for (const piece of ringsInTiles(view, [b.ring])) assert.ok(piece.length >= 3 && piece.length <= 200, b.id);
  // A ring too rich for a tile is cut again: a rippled circle of 6000 points, 80 km across.
  const rippled: Point[] = Array.from({ length: 6000 }, (_, k) => {
    const a = (k / 6000) * 2 * Math.PI;
    const r = 40000 + 400 * Math.sin(a * 600);
    return [r * Math.cos(a), r * Math.sin(a)] as Point;
  });
  const far = fitView([-50000, -28125, 50000, 28125], { w: 1920, h: 1080 });
  const cut = ringsInTiles(far, [rippled]);
  assert.ok(cut.length > 8);
  for (const piece of cut) assert.ok(piece.length <= 200 && !crosses(piece, true));
  assert.ok(cut.reduce((n, piece) => n + piece.length, 0) > 2000);
  assert.deepEqual(ringsInTiles(far, [rippled]), cut);
});

test('faultsOf: the bands of a terrain out of their order, off their height, or at levels that do not rise are named', () => {
  const l = town();
  const t = l.city.terrain!;
  const [first, second] = [t.bands[0]!, t.bands[1]!];
  const swapped: Layers = { ...l, city: { ...l.city, terrain: { ...t, bands: [second, first, ...t.bands.slice(2)] } } };
  assert.ok(faultsOf(swapped).includes(`city.terrain.bands.${first.id}: larger than the band painted before it`), faultsOf(swapped).join('; '));
  const off: Layers = { ...l, city: { ...l.city, terrain: { ...t, bands: [{ ...first, band: first.band + 1 }, ...t.bands.slice(1)] } } };
  assert.ok(faultsOf(off).includes(`city.terrain.bands.${first.id}: its band is not that of its height`), faultsOf(off).join('; '));
  const flat: Layers = { ...l, city: { ...l.city, terrain: { ...t, levels: [25, 25, 100, 200] } } };
  assert.ok(faultsOf(flat).includes('city.terrain.levels: not in rising order'), faultsOf(flat).join('; '));
  const turned: Layers = { ...l, city: { ...l.city, terrain: { ...t, land: [{ ...t.land[0]!, id: 'turned', ring: [...t.land[0]!.ring].reverse() }] } } };
  assert.ok(faultsOf(turned).includes('city.terrain.land.turned: clockwise'), faultsOf(turned).join('; '));
});

test('loadLayers: a file of another format is refused', () => {

  const dir = mkdtempSync(join(tmpdir(), 'layers-'));
  try {
    const file = join(dir, 'layers.json');
    writeFileSync(file, JSON.stringify({ format: 'something-else/3', id: 'x' }));
    assert.throws(() => loadLayers(file), /is of format something-else\/3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
