// The example city as it is committed, and what a scene makes of it with map.ts: sound outlines,
// epochs in step, and outlines that fit a stage. Nothing is downloaded and no cache is read.
//
//   node --test "test/*.test.*"

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { crosses, type Point } from '../lib/geom.mjs';
import { faultsOf, fitView, linesOnStage, loadLayers, morphOnStage, ringsOnStage, toFrame, type Layers } from '../map.ts';

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
