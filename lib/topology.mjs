// Outlines that share their borders, thinned together. Countries side by side come as rings in the plane; where
// two rings run through the same points they share a border. The rings are cut into arcs at the points where a
// shared stretch begins or ends, each arc is simplified once, and every ring is put together again from its arcs,
// so two neighbours keep one border after thinning, with no gap and no overlap between them. An arc that one ring
// alone runs along is coast: joined, those arcs give the land as a whole. An arc that two run along is the border
// between them.

import { area, crosses, dedupe, dist, orient, signedArea } from './geom.mjs';
import { joinLines } from './osm.mjs';

const keyOf = (p) => `${p[0]},${p[1]}`;

/**
 * A line or ring in lon/lat with no edge longer than `step` degrees: points are put into the long edges, so that they
 * bend as a projection bends them (a border along a parallel, the cut along the 180th meridian). The points put into
 * an edge are the same whichever way round it is walked, so an edge two rings share stays shared.
 */
export function densify(points, step = 1, closed = true) {
  const n = points.length;
  const out = [];
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    out.push(a);
    const k = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / step);
    if (k <= 1) continue;
    const ahead = a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
    const [p, q] = ahead ? [a, b] : [b, a];
    const mids = [];
    for (let j = 1; j < k; j++) mids.push([p[0] + ((q[0] - p[0]) * j) / k, p[1] + ((q[1] - p[1]) * j) / k]);
    out.push(...(ahead ? mids : mids.reverse()));
  }
  if (!closed && n > 0) out.push(points[n - 1]);
  return out;
}

/**
 * Douglas–Peucker over pts[i0..j0], marking in `keep` what stays. With `least`, the farthest point of the span stays
 * even within `tol`, so that an arc between two corners keeps one bend and a ring of two arcs stays a ring.
 */
function peucker(pts, i0, j0, tol, keep, least) {
  const stack = [[i0, j0, least]];
  while (stack.length > 0) {
    const [i, j, must] = stack.pop();
    if (j - i < 2) continue;
    const [ax, ay] = pts[i];
    const [bx, by] = pts[j];
    const len = Math.hypot(bx - ax, by - ay);
    let far = -1;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const d = len < 1e-12 ? Math.hypot(pts[k][0] - ax, pts[k][1] - ay) : Math.abs((bx - ax) * (ay - pts[k][1]) - (ax - pts[k][0]) * (by - ay)) / len;
      if (d > far) [far, at] = [d, k];
    }
    if (far > tol || must) {
      keep[at] = 1;
      stack.push([i, at, false], [at, j, false]);
    }
  }
}

/** An arc thinned to `tol`: an open one keeps its ends, a closed one (a ring of its own) at least four points. */
function thinArc(points, tol, closed) {
  if (!closed) {
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    peucker(points, 0, points.length - 1, tol, keep, true);
    return points.filter((_, k) => keep[k]);
  }
  const n = points.length;
  if (n <= 4) return [...points];
  const pts = [...points, points[0]];
  let mid = 1;
  for (let k = 2; k < n; k++) if (dist(pts[k], pts[0]) > dist(pts[mid], pts[0])) mid = k;
  const keep = new Uint8Array(n + 1);
  keep[0] = keep[mid] = 1;
  peucker(pts, 0, mid, tol, keep, true);
  peucker(pts, mid, n, tol, keep, true);
  return points.filter((_, k) => keep[k]);
}

const rounded = (points, digits) => {
  const f = 10 ** digits;
  return points.map(([x, y]) => [Math.round(x * f) / f + 0, Math.round(y * f) / f + 0]);
};

const side = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));

/** The pairs of edges [i, j] of a ring that cross or touch (edge i runs from point i to point i + 1): what `crosses` finds. */
export function crossings(points) {
  const n = points.length;
  const out = [];
  if (n < 4) return out;
  const edges = [];
  for (let i = 0; i < n; i++) {
    const [a, b] = [points[i], points[(i + 1) % n]];
    edges.push([Math.min(a[0], b[0]), Math.max(a[0], b[0]), i]);
  }
  edges.sort((p, q) => p[0] - q[0] || p[2] - q[2]);
  for (let e = 0; e < n; e++) {
    const [, max, i] = edges[e];
    const [a, b] = [points[i], points[(i + 1) % n]];
    for (let f = e + 1; f < n && edges[f][0] <= max; f++) {
      const j = edges[f][2];
      const gap = Math.abs(i - j);
      if (gap <= 1 || gap === n - 1) continue;
      const [c, d] = [points[j], points[(j + 1) % n]];
      if (Math.max(c[1], d[1]) < Math.min(a[1], b[1]) || Math.min(c[1], d[1]) > Math.max(a[1], b[1])) continue;
      if (side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b)) out.push(i < j ? [i, j] : [j, i]);
    }
  }
  return out.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}

