// Plane geometry of the pipeline: lines and rings of [x, y]. A ring is closed and is written without
// its first point repeated at the end. Simplifying is Douglas–Peucker, held to outlines that do not
// cross themselves; beside it are smoothing, cutting to a box into whole rings, and the equal point
// counts a morph between two outlines needs.

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The area of a ring with its sign: positive when it runs counter-clockwise (x east, y north). */
export function signedArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

export const area = (ring) => Math.abs(signedArea(ring));

/** The ring running counter-clockwise (or clockwise, `ccw: false`). */
export function orient(ring, ccw = true) {
  return signedArea(ring) >= 0 === ccw ? ring : [...ring].reverse();
}

/** The length of a line, or of a ring with its closing edge. */
export function lengthOf(points, closed = false) {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += dist(points[i - 1], points[i]);
  if (closed && points.length > 1) len += dist(points[points.length - 1], points[0]);
  return len;
}

/** [x0, y0, x1, y1] round the points. */
export function boxOf(points) {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

export const boxesMeet = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** The centre of area of a ring. */
export function centroid(ring) {
  let [cx, cy, a] = [0, 0, 0];
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    const f = x0 * y1 - x1 * y0;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
    a += f;
  }
  if (Math.abs(a) < 1e-12) return ring[0] ? [...ring[0]] : [0, 0];
  return [cx / (3 * a), cy / (3 * a)];
}

/** Whether a point lies inside a ring (even-odd). */
export function pointInRing([px, py], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The points without repeats: none within `eps` of the one before it, nor, in a ring, the last of the first. */
export function dedupe(points, eps = 1e-9, closed = false) {
  const out = [];
  for (const p of points) {
    const q = out[out.length - 1];
    if (!q || dist(p, q) > eps) out.push(p);
  }
  if (closed) while (out.length > 1 && dist(out[0], out[out.length - 1]) <= eps) out.pop();
  return out;
}

/** The points rounded to `digits` decimals, without the repeats that rounding makes. */
export function roundPoints(points, digits = 1, closed = false) {
  const f = 10 ** digits;
  return dedupe(points.map(([x, y]) => [Math.round(x * f) / f + 0, Math.round(y * f) / f + 0]), 1e-12, closed);
}

function douglasPeucker(pts, i0, j0, tol, keep) {
  const stack = [[i0, j0]];
  while (stack.length > 0) {
    const [i, j] = stack.pop();
    const [ax, ay] = pts[i];
    const [bx, by] = pts[j];
    const len = Math.hypot(bx - ax, by - ay);
    let far = -1;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      // Where the two ends coincide (a ring's halves meet), the distance is that to the point itself.
      const d = len < 1e-12 ? Math.hypot(pts[k][0] - ax, pts[k][1] - ay) : Math.abs((bx - ax) * (ay - pts[k][1]) - (ax - pts[k][0]) * (by - ay)) / len;
      if (d > far) [far, at] = [d, k];
    }
    if (far > tol) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
}

/**
 * Douglas–Peucker: drops the points closer than `tol` to the line of their neighbours. A ring is
 * split at the point farthest from its first, and both halves are simplified; an open line keeps its ends.
 */
export function simplify(points, tol, closed = false) {
  if (points.length < (closed ? 4 : 3) || !(tol > 0)) return [...points];
  if (!closed) {
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    douglasPeucker(points, 0, points.length - 1, tol, keep);
    return points.filter((_, k) => keep[k]);
  }
  const pts = [...points, points[0]];
  let mid = 1;
  for (let k = 1; k < points.length; k++) if (dist(pts[k], pts[0]) > dist(pts[mid], pts[0])) mid = k;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[mid] = 1;
  douglasPeucker(pts, 0, mid, tol, keep);
  douglasPeucker(pts, mid, pts.length - 1, tol, keep);
  return points.filter((_, k) => keep[k]);
}

const side = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));

/**
 * Whether an outline crosses or touches itself: two of its edges that share no point meet. The edges
 * are swept by x, so a long outline is still quick.
 */
export function crosses(points, closed = true) {
  const n = points.length;
  const count = closed ? n : n - 1;
  if (count < 3) return false;
  const edges = [];
  for (let i = 0; i < count; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    edges.push([Math.min(a[0], b[0]), Math.max(a[0], b[0]), i]);
  }
  edges.sort((p, q) => p[0] - q[0] || p[2] - q[2]);
  for (let e = 0; e < edges.length; e++) {
    const [, max, i] = edges[e];
    const a = points[i];
    const b = points[(i + 1) % n];
    for (let f = e + 1; f < edges.length && edges[f][0] <= max; f++) {
      const j = edges[f][2];
      const gap = Math.abs(i - j);
      if (gap <= 1 || (closed && gap === n - 1)) continue;
      const c = points[j];
      const d = points[(j + 1) % n];
      if (Math.max(c[1], d[1]) < Math.min(a[1], b[1]) || Math.min(c[1], d[1]) > Math.max(a[1], b[1])) continue;
      if (side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b)) return true;
    }
  }
  return false;
}

