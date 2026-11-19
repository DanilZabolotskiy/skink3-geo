// Rasters of the geo pipeline: a grid of values over a box of the plane, used to turn many
// overlapping polygons into one clean outline (a river mapped as a hundred adjoining pieces, a
// built-up area mapped as thousands of blocks) and to draw the forms of the ground (contours, hills).
// A grid has `w` × `h` samples, `cell` metres apart; sample (i, j) stands at
// [x0 + (i + 0.5) cell, y0 + (j + 0.5) cell], row 0 in the south.

export function makeGrid([x0, y0, x1, y1], cell, fill = 0) {
  const w = Math.max(2, Math.ceil((x1 - x0) / cell));
  const h = Math.max(2, Math.ceil((y1 - y0) / cell));
  const data = new Float32Array(w * h);
  if (fill !== 0) data.fill(fill);
  return { x0, y0, cell, w, h, data };
}

export const like = (g, data = new Float32Array(g.w * g.h)) => ({ x0: g.x0, y0: g.y0, cell: g.cell, w: g.w, h: g.h, data });

/** The sample nearest a point of the plane, as its index, or -1 outside the grid. */
export function cellAt(g, [x, y]) {
  const i = Math.floor((x - g.x0) / g.cell);
  const j = Math.floor((y - g.y0) / g.cell);
  return i < 0 || j < 0 || i >= g.w || j >= g.h ? -1 : j * g.w + i;
}

/**
 * Fills a polygon into the grid with `value`: the rings together, even-odd, so a ring inside another
 * is a hole. A sample is filled when its centre lies inside.
 */
export function fillPolygon(g, rings, value = 1) {
  let [minY, maxY] = [Infinity, -Infinity];
  for (const ring of rings) for (const p of ring) {
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const j0 = Math.max(0, Math.ceil((minY - g.y0) / g.cell - 0.5));
  const j1 = Math.min(g.h - 1, Math.floor((maxY - g.y0) / g.cell - 0.5));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const y = g.y0 + (j + 0.5) * g.cell;
    xs.length = 0;
    for (const ring of rings) {
      for (let k = 0, m = ring.length - 1; k < ring.length; m = k++) {
        const [xa, ya] = ring[m];
        const [xb, yb] = ring[k];
        if (ya > y !== yb > y) xs.push(xa + ((y - ya) / (yb - ya)) * (xb - xa));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - g.x0) / g.cell - 0.5));
      const i1 = Math.min(g.w - 1, Math.ceil((xs[k + 1] - g.x0) / g.cell - 0.5) - 1);
      for (let i = i0; i <= i1; i++) g.data[j * g.w + i] = value;
    }
  }
}

/** A Gaussian blur of `sigma` samples, as three box blurs each way; the edges repeat their last sample. */
export function blur(g, sigma) {
  if (!(sigma > 0)) return like(g, Float32Array.from(g.data));
  // The widths of three boxes that make a Gaussian of this sigma (Kovesi).
  const ideal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let lo = Math.floor(ideal);
  if (lo % 2 === 0) lo--;
  const m = Math.round((12 * sigma * sigma - 3 * lo * lo - 12 * lo - 9) / (-4 * lo - 4));
  const widths = [0, 1, 2].map((k) => (k < m ? lo : lo + 2));
  let src = Float32Array.from(g.data);
  let dst = new Float32Array(src.length);
  const { w, h } = g;
  const pass = (r, n, stride, lines, lineStride) => {
    for (let l = 0; l < lines; l++) {
      const base = l * lineStride;
      let sum = 0;
      const at = (k) => src[base + Math.min(n - 1, Math.max(0, k)) * stride];
      for (let k = -r; k <= r; k++) sum += at(k);
      for (let k = 0; k < n; k++) {
        dst[base + k * stride] = sum / (2 * r + 1);
        sum += at(k + r + 1) - at(k - r);
      }
    }
    [src, dst] = [dst, src];
  };
  for (const width of widths) {
    const r = (width - 1) / 2;
    if (r < 1) continue;
    pass(r, w, 1, h, w);
    pass(r, h, w, w, 1);
  }
  return like(g, src);
}