/** The convex hull of points, counter-clockwise: Andrew's monotone chain. */
function hull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (list) => {
    const out = [];
    for (const p of list) {
      while (out.length >= 2 && side(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    return out.slice(0, -1);
  };
  return [...half(pts), ...half([...pts].reverse())];
}

/**
 * A ring that crosses or touches itself made whole by taking points out: at each step one end of the first crossing
 * pair, the one that leaves the fewest crossings, until none is left. A speck of five points or fewer becomes its
 * hull. Returns null if the ring cannot be made whole (fewer than three points would be left, or no area). Points
 * are taken out of this ring alone, so where it shares a border the border is no longer shared there: for the last
 * tenths of a stage, after the rings were thinned together.
 */
export function untangle(points) {
  let ring = points;
  for (let step = 0; step <= points.length; step++) {
    const pairs = crossings(ring);
    if (pairs.length === 0) return ring.length >= 3 && area(ring) > 0 ? ring : null;
    if (ring.length <= 5) {
      const h = hull(ring);
      return h.length >= 3 && area(h) > 0 ? h : null;
    }
    const [i, j] = pairs[0];
    const n = ring.length;
    let best = null;
    for (const k of [(i + 1) % n, i, (j + 1) % n, j]) {
      const next = ring.filter((_, q) => q !== k);
      const left = crossings(next).length;
      if (best === null || left < best.left) best = { left, next };
    }
    ring = best.next;
  }
  return null;
}

/**
 * Rings of shapes that share borders, thinned together.
 *   shapes   [{ rings: [{ points, hole? }], level?, group? }]: points in the plane, a ring without its first point
 *            repeated at the end; a hole (`hole: true`) takes part in the borders (an enclave is a hole in the country
 *            round it). `level: 1` makes a shape one of the inner shapes, which lie over those of level 0 (the
 *            divisions of a country): they share every arc they run along with them, thinned once, and have borders
 *            of their own among themselves, but no part in the land and the borders of level 0. `group` (any key, at
 *            level 0) puts a shape in a group whose shapes are one outline, which `groups` gives (the categories of a
 *            thematic map, each its pieces as one)
 *   tol      the thinning, in the units of the plane
 *   minArea  an island (a ring that shares no border) smaller than this is left out, unless it is the largest ring
 *            of its shape: no shape loses its last ring
 *   digits   the points are rounded to so many decimals (0: whole units)
 * Returns:
 *   shapes   [{ rings }]: the outer rings of each shape that are kept, counter-clockwise, the largest first
 *   land     the outlines of all the shapes as one (the arcs that one ring alone runs along), counter-clockwise, the
 *            largest first; `gaps` are the holes in it that no shape fills, clockwise
 *   borders  [{ a, b, lines }]: the border between shapes a and b (a < b, their indices), as open lines, or a ring
 *            closed by its first point repeated where one shape lies inside the other
 *   stats    { arcs, shared, crossing, open, mended }: arcs in all, arcs two shapes share, rings that still cross
 *            themselves, coast that does not close (the data has a gap), points taken out of the data where a ring
 *            of it crossed itself
 *   inner    only with shapes of level 1: { borders }, the borders between two of them, as `borders` is
 *   groups   only with shapes in groups: [{ key, land, gaps }], each group's shapes as one, as `land` and `gaps`
 *            are all of them, in the order the keys first come among the shapes
 * No ring of a shape and no ring of the land crosses itself: where one would, the tolerance of its arcs is halved
 * until it does not, and where the data itself crosses, the point that makes it is taken out of its arc. A shape of
 * level 1 leaves out a small island as one of level 0 does; one of level 0 keeps an island that one of level 1 keeps.
 */
export function thinTogether(shapes, { tol, minArea = 0, digits = 0 }) {
  const rings = [];
  const inner = shapes.some((s) => s.level === 1);
  const keys = [];
  shapes.forEach((s, shape) => {
    if (s.level !== undefined && s.level !== 0 && s.level !== 1) throw new Error(`thinTogether: shape ${shape} has the level ${JSON.stringify(s.level)}; a level is 0 or 1`);
    if (s.group !== undefined && s.level === 1) throw new Error(`thinTogether: shape ${shape} is of level 1 and in a group; groups are of level 0`);
    if (s.group !== undefined && !keys.includes(s.group)) keys.push(s.group);
    const level = s.level === 1 ? 1 : 0;
    for (const r of s.rings) {
      const points = orient(dedupe(r.points, 0, true), !r.hole);
      if (points.length >= 3) rings.push({ shape, level, hole: Boolean(r.hole), points, keys: points.map(keyOf), refs: [], out: null, kept: true });
    }
  });

  // Where a shared stretch begins or ends: a point whose neighbours are not the same on every ring through it.
  const seen = new Map();
  const corner = new Set();
  for (const { keys } of rings) {
    const n = keys.length;
    for (let i = 0; i < n; i++) {
      const [k, a, b] = [keys[i], keys[(i + n - 1) % n], keys[(i + 1) % n]];
      const was = seen.get(k);
      if (was === undefined) seen.set(k, [a, b]);
      else if (!((was[0] === a && was[1] === b) || (was[0] === b && was[1] === a))) corner.add(k);
    }
  }

  // The arcs, each once, whichever way round and wherever along a ring it was met first.
  const arcs = [];
  const index = new Map();
  const register = (points, keys, closed, ring) => {
    let seq = keys.map((_, i) => i);
    if (closed) {
      let m = 0;
      for (let i = 1; i < keys.length; i++) if (keys[i] < keys[m]) m = i;
      seq = [...seq.slice(m), ...seq.slice(0, m)];
    }
    const back = closed ? [seq[0], ...seq.slice(1).reverse()] : [...seq].reverse();
    const ahead = seq.map((i) => keys[i]).join(';');
    const behind = back.map((i) => keys[i]).join(';');
    const reversed = behind < ahead;
    const canon = reversed ? behind : ahead;
    let id = index.get(canon);
    if (id === undefined) {
      id = arcs.length;
      index.set(canon, id);
      const order = reversed ? back : seq;
      arcs.push({ points: order.map((i) => points[i]), closed, start: keys[order[0]], end: keys[order[order.length - 1]], uses: [], owners: [], tol, thin: null });
    }
    arcs[id].uses.push({ ring, reversed });
    arcs[id].owners.push(ring);
    return { arc: id, reversed };
  };
  for (const ring of rings) {
    const { points, keys } = ring;
    const n = points.length;
    const cuts = [];
    for (let i = 0; i < n; i++) if (corner.has(keys[i])) cuts.push(i);
    if (cuts.length === 0) {
      ring.refs.push(register(points, keys, true, ring));
      continue;
    }
    for (let c = 0; c < cuts.length; c++) {
      const to = c + 1 < cuts.length ? cuts[c + 1] : cuts[0] + n;
      const pts = [];
      const ks = [];
      for (let i = cuts[c]; i <= to; i++) {
        pts.push(points[i % n]);
        ks.push(keys[i % n]);
      }
      ring.refs.push(register(pts, ks, false, ring));
    }
  }

  const thinOf = (arc) => dedupe(rounded(thinArc(arc.points, arc.tol, arc.closed), digits), 0, arc.closed);
  // A ring put together from its arcs; `from` says which arc each of its points came from.
  const assemble = (ring) => {
    const out = [];
    const from = [];
    for (const { arc, reversed } of ring.refs) {
      const pts = arcs[arc].thin;
      for (const p of reversed ? [...pts].reverse() : pts) {
        const q = out[out.length - 1];
        if (q && q[0] === p[0] && q[1] === p[1]) continue;
        out.push(p);
        from.push(arc);
      }
    }
    while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) {
      out.pop();
      from.pop();
    }
    ring.from = from;
    return out;
  };
  /**
   * The rings that cross themselves made whole: the arcs where they cross are thinned less, down to not at all, and
   * the rings that share those arcs are put together again.
   */
  let mended = 0;
  const repair = (list) => {
    let bad = list.filter((r) => crosses(r.out));
    for (let round = 0; bad.length > 0 && round < 48; round++) {
      const touched = new Set();
      for (const r of bad) {
        const n = r.out.length;
        for (const [i, j] of crossings(r.out)) for (const k of [i, i + 1, j, j + 1]) if (arcs[r.from[k % n]].tol > 0) touched.add(r.from[k % n]);
      }
      if (touched.size === 0) break;
      for (const id of touched) {
        arcs[id].tol = arcs[id].tol > tol / 1000 ? arcs[id].tol / 2 : 0;
        arcs[id].thin = thinOf(arcs[id]);
      }
      const again = new Set();
      for (const id of touched) for (const r of arcs[id].owners) again.add(r);
      for (const r of again) r.out = assemble(r);
      bad = list.filter((r) => again.has(r) && crosses(r.out));
    }
    // What still crosses, crosses in the data: the point of its arcs that makes it cross is taken out, where taking it
    // out leaves no ring that shares the arc crossing where it did not.
    for (const r of bad) {
      for (let tries = 0; tries < 24; tries++) {
        const pairs = crossings(r.out);
        if (pairs.length === 0) break;
        const [i, j] = pairs[0];
        const n = r.out.length;
        let done = false;
        for (const c of [r.out[i], r.out[(i + 1) % n], r.out[j], r.out[(j + 1) % n]]) {
          for (const { arc } of r.refs) {
            const a = arcs[arc];
            const f = 10 ** digits;
            const k = a.points.findIndex((p, m) => (a.closed || (m > 0 && m < a.points.length - 1)) && Math.round(p[0] * f) / f === c[0] && Math.round(p[1] * f) / f === c[1]);
            if (k < 0 || (a.closed && a.points.length <= 4)) continue;
            const was = { points: a.points, thin: a.thin, outs: a.owners.map((o) => o.out), froms: a.owners.map((o) => o.from), bad: a.owners.map((o) => crossings(o.out).length) };
            a.points = a.points.filter((_, m) => m !== k);
            a.thin = thinOf(a);
            for (const o of a.owners) o.out = assemble(o);
            const now = a.owners.map((o) => crossings(o.out).length);
            if (now[a.owners.indexOf(r)] < was.bad[a.owners.indexOf(r)] && now.every((v, m) => v <= was.bad[m])) {
              done = true;
              mended++;
              break;
            }
            a.points = was.points;
            a.thin = was.thin;
            // Each ring as it was, and where each of its points came from with it.
            a.owners.forEach((o, m) => {
              o.out = was.outs[m];
              o.from = was.froms[m];
            });
          }
          if (done) break;
        }
        if (!done) break;
      }
    }
  };
  for (const arc of arcs) arc.thin = thinOf(arc);
  for (const ring of rings) ring.out = assemble(ring);
  repair(rings);

  // Small islands go, but no shape loses its largest ring. An island is a ring that no other of its level runs along.
  const lonely = (ring) => ring.refs.every(({ arc }) => (inner ? arcs[arc].uses.filter((u) => u.ring.level === ring.level).length : arcs[arc].uses.length) === 1);
  const byShape = shapes.map(() => []);
  for (const ring of rings) if (!ring.hole) byShape[ring.shape].push(ring);
  for (const list of byShape) {
    list.sort((p, q) => area(q.out) - area(p.out));
    list.forEach((ring, k) => {
      if (ring.out.length < 3 || (k > 0 && lonely(ring) && area(ring.out) < minArea)) ring.kept = false;
    });
  }
  for (const ring of rings) if (ring.hole && (ring.out.length < 3 || (lonely(ring) && area(ring.out) < minArea))) ring.kept = false;
  // An island that a shape of level 1 keeps stays in the shape of level 0 it lies in, so that nothing lies over the sea.
  if (inner) {
    for (const ring of rings) {
      if (ring.kept || ring.level !== 0 || ring.out.length < 3) continue;
      if (ring.refs.every(({ arc }) => arcs[arc].uses.some((u) => u.ring.level === 1 && u.ring.kept))) ring.kept = true;
    }
  }

  // The land: the arcs one kept ring alone runs along, chained end to start; where a chain comes back through a point
  // it passed (two islands that touch at a corner), it is cut there into two rings. A group's outline is chained in
  // the same way from the arcs one kept ring of the group alone runs along.
  const chainLoops = (alone) => {
    const pieces = [];
    const loops = [];
    for (const { arc: id, reversed } of alone) {
      const arc = arcs[id];
      if (arc.closed) loops.push([{ arc: id, reversed }]);
      else pieces.push({ arc: id, reversed, from: reversed ? arc.end : arc.start, to: reversed ? arc.start : arc.end });
    }
    const byFrom = new Map();
    pieces.forEach((p, i) => byFrom.set(p.from, [...(byFrom.get(p.from) ?? []), i]));
    const taken = new Uint8Array(pieces.length);
    let open = 0;
    for (let i = 0; i < pieces.length; i++) {
      if (taken[i]) continue;
      const chain = [];
      const first = pieces[i].from;
      for (let cur = i; cur !== undefined && !taken[cur]; cur = (byFrom.get(pieces[cur].to) ?? []).find((k) => !taken[k])) {
        taken[cur] = 1;
        chain.push(pieces[cur]);
        if (pieces[cur].to === first) break;
      }
      if (chain[chain.length - 1].to !== first) {
        open++;
        continue;
      }
      const stack = [];
      const at = new Map();
      for (const p of chain) {
        const was = at.get(p.from);
        if (was !== undefined) {
          const loop = stack.splice(was);
          for (const q of loop) at.delete(q.from);
          loops.push(loop);
        }
        at.set(p.from, stack.length);
        stack.push(p);
      }
      if (stack.length > 0) loops.push(stack);
    }
    return { loops, open };
  };
  const alone = [];
  const pairs = new Map();
  const innerPairs = new Map();
  const grouped = keys.map(() => []);
  let shared = 0;
  /** Notes the arc as a border of the two shapes its users are of; false when they are one shape. */
  const pair = (map, users, id) => {
    const [s, t] = users.map((u) => u.ring.shape);
    if (s === t) return false;
    const key = s < t ? `${s},${t}` : `${t},${s}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(id);
    return true;
  };
  arcs.forEach((arc, id) => {
    const users = arc.uses.filter((u) => u.ring.kept && u.ring.level === 0);
    if (users.length === 1) alone.push({ arc: id, reversed: users[0].reversed });
    else if (users.length === 2 && pair(pairs, users, id)) shared++;
    if (inner) {
      const under = arc.uses.filter((u) => u.ring.kept && u.ring.level === 1);
      if (under.length === 2) pair(innerPairs, under, id);
    }
    keys.forEach((key, g) => {
      const mine = users.filter((u) => shapes[u.ring.shape].group === key);
      if (mine.length === 1) grouped[g].push({ arc: id, reversed: mine[0].reversed });
    });
  });
  const ringsOf = (loops) =>
    loops.map((refs) => {
      const ring = { refs, out: null };
      for (const { arc } of refs) arcs[arc].owners.push(ring);
      ring.out = assemble(ring);
      return ring;
    });
  const { loops, open } = chainLoops(alone);
  const coast = ringsOf(loops);
  const groupRings = grouped.map((list) => ringsOf(chainLoops(list).loops));
  const kept = rings.filter((r) => r.kept);
  repair([...kept, ...coast, ...groupRings.flat()]);

  const bySize = (p, q) => area(q) - area(p) || p[0][0] - q[0][0] || p[0][1] - q[0][1];
  const outward = (list) => list.map((r) => r.out).filter((r) => r.length >= 3 && signedArea(r) > 0).sort(bySize);
  const inward = (list) => list.map((r) => r.out).filter((r) => r.length >= 3 && signedArea(r) < 0).sort(bySize);
  const bordersOf = (map) =>
    [...map.entries()]
      .map(([key, ids]) => {
        const [a, b] = key.split(',').map(Number);
        const lines = ids.map((id) => (arcs[id].closed ? [...arcs[id].thin, arcs[id].thin[0]] : arcs[id].thin));
        return { a, b, lines: joinLines(lines, { eps: 0 }).map((c) => (c.closed ? [...c.line, c.line[0]] : c.line)) };
      })
      .sort((p, q) => p.a - q.a || p.b - q.b);

  return {
    shapes: byShape.map((list) => ({ rings: list.filter((r) => r.kept).map((r) => r.out) })),
    land: outward(coast),
    gaps: inward(coast),
    borders: bordersOf(pairs),
    stats: { arcs: arcs.length, shared, crossing: [...kept, ...coast].filter((r) => crosses(r.out)).length, open, mended },
    ...(inner ? { inner: { borders: bordersOf(innerPairs) } } : {}),
    ...(keys.length > 0 ? { groups: keys.map((key, g) => ({ key, land: outward(groupRings[g]), gaps: inward(groupRings[g]) })) } : {}),
  };
}