/**
 * A line or ring simplified to `tol` without crossing itself: the tolerance is halved while the
 * simplified outline crosses itself, down to a thousandth of `tol`. Returns null if it still does
 * (the outline given already crossed itself).
 */
export function simplifySafe(points, tol, closed = false) {
  for (let t = tol; t >= tol / 1024; t /= 2) {
    const out = simplify(points, t, closed);
    if (!crosses(out, closed)) return out;
  }
  return crosses(points, closed) ? null : [...points];
}

/**
 * Chaikin's corner cutting, `times` over: each corner is replaced by two points a quarter along its
 * edges, and no farther from it than `reach`, so that a long straight edge keeps its ends (the edge
 * of a frame, a quay). An open line keeps its ends.
 */
export function chaikin(points, times = 1, closed = false, reach = Infinity) {
  let pts = points;
  for (let t = 0; t < times; t++) {
    const n = pts.length;
    if (n < 3) break;
    const out = [];
    const last = closed ? n : n - 1;
    if (!closed) out.push(pts[0]);
    for (let i = 0; i < last; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const len = dist(a, b);
      const q = len > 0 ? Math.min(0.25, reach / len) : 0.25;
      out.push([a[0] + (b[0] - a[0]) * q, a[1] + (b[1] - a[1]) * q], [b[0] + (a[0] - b[0]) * q, b[1] + (a[1] - b[1]) * q]);
    }
    if (!closed) out.push(pts[n - 1]);
    pts = out;
  }
  return pts;
}

/**
 * The soft form of a line or ring: simplified to `tol`, its corners cut `times` over (each by `reach`
 * at the most, eight times `tol` by default), then thinned again to a fifth of `tol`; the corner
 * cutting is given up, a round at a time, if the result crosses itself.
 */
export function soften(points, tol, times = 2, closed = false, reach = tol * 8) {
  const base = simplifySafe(points, tol, closed);
  if (!base) return null;
  for (let t = times; t > 0; t--) {
    const out = simplify(chaikin(base, t, closed, reach), tol / 5, closed);
    if (!crosses(out, closed)) return out;
  }
  return base;
}

/** `n` points spaced evenly along a line (its ends kept), or along a ring from its first point. */
export function resample(points, n, closed = false) {
  const pts = closed ? [...points, points[0]] : points;
  const total = lengthOf(pts);
  const out = [];
  const steps = closed ? n : n - 1;
  let seg = 0;
  let before = 0;
  let segLen = dist(pts[0], pts[1]);
  for (let k = 0; k < n; k++) {
    const s = Math.min(total, (k * total) / steps);
    while (seg < pts.length - 2 && before + segLen < s) {
      before += segLen;
      seg++;
      segLen = dist(pts[seg], pts[seg + 1]);
    }
    const t = segLen > 0 ? Math.min(1, Math.max(0, (s - before) / segLen)) : 0;
    out.push([pts[seg][0] + (pts[seg + 1][0] - pts[seg][0]) * t, pts[seg][1] + (pts[seg + 1][1] - pts[seg][1]) * t]);
  }
  return out;
}

/**
 * A ring of as many points as `ref`, turned to start where it best matches it: the start that makes
 * the sum of the squared distances between the points of the same index least. Both run the same
 * way round. A morph between the two then moves each point the short way, without a twist.
 */
export function alignTo(ring, ref) {
  const n = ring.length;
  if (n !== ref.length) throw new Error(`alignTo: ${n} points against ${ref.length}`);
  let best = 0;
  let bestSum = Infinity;
  for (let s = 0; s < n; s++) {
    let sum = 0;
    for (let i = 0; i < n && sum < bestSum; i++) {
      const p = ring[(i + s) % n];
      const q = ref[i];
      sum += (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
    }
    if (sum < bestSum) [bestSum, best] = [sum, s];
  }
  return ring.map((_, i) => ring[(i + best) % n]);
}

/**
 * Outlines made ready for a morph: each resampled to `n` points evenly spaced along it, all
 * counter-clockwise, the first starting at its northernmost point and each next one turned to match
 * the one before it.
 */
export function morphRings(rings, n) {
  const out = [];
  for (const ring of rings) {
    let r = orient(ring, true);
    if (out.length === 0) {
      let top = 0;
      for (let i = 1; i < r.length; i++) if (r[i][1] > r[top][1]) top = i;
      r = r.map((_, i) => r[(i + top) % r.length]);
      out.push(resample(r, n, true));
    } else {
      // The start is searched on a ring already resampled, so it is one of its n points.
      out.push(alignTo(resample(r, n, true), out[out.length - 1]));
    }
  }
  return out;
}

/** The part of the segment a-b inside the box, as [t0, t1] along it, or null. Liang–Barsky. */
function clipSegment(a, b, [x0, y0, x1, y1]) {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  for (const [p, q] of [[-dx, a[0] - x0], [dx, x1 - a[0]], [-dy, a[1] - y0], [dy, y1 - a[1]]]) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return [t0, t1];
}

const lerp = (a, b, t) => (t <= 0 ? [a[0], a[1]] : t >= 1 ? [b[0], b[1]] : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);

/** The pieces of a line inside a box: each a line of two points or more. */
export function clipLine(points, box) {
  const out = [];
  let open = null;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const cut = clipSegment(a, b, box);
    if (!cut || cut[1] - cut[0] <= 0) {
      if (open && open.length > 1) out.push(open);
      open = null;
      continue;
    }
    if (!open) open = [lerp(a, b, cut[0])];
    open.push(lerp(a, b, cut[1]));
    if (cut[1] < 1) {
      if (open.length > 1) out.push(open);
      open = null;
    }
  }
  if (open && open.length > 1) out.push(open);
  return out.map((line) => dedupe(line)).filter((line) => line.length > 1);
}