/** For each sample, the distance in samples to the nearest sample where `on(value)` holds (Felzenszwalb and Huttenlocher). */
export function distanceTo(g, on) {
  const { w, h } = g;
  const INF = 1e20;
  const d = new Float64Array(w * h);
  for (let k = 0; k < d.length; k++) d[k] = on(g.data[k]) ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const line = (offset, stride, len) => {
    for (let q = 0; q < len; q++) f[q] = d[offset + q * stride];
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s;
      do {
        const p = v[k];
        s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
      } while (s <= z[k] && --k >= 0);
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      const p = v[k];
      d[offset + q * stride] = (q - p) * (q - p) + f[p];
    }
  };
  for (let i = 0; i < w; i++) line(i, w, h);
  for (let j = 0; j < h; j++) line(j * w, 1, w);
  const out = new Float32Array(w * h);
  for (let k = 0; k < out.length; k++) out[k] = Math.sqrt(d[k]);
  return like(g, out);
}

/** A mask (1 or 0) of the samples where `on(value)` holds. */
export function mask(g, on) {
  const out = new Float32Array(g.w * g.h);
  for (let k = 0; k < out.length; k++) out[k] = on(g.data[k]) ? 1 : 0;
  return like(g, out);
}

/** A mask grown by `r` samples (`r` > 0) or shrunk by `-r` samples (`r` < 0), round. */
export function grow(g, r) {
  if (r === 0) return like(g, Float32Array.from(g.data));
  if (r > 0) return mask(distanceTo(g, (v) => v >= 0.5), (v) => v <= r);
  return mask(distanceTo(g, (v) => v < 0.5), (v) => v > -r);
}

/** A mask closed over gaps narrower than `2 r` samples: grown by `r`, then shrunk by `r`. */
export const closeGaps = (g, r) => grow(grow(g, r), -r);

/** The part of a mask joined to the sample `seed` (by edges), as a mask; empty if the seed is off. */
export function component(g, seed) {
  const { w, h } = g;
  const out = new Float32Array(w * h);
  if (seed < 0 || g.data[seed] < 0.5) return like(g, out);
  const stack = [seed];
  out[seed] = 1;
  while (stack.length > 0) {
    const k = stack.pop();
    const i = k % w;
    const j = (k - i) / w;
    if (i > 0 && !out[k - 1] && g.data[k - 1] >= 0.5) (out[k - 1] = 1), stack.push(k - 1);
    if (i < w - 1 && !out[k + 1] && g.data[k + 1] >= 0.5) (out[k + 1] = 1), stack.push(k + 1);
    if (j > 0 && !out[k - w] && g.data[k - w] >= 0.5) (out[k - w] = 1), stack.push(k - w);
    if (j < h - 1 && !out[k + w] && g.data[k + w] >= 0.5) (out[k + w] = 1), stack.push(k + w);
  }
  return like(g, out);
}

