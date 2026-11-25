// Lines as a network, and lines on the sphere: the shortest path along a layer of lines from one place to another,
// a stretch of a line between two lengths, and the great circle between two places. A route follows the lines a map
// holds (roads, sea lanes, named lines), so a line drawn from one place to another runs where the map says one can
// go, as one polyline a stroke can draw on, retract or split.

import { dedupe, dist } from './geom.mjs';
import { EARTH_RADIUS } from './project.mjs';

const RAD = Math.PI / 180;

/** The length of the great-circle arc between two places [lon, lat], in metres on the sphere of the Earth. */
export function arcLength(a, b) {
  const [p1, p2] = [a[1] * RAD, b[1] * RAD];
  const s = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(((b[0] - a[0]) * RAD) / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(s)));
}

const finitePoint = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
const lonLat = (p) => finitePoint(p) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;

/**
 * The great circle from `a` to `b` ([lon, lat]), the shorter way round: its points every `step` degrees of arc or
 * closer (1 by default), both ends kept. Longitudes stay from -180 to 180, so a circle across the 180th meridian
 * jumps there; a map cuts it at its own edge. Two places on opposite sides of the Earth have no one great circle,
 * and are refused, as is a place twice.
 */
export function greatCircle(a, b, { step = 1 } = {}) {
  if (!lonLat(a) || !lonLat(b)) throw new Error(`greatCircle: the ends are [lon, lat] in degrees, got ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
  if (!(Number.isFinite(step) && step > 0 && step <= 90)) throw new Error(`greatCircle: "step" is degrees of arc above 0 and up to 90, got ${step}`);
  const v = ([lo, la]) => [Math.cos(la * RAD) * Math.cos(lo * RAD), Math.cos(la * RAD) * Math.sin(lo * RAD), Math.sin(la * RAD)];
  const [p, q] = [v(a), v(b)];
  const dot = p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const cross = Math.hypot(p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]);
  const angle = Math.atan2(cross, dot);
  if (angle < 1e-9) throw new Error('greatCircle: the two ends are one place');
  if (Math.PI - angle < 1e-6) throw new Error('greatCircle: the two ends are opposite each other on the Earth, and no one great circle joins them');
  const n = Math.max(1, Math.ceil(angle / RAD / step));
  const s = Math.sin(angle);
  const out = [[a[0], a[1]]];
  for (let k = 1; k < n; k++) {
    const t = k / n;
    const [u, w] = [Math.sin((1 - t) * angle) / s, Math.sin(t * angle) / s];
    const [x, y, z] = [u * p[0] + w * q[0], u * p[1] + w * q[1], u * p[2] + w * q[2]];
    out.push([Math.atan2(y, x) / RAD, Math.atan2(z, Math.hypot(x, y)) / RAD]);
  }
  out.push([b[0], b[1]]);
  return out;
}

/**
 * The stretch of a line between two lengths along it from its first point, in its units (`from` and `to`), or between
 * two shares of its whole length (`share: true`, 0 to 1): its points between them, with a point put in where each
 * falls inside a segment. A stroke drawn on along a route draws `cutLine(route, 0, t, { share: true })`; one that
 * retracts from its start draws `cutLine(route, t, 1, { share: true })`; two calls split it. `from` equal to `to`
 * gives the one point there. Lengths beyond the line are refused, as is `to` before `from`.
 */
export function cutLine(points, from, to, { share = false } = {}) {
  if (!Array.isArray(points) || points.length < 2 || !points.every(finitePoint)) throw new Error('cutLine: the line is two points [x, y] or more');
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error(`cutLine: "from" and "to" are numbers, got ${from} and ${to}`);
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + dist(points[i - 1], points[i]));
  const whole = lengths[lengths.length - 1];
  const [a, b] = share ? [from * whole, to * whole] : [from, to];
  const eps = whole * 1e-12;
  if (share ? from < 0 || to > 1 : from < -eps || to > whole + eps) throw new Error(`cutLine: ${share ? 'the shares run from 0 to 1' : `the lengths run from 0 to the line's ${whole}`}, got ${from} to ${to}`);
  if (to < from) throw new Error(`cutLine: "to" (${to}) comes before "from" (${from})`);
  const at = (d) => {
    const v = Math.max(0, Math.min(whole, d));
    let i = 1;
    while (i < points.length - 1 && lengths[i] < v) i++;
    const len = lengths[i] - lengths[i - 1];
    const t = len > 0 ? (v - lengths[i - 1]) / len : 0;
    const [p, q] = [points[i - 1], points[i]];
    return { i, p: [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t] };
  };
  const start = at(a);
  const end = at(b);
  const out = [start.p];
  for (let k = start.i; k < end.i; k++) out.push([points[k][0], points[k][1]]);
  out.push(end.p);
  const clean = dedupe(out, 0);
  return clean.length > 0 ? clean : [start.p];
}

/** A heap of [cost, node], the least first; ties go to the lower node, so a route is the same every time. */
class Heap {
  items = [];
  get size() {
    return this.items.length;
  }
  less(a, b) {
    return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  }
  push(item) {
    const h = this.items;
    h.push(item);
    for (let i = h.length - 1; i > 0; ) {
      const up = (i - 1) >> 1;
      if (!this.less(h[i], h[up])) break;
      [h[i], h[up]] = [h[up], h[i]];
      i = up;
    }
  }
  pop() {
    const h = this.items;
    const top = h[0];
    const last = h.pop();
    if (h.length > 0) {
      h[0] = last;
      for (let i = 0; ; ) {
        const [l, r] = [2 * i + 1, 2 * i + 2];
        let m = i;
        if (l < h.length && this.less(h[l], h[m])) m = l;
        if (r < h.length && this.less(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }
}

/** The point of the segment a-b nearest p, as its share t along it and its distance. */
function nearestOn(p, a, b) {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  const q = [a[0] + dx * t, a[1] + dy * t];
  return { t, q, d: dist(p, q) };
}

/**
 * The shortest way from `from` to `to` along a network of lines (the points of each in any plane units: metres of a
 * map's frame, or units of a stage): both places are snapped to the nearest point of the network, and the path between
 * those points is found along the lines, as one polyline.
 *
 *   join     how near two points of the lines are to be one junction, and how near a line's end is to come to
 *            another line to join it there (in the lines' units; 0, the default: only where lines share a point)
 *   reach    the farthest a place may lie from the network (Infinity by default): a place farther off is refused
 *   measure  (a, b) => the cost of the segment from a to b (its length in the plane by default), for a route measured
 *            otherwise: on the sphere, through the frame's inverse projection
 *
 * Returns { points, length, ends, off }: the path from the point `from` snapped to, to the one `to` snapped to, through
 * the network's own points; its length as `measure` takes it; the two snapped points; and how far each place lay from
 * them, in the plane.
 * Places that the network does not join are refused, with how far apart its pieces come; a larger `join` closes
 * such a gap where it is a fault of the data. The same lines and places give the same path every time.
 */
export function routeAlong(lines, from, to, { join = 0, reach = Infinity, measure = dist } = {}) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('routeAlong: the network is a list of lines, each two points [x, y] or more');
  if (!finitePoint(from) || !finitePoint(to)) throw new Error(`routeAlong: the places are points [x, y] in the lines' units, got ${JSON.stringify(from)} and ${JSON.stringify(to)}`);
  if (!(Number.isFinite(join) && join >= 0)) throw new Error(`routeAlong: "join" is a distance of 0 or more, got ${join}`);
  if (!(reach > 0)) throw new Error(`routeAlong: "reach" is a distance above 0, got ${reach}`);
  // The junctions: every point of the lines, those within `join` of each other taken as one (the first met stands
  // for them all).
  const pos = [];
  const lineNodes = [];
  const exact = new Map();
  for (const line of lines) {
    if (!Array.isArray(line) || !line.every(finitePoint)) throw new Error('routeAlong: each line of the network is a list of points [x, y]');
    const ids = [];
    for (const p of line) {
      const key = `${p[0]},${p[1]}`;
      let id = exact.get(key);
      if (id === undefined) {
        id = pos.length;
        exact.set(key, id);
        pos.push([p[0], p[1]]);
      }
      ids.push(id);
    }
    lineNodes.push(ids);
  }
  const root = pos.map((_, i) => i);
  const find = (i) => {
    while (root[i] !== i) i = root[i] = root[root[i]];
    return i;
  };
  const cellOf = (p, size) => `${Math.floor(p[0] / size)},${Math.floor(p[1] / size)}`;
  if (join > 0) {
    const cells = new Map();
    pos.forEach((p, i) => {
      const key = cellOf(p, join);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(i);
    });
    pos.forEach((p, i) => {
      const [cx, cy] = [Math.floor(p[0] / join), Math.floor(p[1] / join)];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const j of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (j <= i || dist(p, pos[j]) > join) continue;
            const [a, b] = [find(i), find(j)];
            if (a !== b) root[Math.max(a, b)] = Math.min(a, b);
          }
        }
      }
    });
  }
  const node = (i) => find(i);
  // The edges: every segment of a line between two junctions, once.
  const edges = [];
  const seen = new Set();
  const addEdge = (a, b) => {
    if (a === b) return;
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push([a, b]);
  };
  for (const ids of lineNodes) for (let k = 1; k < ids.length; k++) addEdge(node(ids[k - 1]), node(ids[k]));
  const at = (n) => pos[n];
  if (edges.length === 0) throw new Error('routeAlong: the network has no segment of any length');
  // A line that ends near the side of another (a road meeting a road mid-way) joins it there: that side is split at
  // the point nearest the end, and a short link added.
  const split = (e, t) => {
    const [a, b] = edges[e];
    const [p, q] = [at(a), at(b)];
    const id = pos.length;
    pos.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    root.push(id);
    edges[e] = [a, id];
    edges.push([id, b]);
    return id;
  };
  if (join > 0) {
    // The sides are found through a grid of cells, each holding the segments that come within `join` of it.
    const lengths = edges.map(([a, b]) => dist(at(a), at(b))).sort((p, q) => p - q);
    const size = Math.max(join, lengths[lengths.length >> 1]);
    const cells = new Map();
    const index = (e) => {
      const [a, b] = edges[e];
      const [p, q] = [at(a), at(b)];
      for (let cx = Math.floor((Math.min(p[0], q[0]) - join) / size); cx <= Math.floor((Math.max(p[0], q[0]) + join) / size); cx++) {
        for (let cy = Math.floor((Math.min(p[1], q[1]) - join) / size); cy <= Math.floor((Math.max(p[1], q[1]) + join) / size); cy++) {
          const key = `${cx},${cy}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(e);
        }
      }
    };
    edges.forEach((_, e) => index(e));
    const degree = new Map();
    for (const [a, b] of edges) for (const n of [a, b]) degree.set(n, (degree.get(n) ?? 0) + 1);
    const ends = [...new Set(lineNodes.flatMap((ids) => [node(ids[0]), node(ids[ids.length - 1])]))].filter((n) => degree.get(n) === 1).sort((a, b) => a - b);
    for (const n of ends) {
      let best = null;
      for (const e of [...new Set(cells.get(cellOf(at(n), size)) ?? [])].sort((p, q) => p - q)) {
        const [a, b] = edges[e];
        if (a === n || b === n) continue;
        const near = nearestOn(at(n), at(a), at(b));
        if (near.d <= join && near.t > 0 && near.t < 1 && (!best || near.d < best.d)) best = { e, t: near.t, d: near.d };
      }
      if (!best) continue;
      const id = split(best.e, best.t);
      index(best.e);
      index(edges.length - 1);
      edges.push([n, id]);
    }
  }
  // The places, each on the nearest point of the network: a junction, or a new one on the side of a segment.
  const snap = (p, what) => {
    let best = null;
    for (let e = 0; e < edges.length; e++) {
      const [a, b] = edges[e];
      const near = nearestOn(p, at(a), at(b));
      if (!best || near.d < best.d) best = { e, ...near };
    }
    if (best.d > reach) throw new Error(`routeAlong: ${what} lies ${round(best.d)} from the network, beyond its reach of ${reach}`);
    const [a, b] = edges[best.e];
    const id = best.t <= 0 ? a : best.t >= 1 ? b : split(best.e, best.t);
    return { id, off: best.d };
  };
  const s = snap(from, 'the first place');
  const t = snap(to, 'the second place');
  const nodes = pos.length;
  const adj = Array.from({ length: nodes }, () => []);
  for (const [a, b] of edges) {
    const w = measure(at(a), at(b));
    if (!(Number.isFinite(w) && w >= 0)) throw new Error(`routeAlong: "measure" gave ${w} for a segment; it gives a length of 0 or more`);
    adj[a].push([b, w]);
    adj[b].push([a, w]);
  }
  for (const list of adj) list.sort((p, q) => p[0] - q[0]);
  const cost = new Float64Array(nodes).fill(Infinity);
  const back = new Int32Array(nodes).fill(-1);
  const heap = new Heap();
  cost[s.id] = 0;
  heap.push([0, s.id]);
  while (heap.size > 0) {
    const [c, n] = heap.pop();
    if (c > cost[n]) continue;
    if (n === t.id) break;
    for (const [m, w] of adj[n]) {
      const next = c + w;
      if (next < cost[m] || (next === cost[m] && n < back[m])) {
        cost[m] = next;
        back[m] = n;
        heap.push([next, m]);
      }
    }
  }
  if (cost[t.id] === Infinity) {
    // How near the piece of the network the first place is on comes to the piece the second is on: from the loose
    // ends of each to the segments of the other, where a gap in the data most often lies.
    const theirs = new Uint8Array(nodes);
    const queue = [t.id];
    theirs[t.id] = 1;
    while (queue.length > 0) for (const [m] of adj[queue.pop()]) if (!theirs[m]) queue.push(m), (theirs[m] = 1);
    const side = (n) => (cost[n] < Infinity ? 0 : theirs[n] ? 1 : -1);
    const segs = [edges.filter(([a]) => side(a) === 0), edges.filter(([a]) => side(a) === 1)];
    const loose = [0, 1].map((k) => [...Array(nodes).keys()].filter((n) => side(n) === k && adj[n].length <= 1));
    const gap = Math.min(nearestApart(loose[0].map(at), segs[1].map(([a, b]) => [at(a), at(b)])), nearestApart(loose[1].map(at), segs[0].map(([a, b]) => [at(a), at(b)])));
    throw new Error(`routeAlong: the network does not join the two places${gap < Infinity ? `: their pieces come within ${round(gap)} of each other (a "join" of that much would join them there)` : ''}`);
  }
  const path = [];
  for (let n = t.id; n !== -1; n = n === s.id ? -1 : back[n]) path.push([at(n)[0], at(n)[1]]);
  path.reverse();
  const points = path.length === 1 ? [path[0], [path[0][0], path[0][1]]] : dedupe(path, 0);
  let length = 0;
  for (let k = 1; k < points.length; k++) length += measure(points[k - 1], points[k]);
  return { points, length, ends: [points[0], points[points.length - 1]], off: [s.off, t.off] };
}

/** The least distance between a point of `points` and a segment of `segments`; Infinity when that is too long to look for. */
function nearestApart(points, segments) {
  if (points.length === 0 || segments.length === 0 || points.length * segments.length > 2e7) return Infinity;
  let best = Infinity;
  for (const p of points) for (const [a, b] of segments) best = Math.min(best, nearestOn(p, a, b).d);
  return best;
}

const round = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);