/** Where a point of the box's edge lies along it, counter-clockwise from its south-west corner: 0 to 4. */
function edgeParam([x, y], [x0, y0, x1, y1]) {
  const w = x1 - x0;
  const h = y1 - y0;
  const eps = 1e-9 * Math.max(w, h);
  if (Math.abs(y - y0) <= eps && x < x1 - eps) return Math.max(0, (x - x0) / w);
  if (Math.abs(x - x1) <= eps && y < y1 - eps) return 1 + Math.max(0, (y - y0) / h);
  if (Math.abs(y - y1) <= eps && x > x0 + eps) return 2 + Math.max(0, (x1 - x) / w);
  if (Math.abs(x - x0) <= eps) return 3 + Math.max(0, (y1 - y) / h);
  // Not on the edge (a chain that ends inside the box): the nearest edge point is taken.
  const d = [y - y0, x1 - x, y1 - y, x - x0];
  const k = d.indexOf(Math.min(...d));
  return [(x - x0) / w, 1 + (y - y0) / h, 2 + (x1 - x) / w, 3 + (y1 - y) / h][k];
}

const CORNERS = (box) => [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]];

/**
 * Rings made of chains that begin and end on the edge of a box, each with its inside on its left:
 * from the end of a chain the edge of the box is followed counter-clockwise to the nearest beginning
 * of a chain, and so on round to the first. This closes a coast cut by a frame into whole pieces of
 * land (OpenStreetMap draws a coastline with the land on its left), and a ring cut by a box.
 */
export function closeChains(chains, box) {
  const corners = CORNERS(box);
  const items = chains.map((points) => ({ points, start: edgeParam(points[0], box), end: edgeParam(points[points.length - 1], box), used: false }));
  const rings = [];
  for (const first of items) {
    if (first.used) continue;
    const ring = [];
    let cur = first;
    for (let guard = 0; guard <= items.length; guard++) {
      cur.used = true;
      ring.push(...cur.points);
      // The nearest beginning counter-clockwise from this end; the first chain's own beginning closes the ring.
      let next = null;
      let gap = Infinity;
      for (const it of items) {
        if (it.used && it !== first) continue;
        const g = (it.start - cur.end + 4) % 4;
        if (g < gap) [gap, next] = [g, it];
      }
      for (let c = Math.floor(cur.end) + 1; c <= cur.end + gap; c++) ring.push(corners[c % 4]);
      if (!next || next === first) break;
      cur = next;
    }
    const clean = dedupe(ring, 1e-9, true);
    if (clean.length >= 3) rings.push(clean);
  }
  return rings;
}

/**
 * The parts of a ring inside a box, each a whole ring that runs counter-clockwise: where the ring
 * leaves the box, the box's edge is followed to where it comes back (Weiler–Atherton for a rectangle),
 * so no piece runs back along the edge over itself.
 */
export function clipRing(ringIn, box) {
  const ring = orient(ringIn, true);
  const [x0, y0, x1, y1] = box;
  const inside = (p) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
  const n = ring.length;
  const firstOut = ring.findIndex((p) => !inside(p));
  if (firstOut < 0) return [ring];
  const chains = [];
  let open = null;
  for (let s = 0; s < n; s++) {
    const a = ring[(firstOut + s) % n];
    const b = ring[(firstOut + s + 1) % n];
    const cut = clipSegment(a, b, box);
    if (!cut || (cut[1] - cut[0] <= 0 && !open)) {
      if (open && open.length > 1) chains.push(open);
      open = null;
      continue;
    }
    if (!open) open = [lerp(a, b, cut[0])];
    open.push(lerp(a, b, cut[1]));
    if (cut[1] < 1) {
      if (open.length > 1) chains.push(open);
      open = null;
    }
  }
  if (open && open.length > 1) chains.push(open);
  const whole = chains.map((c) => dedupe(c)).filter((c) => c.length > 1);
  if (whole.length === 0) {
    // The ring does not enter the box: it lies outside it, or round it.
    return pointInRing([(x0 + x1) / 2, (y0 + y1) / 2], ring) ? [CORNERS(box)] : [];
  }
  return closeChains(whole, box).filter((r) => area(r) > 0);
}
