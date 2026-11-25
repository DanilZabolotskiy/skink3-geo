// Lines as a network and lines on the sphere: the shortest way along lines from one place to another, a stretch of a
// line between two lengths or shares, the great circle between two places, and a route on the stage as one polyline.
// Nothing is downloaded and no cache is read.
//
//   node --test "test/*.test.*"

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutLine as cutOnMap, fitView, fromFrame, lineOnStage, routeAlong as routeOnMap, toFrame, type Point, type WorldFrame } from '../map.ts';
import { dist, lengthOf } from '../lib/geom.mjs';
import { EARTH_RADIUS } from '../lib/project.mjs';
import { arcLength, cutLine, greatCircle, routeAlong } from '../lib/route.mjs';

/**
 * A ladder of lines in metres: two rails from x 0 to 400 at y 0 and y 100, with rungs at x 0, 200 and 400; a spur from
 * (400, 0) to (500, 0); and a loose line from (250, 150) to (250, 104), which ends 4 m short of the top rail.
 */
function ladder(): Point[][] {
  return [
    [[0, 0], [100, 0], [200, 0], [300, 0], [400, 0]],
    [[0, 100], [200, 100], [400, 100]],
    [[0, 0], [0, 100]],
    [[200, 0], [200, 100]],
    [[400, 0], [400, 100]],
    [[400, 0], [500, 0]],
    [[250, 150], [250, 104]],
  ];
}

test('routeAlong: the shortest way along the lines, from where each place meets them, as one polyline through their points', () => {
  const r = routeAlong(ladder(), [-10, 30], [500, 0]);
  // From (-10, 30) the nearest point of the lines is (0, 30) on the left rung; then down it and along the bottom rail.
  assert.deepEqual(r.points, [[0, 30], [0, 0], [100, 0], [200, 0], [300, 0], [400, 0], [500, 0]]);
  assert.equal(r.length, 530);
  assert.deepEqual(r.ends, [[0, 30], [500, 0]]);
  assert.deepEqual(r.off, [10, 0]);
  // A place in the middle of a line splits it there; the way runs over the top when that is shorter.
  const top = routeAlong(ladder(), [0, 90], [300, 110]);
  assert.deepEqual(top.points, [[0, 90], [0, 100], [200, 100], [300, 100]]);
  assert.equal(top.length, 310);
  // The way back is the same way, turned round; the same lines give the same way every time.
  assert.deepEqual(routeAlong(ladder(), [500, 0], [-10, 30]).points, [...r.points].reverse());
  assert.deepEqual(routeAlong(ladder(), [-10, 30], [500, 0]), r);
  // Two ways of one length: the one through the lower junction, the same every time.
  const tie = routeAlong([[[0, 0], [10, 10], [20, 0]], [[0, 0], [10, -10], [20, 0]]], [0, 0], [20, 0]);
  assert.deepEqual(tie, routeAlong([[[0, 0], [10, 10], [20, 0]], [[0, 0], [10, -10], [20, 0]]], [0, 0], [20, 0]));
  assert.equal(tie.points.length, 3);
  // Both places on one point: a line of two equal points, of no length.
  assert.deepEqual(routeAlong(ladder(), [100, 0], [100, 0]).points, [[100, 0], [100, 0]]);
});

test('routeAlong: lines that only come near each other join within "join"; a measure of its own weighs each stretch', () => {
  // The loose line ends 4 m short of the top rail: without join it is a piece of its own, and the gap is named.
  assert.throws(() => routeAlong(ladder(), [250, 150], [0, 0]), /does not join the two places: their pieces come within 4 of each other/);
  const r = routeAlong(ladder(), [250, 150], [0, 0], { join: 5 });
  assert.deepEqual(r.points[0], [250, 150]);
  assert.deepEqual(r.points.slice(0, 3), [[250, 150], [250, 104], [250, 100]]);
  assert.equal(r.points.at(-1)![0], 0);
  // Two ends 3 m apart are one junction within a join of 5.
  const apart: Point[][] = [[[0, 0], [100, 0]], [[103, 0], [200, 0]]];
  assert.throws(() => routeAlong(apart, [0, 0], [200, 0]), /come within 3/);
  assert.equal(routeAlong(apart, [0, 0], [200, 0], { join: 5 }).points.at(-1)![0], 200);
  // A measure that makes the bottom rail dear sends the way over the top; the length is that measure's.
  const dear = (a: Point, b: Point): number => dist(a, b) * (a[1] === 0 && b[1] === 0 ? 10 : 1);
  const up = routeAlong(ladder(), [0, 0], [400, 0], { measure: dear });
  assert.deepEqual(up.points, [[0, 0], [0, 100], [200, 100], [400, 100], [400, 0]]);
  assert.equal(up.length, 600);
});

test('routeAlong: what it refuses', () => {
  assert.throws(() => routeAlong([], [0, 0], [1, 1]), /the network is a list of lines/);
  assert.throws(() => routeAlong(ladder(), [Number.NaN, 0], [1, 1]), /the places are points/);
  assert.throws(() => routeAlong(ladder(), [-50, 50], [500, 0], { reach: 20 }), /farther|reach/);
  assert.throws(() => routeAlong(ladder(), [0, 0], [500, 0], { measure: () => -1 }), /"measure" gave -1/);
  assert.throws(() => routeAlong([[[0, 0], [10, 0]], [[50, 0], [60, 0]]], [0, 0], [60, 0]), /does not join/);
});