/** The joined parts of a mask: { labels (Int32Array, 0 where off), sizes (by label, in samples) }. */
export function components(g) {
  const { w, h } = g;
  const labels = new Int32Array(w * h);
  const sizes = [0];
  const stack = [];
  for (let s = 0; s < labels.length; s++) {
    if (labels[s] || g.data[s] < 0.5) continue;
    const label = sizes.length;
    let size = 0;
    labels[s] = label;
    stack.push(s);
    while (stack.length > 0) {
      const k = stack.pop();
      size++;
      const i = k % w;
      const j = (k - i) / w;
      for (const m of [i > 0 ? k - 1 : -1, i < w - 1 ? k + 1 : -1, j > 0 ? k - w : -1, j < h - 1 ? k + w : -1]) {
        if (m >= 0 && !labels[m] && g.data[m] >= 0.5) {
          labels[m] = label;
          stack.push(m);
        }
      }
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

/** A mask with its holes filled: every off sample that cannot reach the edge of the grid is turned on. */
export function fillHoles(g) {
  const { w, h } = g;
  const outside = new Uint8Array(w * h);
  const stack = [];
  const seed = (k) => {
    if (!outside[k] && g.data[k] < 0.5) {
      outside[k] = 1;
      stack.push(k);
    }
  };
  for (let i = 0; i < w; i++) (seed(i), seed((h - 1) * w + i));
  for (let j = 0; j < h; j++) (seed(j * w), seed(j * w + w - 1));
  while (stack.length > 0) {
    const k = stack.pop();
    const i = k % w;
    const j = (k - i) / w;
    if (i > 0) seed(k - 1);
    if (i < w - 1) seed(k + 1);
    if (j > 0) seed(k - w);
    if (j < h - 1) seed(k + w);
  }
  const out = new Float32Array(w * h);
  for (let k = 0; k < out.length; k++) out[k] = outside[k] ? 0 : 1;
  return like(g, out);
}

/**
 * The contour of a grid at `level`, by marching squares with the crossing points placed between the
 * samples in proportion: { rings, lines } in the plane. Every piece keeps the high side on its left,
 * so the ring round a high area runs counter-clockwise and a ring round a hollow in it clockwise.
 * With `closed` (the default), the grid is taken as low beyond its edge, so every contour is a ring.
 */
export function contours(g, level, { closed = true } = {}) {
  const pad = closed ? 1 : 0;
  const W = g.w + 2 * pad;
  const H = g.h + 2 * pad;
  const low = level - 1e6;
  const val = (i, j) => {
    const [a, b] = [i - pad, j - pad];
    return a < 0 || b < 0 || a >= g.w || b >= g.h ? low : g.data[b * g.w + a];
  };
  const px = (i) => g.x0 + (i - pad + 0.5) * g.cell;
  const py = (j) => g.y0 + (j - pad + 0.5) * g.cell;
  // An edge between two samples has one id: 2 (j W + i) for the edge east of (i, j), + 1 for the edge north of it.
  const next = new Map();
  const point = new Map();
  const crossing = (id, i0, j0, i1, j1, v0, v1) => {
    if (!point.has(id)) {
      const t = (level - v0) / (v1 - v0);
      point.set(id, [px(i0) + (px(i1) - px(i0)) * t, py(j0) + (py(j1) - py(j0)) * t]);
    }
  };
  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      // The corners counter-clockwise from the south-west, and the edge after each.
      const v = [val(i, j), val(i + 1, j), val(i + 1, j + 1), val(i, j + 1)];
      const hi = v.map((x) => x >= level);
      const n = hi[0] + hi[1] + hi[2] + hi[3];
      if (n === 0 || n === 4) continue;
      const ids = [2 * (j * W + i), 2 * (j * W + i + 1) + 1, 2 * ((j + 1) * W + i), 2 * (j * W + i) + 1];
      const ends = [[i, j, i + 1, j], [i + 1, j, i + 1, j + 1], [i + 1, j + 1, i, j + 1], [i, j + 1, i, j]];
      const down = [];
      const up = [];
      for (let k = 0; k < 4; k++) {
        const m = (k + 1) % 4;
        if (hi[k] === hi[m]) continue;
        crossing(ids[k], ...ends[k], v[k], v[m]);
        (hi[k] ? down : up).push(k);
      }
      if (down.length === 1) next.set(ids[down[0]], ids[up[0]]);
      else {
        // A saddle: the middle decides whether the two high corners are joined.
        const joined = (v[0] + v[1] + v[2] + v[3]) / 4 >= level;
        for (const k of down) next.set(ids[k], ids[joined ? (k + 1) % 4 : (k + 3) % 4]);
      }
    }
  }
  const begun = new Set(next.values());
  const rings = [];
  const lines = [];
  const walk = (start) => {
    const pts = [];
    let id = start;
    while (id !== undefined && next.has(id)) {
      pts.push(point.get(id));
      const to = next.get(id);
      next.delete(id);
      id = to;
      if (id === start) return [pts, true];
    }
    if (id !== undefined) pts.push(point.get(id));
    return [pts, false];
  };
  // The open lines first, each from the piece no other piece leads to; what is left are rings.
  for (const id of [...next.keys()]) if (!begun.has(id) && next.has(id)) lines.push(walk(id)[0]);
  for (const id of [...next.keys()]) {
    if (!next.has(id)) continue;
    const [pts, ring] = walk(id);
    (ring ? rings : lines).push(pts);
  }
  return { rings: rings.filter((r) => r.length >= 3), lines: lines.filter((l) => l.length >= 2) };
}
