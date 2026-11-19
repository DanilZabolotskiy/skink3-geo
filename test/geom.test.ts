// The plane geometry of the geo pipeline: simplifying without crossings, cutting to a box into whole
// rings, and the equal point counts of a morph.
//
//   node --test "test/*.test.*"

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignTo, area, chaikin, clipLine, clipRing, closeChains, crosses, lengthOf, morphRings, orient, pointInRing, resample, roundPoints, signedArea, simplify, simplifySafe, soften, type Point } from '../lib/geom.mjs';
import { projectBox, projection, unprojectBox } from '../lib/project.mjs';

const square = (x0: number, y0: number, x1: number, y1: number): Point[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/** A circle of `n` points, counter-clockwise from the east. */
const circle = (cx: number, cy: number, r: number, n: number): Point[] => Array.from({ length: n }, (_, k) => [cx + r * Math.cos((2 * Math.PI * k) / n), cy + r * Math.sin((2 * Math.PI * k) / n)]);

test('geom: the area has the sign of the way a ring runs, and orient turns it', () => {
  const ccw = square(0, 0, 4, 2);
  assert.equal(signedArea(ccw), 8);
  assert.equal(signedArea([...ccw].reverse()), -8);
  assert.equal(signedArea(orient([...ccw].reverse(), true)), 8);
  assert.equal(area([...ccw].reverse()), 8);
  assert.equal(lengthOf(ccw, true), 12);
  assert.ok(pointInRing([1, 1], ccw));
  assert.ok(!pointInRing([5, 1], ccw));
});

test('geom: simplify drops the points near the line of their neighbours, and keeps a ring a ring', () => {
  const line: Point[] = [[0, 0], [1, 0.01], [2, -0.01], [3, 0], [3, 3]];
  assert.deepEqual(simplify(line, 0.1), [[0, 0], [3, 0], [3, 3]]);
  const ring = circle(0, 0, 100, 720);
  const cut = simplify(ring, 1, true);
  assert.ok(cut.length < 60 && cut.length >= 8, `${cut.length} points`);
  assert.ok(Math.abs(area(cut) - Math.PI * 1e4) / (Math.PI * 1e4) < 0.03);
  assert.ok(!crosses(cut));
  // A triangle is returned as it is; a ring smaller than the tolerance collapses, and its caller drops it.
  assert.deepEqual(simplify([[0, 0], [1, 0], [0, 1]], 10, true), [[0, 0], [1, 0], [0, 1]]);
  assert.ok(simplify(square(0, 0, 1, 1), 10, true).length < 3);
});

test('geom: crosses finds a figure of eight, a touch, and nothing in a plain ring', () => {
  assert.ok(crosses([[0, 0], [2, 2], [2, 0], [0, 2]]));
  assert.ok(!crosses(square(0, 0, 2, 2)));
  assert.ok(!crosses(circle(0, 0, 50, 300)));
  // An open line that runs back over itself.
  assert.ok(crosses([[0, 0], [4, 0], [4, 2], [2, -2]], false));
  assert.ok(!crosses([[0, 0], [4, 0], [4, 2], [2, 2]], false));
});

test('geom: simplifySafe lowers the tolerance rather than let an outline cross itself', () => {
  // A narrow inlet reaching nearly across: a coarse cut would run the far bank through its tip.
  const ring: Point[] = [[0, 0], [10, 0], [10, 4.4], [1, 4.6], [1, 5], [10, 5.2], [10, 10], [0, 10], [0.4, 5]];
  const coarse = simplify(ring, 0.9, true);
  const safe = simplifySafe(ring, 0.9, true);
  assert.ok(safe);
  assert.ok(!crosses(safe));
  assert.ok(safe.length >= coarse.length);
  // An outline that crosses itself to begin with cannot be made safe.
  assert.equal(simplifySafe([[0, 0], [2, 2], [2, 0], [0, 2]], 0.01, true), null);
});

test('geom: corner cutting rounds a ring inside its corners, and soften never returns a crossing', () => {
  const sq = square(0, 0, 10, 10);
  const round = chaikin(sq, 2, true);
  assert.equal(round.length, 16);
  assert.ok(area(round) < area(sq) && area(round) > 0.8 * area(sq));
  for (const [x, y] of round) assert.ok(x >= 0 && x <= 10 && y >= 0 && y <= 10);
  const open = chaikin([[0, 0], [5, 5], [10, 0]], 1, false);
  assert.deepEqual(open[0], [0, 0]);
  assert.deepEqual(open[open.length - 1], [10, 0]);
  const soft = soften(circle(0, 0, 100, 90), 2, 2, true);
  assert.ok(soft && !crosses(soft));
});

test('geom: resample spaces the points evenly, and a morph gets rings of one count in step', () => {
  const sq = square(0, 0, 10, 10);
  const pts = resample(sq, 40, true);
  assert.equal(pts.length, 40);
  for (let k = 0; k < 40; k++) assert.ok(Math.abs(Math.hypot(pts[(k + 1) % 40]![0] - pts[k]![0], pts[(k + 1) % 40]![1] - pts[k]![1]) - 1) < 1e-9);
  const line = resample([[0, 0], [10, 0]], 5, false);
  assert.deepEqual(line, [[0, 0], [2.5, 0], [5, 0], [7.5, 0], [10, 0]]);

  // A small ring, a larger one running the other way from another start, and a far larger one.
  const rings = [circle(0, 0, 10, 37), [...circle(2, 1, 40, 91)].reverse(), circle(-5, 3, 300, 400).slice(123).concat(circle(-5, 3, 300, 400).slice(0, 123))];
  const morph = morphRings(rings, 64);
  assert.deepEqual(morph.map((r) => r.length), [64, 64, 64]);
  for (const r of morph) assert.ok(signedArea(r) > 0);
  // In step: point k of one ring and point k of the next lie in the same direction from the middle.
  for (let m = 1; m < morph.length; m++) {
    for (let k = 0; k < 64; k++) {
      const a = Math.atan2(morph[m - 1]![k]![1], morph[m - 1]![k]![0]);
      const b = Math.atan2(morph[m]![k]![1] - 1, morph[m]![k]![0] - 2);
      const turn = Math.abs(((a - b + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      assert.ok(turn < 0.35, `ring ${m}, point ${k}: ${turn.toFixed(2)} rad apart`);
    }
  }
  // alignTo finds the start that was turned away.
  const base = resample(circle(0, 0, 10, 60), 60, true);
  const turned = base.map((_, k) => base[(k + 17) % 60]!);
  assert.deepEqual(alignTo(turned, base), base);
});

test('geom: a ring cut to a box comes out as whole rings that follow the box, never doubling back', () => {
  const box: [number, number, number, number] = [0, 0, 10, 10];
  // Inside: as it is. Outside: nothing. Round the box: the box.
  assert.deepEqual(clipRing(square(2, 2, 4, 4), box), [square(2, 2, 4, 4)]);
  assert.deepEqual(clipRing(square(20, 20, 30, 30), box), []);
  const around = clipRing(square(-5, -5, 15, 15), box);
  assert.equal(around.length, 1);
  assert.equal(area(around[0]!), 100);
  // Half in: the half.
  const half = clipRing(square(5, -5, 15, 15), box);
  assert.equal(half.length, 1);
  assert.equal(area(half[0]!), 50);
  assert.ok(!crosses(half[0]!));
  // A comb whose back lies below the box and whose teeth reach into it: three pieces, a tooth each.
  const comb: Point[] = [[-2, -4], [12, -4], [12, 4], [9, 4], [9, -2], [6, -2], [6, 4], [4, 4], [4, -2], [1, -2], [1, 4], [-2, 4]];
  const teeth = clipRing(comb, box);
  assert.equal(teeth.length, 3);
  assert.deepEqual(teeth.map((r) => area(r)).sort((a, b) => a - b), [4, 4, 8]);
  for (const r of teeth) assert.ok(!crosses(r) && signedArea(r) > 0);
  // The ring may be given clockwise.
  assert.equal(area(clipRing([...square(5, -5, 15, 15)].reverse(), box)[0]!), 50);
});

test('geom: chains with the land on their left close along the box counter-clockwise', () => {
  const box: [number, number, number, number] = [0, 0, 10, 10];
  // A coast from the south edge to the north edge, the land to its west (on the left going north).
  const west = closeChains([[[4, 0], [5, 5], [4, 10]]], box);
  assert.equal(west.length, 1);
  assert.ok(pointInRing([1, 5], west[0]!));
  assert.ok(!pointInRing([9, 5], west[0]!));
  // The same coast run the other way: the land is to its east.
  const east = closeChains([[[4, 10], [5, 5], [4, 0]]], box);
  assert.ok(pointInRing([9, 5], east[0]!));
  assert.ok(!pointInRing([1, 5], east[0]!));
  // A bay cut into the south edge, run clockwise: the land is all the box but the bay.
  const bay = closeChains([[[3, 0], [3, 2], [6, 2], [6, 0]]], box);
  assert.equal(bay.length, 1);
  assert.equal(area(bay[0]!), 94);
  // Two coasts, a strait between them: two pieces of land.
  const strait = closeChains([[[3, 0], [3, 10]], [[7, 10], [7, 0]]], box);
  assert.equal(strait.length, 2);
  assert.deepEqual(strait.map((r) => area(r)).sort((a, b) => a - b), [30, 30]);
});

test('geom: a line cut to a box gives its pieces inside', () => {
  const pieces = clipLine([[-5, 5], [5, 5], [5, 15], [8, 15], [8, 5], [20, 5]], [0, 0, 10, 10]);
  assert.deepEqual(pieces, [[[0, 5], [5, 5], [5, 10]], [[8, 10], [8, 5], [10, 5]]]);
});

test('geom: rounding drops the repeats it makes', () => {
  assert.deepEqual(roundPoints([[0.04, 0], [0.01, 0.02], [1.26, 1.24]], 1), [[0, 0], [1.3, 1.2]]);
});

test('project: metres round the centre, true at a city and close over a country, and back again', () => {
  const [lon, lat] = [14.5146, 35.8989];
  const proj = projection({ lon, lat });
  assert.deepEqual(proj.forward([lon, lat]), [0, 0]);
  // A hundredth of a degree north is 1112 m; east, that times the cosine of the latitude.
  const north = proj.forward([lon, lat + 0.01]);
  const east = proj.forward([lon + 0.01, lat]);
  assert.ok(Math.abs(north[1] - 1111.95) < 0.5 && Math.abs(north[0]) < 0.01, String(north));
  assert.ok(Math.abs(east[0] - 1111.95 * Math.cos((lat * Math.PI) / 180)) < 0.5 && Math.abs(east[1]) < 0.1, String(east));
  for (const p of [[14.2, 35.7], [14.72, 36.03], [-3, 34.5], [28, 48.5]] as [number, number][]) {
    const back = proj.inverse(proj.forward(p));
    assert.ok(Math.abs(back[0] - p[0]) < 1e-9 && Math.abs(back[1] - p[1]) < 1e-9, `${p} -> ${back}`);
  }
  // A place some 480 km off, over the sphere (the haversine): the plane keeps that to a part in a thousand.
  const far: [number, number] = [11.2, 39.4];
  const rad = Math.PI / 180;
  const h = Math.sin(((far[1] - lat) * rad) / 2) ** 2 + Math.cos(lat * rad) * Math.cos(far[1] * rad) * Math.sin(((far[0] - lon) * rad) / 2) ** 2;
  const over = 2 * 6371008.8 * Math.asin(Math.sqrt(h));
  const flat = Math.hypot(...proj.forward(far));
  assert.ok(over > 450000 && over < 520000 && Math.abs(flat - over) < over / 1000, `${flat} against ${over}`);
  const box = projectBox(proj, [14.435, 35.864, 14.535, 35.922]);
  const back = unprojectBox(proj, box);
  assert.ok(back[0] <= 14.435 && back[1] <= 35.864 && back[2] >= 14.535 && back[3] >= 35.922);
});