test('cutLine: the stretch of a line between two lengths or two shares, with a point put in where each falls', () => {
  const line: Point[] = [[0, 0], [100, 0], [100, 100]];
  assert.deepEqual(cutLine(line, 50, 150), [[50, 0], [100, 0], [100, 50]]);
  assert.deepEqual(cutLine(line, 0, 0.25, { share: true }), [[0, 0], [50, 0]]);
  assert.deepEqual(cutLine(line, 0.25, 1, { share: true }), [[50, 0], [100, 0], [100, 100]]);
  assert.deepEqual(cutLine(line, 0, 1, { share: true }), line);
  // Two calls split it at one point: the pieces meet there and their lengths add up.
  const [a, b] = [cutLine(line, 0, 0.6, { share: true }), cutLine(line, 0.6, 1, { share: true })];
  assert.deepEqual(a.at(-1), b[0]);
  assert.equal(lengthOf(a) + lengthOf(b), 200);
  assert.deepEqual(cutLine(line, 120, 120), [[100, 20]]);
  assert.throws(() => cutLine(line, 0, 250), /run from 0 to the line's 200/);
  assert.throws(() => cutLine(line, -0.1, 0.5, { share: true }), /shares run from 0 to 1/);
  assert.throws(() => cutLine(line, 0.6, 0.2, { share: true }), /comes before/);
  assert.throws(() => cutLine([[0, 0]], 0, 0), /two points/);
  assert.equal(cutOnMap, cutLine);
});

test('greatCircle: the shorter way round between two places, a point every step, both ends kept; arcLength, the way along it', () => {
  // A degree of the equator is 111.195 km on the Earth's mean sphere.
  assert.ok(Math.abs(arcLength([0, 0], [1, 0]) - 111195) < 1);
  assert.ok(Math.abs(arcLength([0, 0], [180, 0]) - Math.PI * EARTH_RADIUS) < 1e-6);
  const c = greatCircle([-74, 40.6], [-9.1, 38.8], { step: 2 });
  assert.deepEqual(c[0], [-74, 40.6]);
  assert.deepEqual(c.at(-1), [-9.1, 38.8]);
  // It bows toward the pole, and its points are a step of arc apart at most; along it, it is as long as the arc.
  assert.ok(Math.max(...c.map((p) => p[1])) > 44);
  let along = 0;
  for (let k = 1; k < c.length; k++) {
    const d = arcLength(c[k - 1]!, c[k]!);
    assert.ok(d <= 2 * 111195 + 1, `${d}`);
    along += d;
  }
  assert.ok(Math.abs(along - arcLength([-74, 40.6], [-9.1, 38.8])) < 1);
  // The shorter way round crosses the 180th meridian; its longitudes jump there, and a map cuts it at its edge.
  const pacific = greatCircle([170, 0], [-170, 0], { step: 5 });
  assert.ok(pacific.every(([lon, lat]) => Math.abs(lon) >= 170 && lat === 0));
  assert.equal(pacific.filter((p, k) => k > 0 && Math.abs(p[0] - pacific[k - 1]![0]) > 180).length, 1);
  assert.throws(() => greatCircle([10, 10], [10, 10]), /one place/);
  assert.throws(() => greatCircle([0, 0], [180, 0]), /opposite each other/);
  assert.throws(() => greatCircle([0, 0], [10, 0], { step: 0 }), /"step"/);
  assert.throws(() => greatCircle([0, 95], [10, 0]), /\[lon, lat\]/);
});

test('routeAlong on a map: with its frame, each stretch measured on the Earth; lineOnStage puts the way on the stage whole', () => {
  const frame: WorldFrame = { projection: 'laea', centre: [0, 0], box: [-3e6, -3e6, 3e6, 3e6], lonlat: [-25, -25, 25, 25] };
  const to = toFrame(frame);
  const back = fromFrame(frame);
  // A line along the equator and one up the meridian 10° E, on the plane of the map.
  const equator = [-20, -10, 0, 10, 20].map((lon) => to([lon, 0]));
  const meridian = [0, 5, 10, 15].map((lat) => to([10, lat]));
  const way = routeOnMap([equator, meridian], to([-20, 0]), to([10, 15]), { frame });
  assert.deepEqual(way.points, [...equator.slice(0, 4), ...meridian.slice(1)]);
  assert.ok(Math.abs(way.length - arcLength([-20, 0], [10, 0]) - arcLength([10, 0], [10, 15])) < 1, `${way.length}`);
  // Without a frame it is measured on the plane, as routeAlong of the library measures it.
  assert.deepEqual(routeOnMap([equator, meridian], to([-20, 0]), to([10, 15])), routeAlong([equator, meridian], to([-20, 0]), to([10, 15])));
  for (const ll of [[3, 4], [-20, -10]] as [number, number][]) {
    const p = back(to(ll));
    assert.ok(Math.abs(p[0] - ll[0]) < 1e-9 && Math.abs(p[1] - ll[1]) < 1e-9);
  }
  // On a stage that shows only its middle, the way is still one polyline from end to end, beyond the stage too.
  const view = fitView([-5e5, -5e5, 5e5, 5e5], { w: 1920, h: 1080 });
  const path = lineOnStage(view, way.points);
  assert.deepEqual(path[0], view.project(way.points[0]!));
  assert.deepEqual(path.at(-1), view.project(way.points.at(-1)!));
  assert.ok(path[0]![0] < -1000 && path.at(-1)![1] < -1000, 'it runs off the stage at both ends');
  // A long line is thinned to the most points asked for; a share of it is that share of the whole way.
  const wiggle: Point[] = [];
  for (let k = 0; k <= 2000; k++) wiggle.push([k * 100, (k % 2) * 300]);
  assert.ok(lineOnStage(view, wiggle, { max: 50 }).length <= 50);
  const half = cutLine(path, 0, 0.5, { share: true });
  assert.ok(Math.abs(lengthOf(half) - lengthOf(path) / 2) < 1e-6);
  assert.throws(() => lineOnStage(view, [[0, 0]]), /two points or more/);
});
