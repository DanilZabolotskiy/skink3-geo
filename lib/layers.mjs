// The layers of a city's map, each built from the downloads of its source into simple outlines in
// the plane of its frame (metres, x east, y north). A builder takes its part of the city's spec and
// what was downloaded for it, and returns the layer; it reads data and never the network.

import { readFileSync } from 'node:fs';
import { area, boxOf, boxesMeet, centroid, clipLine, clipRing, closeChains, crosses, dedupe, dist, lengthOf, morphRings, orient, pointInRing, resample, roundPoints, signedArea, simplify, simplifySafe, sliceLine, soften } from './geom.mjs';
import { alive, areasOf, joinLines, waysOf, yearOf } from './osm.mjs';
import { blur, cellAt, closeGaps, component, components, contours, fillHoles, fillPolygon, grow, like, makeGrid, mask } from './raster.mjs';
import { thinTogether } from './topology.mjs';

const round1 = (v) => Math.round(v * 10) / 10 + 0;
const ha = (ring) => Math.round(area(ring) / 1000) / 10;
const km = (m) => Math.round(m / 10) / 100;
const slug = (text) => text.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The features of a Natural Earth GeoJSON file. */
export const featuresOf = (path) => JSON.parse(readFileSync(path, 'utf8')).features;

/** The outer rings of a GeoJSON polygon or multipolygon, each without its repeated last point. */
function outerRings(geometry) {
  if (!geometry) return [];
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polys.map((p) => p[0].slice(0, -1)).filter((r) => r.length >= 3);
}

/** The lines of a GeoJSON line or multiline. */
function linesOfGeometry(geometry) {
  if (!geometry) return [];
  return geometry.type === 'LineString' ? [geometry.coordinates] : geometry.type === 'MultiLineString' ? geometry.coordinates : [];
}

/** A ring in lon/lat brought into a frame: projected, cut to its box into whole rings, simplified without crossings, rounded. */
function ringsInFrame(ring, proj, box, tol, digits, minArea) {
  const out = [];
  for (const piece of clipRing(dedupe(ring.map(proj.forward), 1e-6, true), box)) {
    const cut = simplifySafe(piece, tol, true);
    if (!cut || cut.length < 3) continue;
    const r = roundPoints(cut, digits, true);
    if (r.length >= 3 && area(r) >= minArea && !crosses(r)) out.push(orient(r, true));
  }
  return out;
}

/** A line in lon/lat brought into a frame: projected, cut to its box, simplified, rounded. */
function linesInFrame(line, proj, box, tol, digits, minLength = 0, smooth = 0) {
  const out = [];
  for (const piece of clipLine(dedupe(line.map(proj.forward), 1e-6), box)) {
    const cut = smooth > 0 ? soften(piece, tol, smooth, false) ?? simplify(piece, tol) : simplify(piece, tol);
    const r = roundPoints(cut, digits);
    if (r.length >= 2 && lengthOf(r) >= minLength) out.push(r);
  }
  return out;
}

const lonLatBox = (ring) => boxOf(ring);

/** A river a spec wants: its name, or { id, name, match } with a regular expression of its names in the source. */
export const riverOf = (want) => (typeof want === 'string' ? { id: slug(want), name: want, match: `^${literal(want)}$` } : want);

/**
 * The rivers wanted, as lines: the ways of each (a waterway that is a river or a canal, with a name
 * that matches) joined end to end and brought into the frame. `part` cuts a joined line, in lon/lat,
 * into the stretches to keep; all of it by default.
 */
function riverLines(wants, elements, { proj, box }, { tol, digits, minLength, part = (line) => [line] }) {
  const rivers = [];
  for (const want of wants ?? []) {
    const river = riverOf(want);
    const named = new RegExp(river.match);
    const ways = waysOf(elements, (t) => (t.waterway === 'river' || t.waterway === 'canal') && (named.test(t.name ?? '') || named.test(t['name:en'] ?? '')));
    const lines = [];
    for (const chain of joinLines(ways.map((w) => w.line))) for (const piece of part(chain.line)) lines.push(...linesInFrame(piece, proj, box, tol, digits, minLength, 1));
    lines.sort((a, b) => lengthOf(b) - lengthOf(a) || a[0][0] - b[0][0]);
    if (lines.length > 0) rivers.push({ id: `river-${river.id ?? slug(river.name)}`, name: river.name, lengthKm: km(lines.reduce((sum, l) => sum + lengthOf(l), 0)), lines });
  }
  return rivers;
}

/**
 * The country and the land round it, from Natural Earth: the land of the frame (every country as one
 * land, cut to the frame), the country's own outline, its land borders, the large rivers and lakes.
 */
export function buildRegion(spec, frame, files) {
  const { proj, box, lonlat } = frame;
  const tol = spec.detail ?? Math.round((box[3] - box[1]) / 2200);
  const minArea = spec.minArea ?? (tol * 6) ** 2;
  // A ring is looked at only if its lon/lat box comes near the frame's.
  const near = [lonlat[0] - 3, lonlat[1] - 3, lonlat[2] + 3, lonlat[3] + 3];
  const bySize = (a, b) => area(b) - area(a) || a[0][0] - b[0][0] || a[0][1] - b[0][1];
  const land = [];
  for (const file of files.land) {
    for (const f of featuresOf(file)) {
      for (const ring of outerRings(f.geometry)) {
        if (!boxesMeet(lonLatBox(ring), near)) continue;
        land.push(...ringsInFrame(ring, proj, box, tol, 0, minArea));
      }
    }
  }
  land.sort(bySize);
  const out = { land: land.map((ring, k) => ({ id: `land-${k}`, ring })) };

  if (spec.country) {
    const country = featuresOf(files.countries).find((f) => f.properties.ADM0_A3 === spec.country);
    if (!country) throw new Error(`region: no country ${spec.country} in Natural Earth`);
    const rings = [];
    for (const ring of outerRings(country.geometry)) rings.push(...ringsInFrame(ring, proj, box, tol, 0, minArea));
    rings.sort(bySize);
    out.country = { id: spec.country.toLowerCase(), name: country.properties.NAME, rings };
    const borders = [];
    for (const f of featuresOf(files.borders)) {
      const p = f.properties;
      if (p.ADM0_A3_L !== spec.country && p.ADM0_A3_R !== spec.country) continue;
      const other = p.ADM0_A3_L === spec.country ? p.ADM0_RIGHT : p.ADM0_LEFT;
      const lines = [];
      for (const chain of joinLines(linesOfGeometry(f.geometry), { eps: 1e-9 })) lines.push(...linesInFrame(chain.closed ? [...chain.line, chain.line[0]] : chain.line, proj, box, tol, 0, tol * 4));
      if (lines.length > 0) borders.push({ id: `border-${String(other).toLowerCase().replace(/[^a-z]+/g, '-')}`, with: other, lines });
    }
    out.borders = borders.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  if (spec.rivers) {
    const want = new Set(spec.rivers.names ?? []);
    const rank = spec.rivers.rank ?? -1;
    const byName = new Map();
    for (const f of featuresOf(files.rivers)) {
      const p = f.properties;
      if (!p.name || !(want.has(p.name) || want.has(p.name_en) || p.scalerank <= rank)) continue;
      for (const line of linesOfGeometry(f.geometry)) {
        if (!boxesMeet(lonLatBox(line), lonlat)) continue;
        if (!byName.has(p.name)) byName.set(p.name, { name: p.name_en || p.name, lines: [] });
        byName.get(p.name).lines.push(line);
      }
    }
    out.rivers = [...byName.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([key, r]) => {
      const lines = [];
      for (const chain of joinLines(r.lines, { eps: 1e-9 })) lines.push(...linesInFrame(chain.line, proj, box, tol, 0, tol * 8, 1));
      return { id: `river-${key.toLowerCase().normalize('NFD').replace(/[^a-z]+/g, '-')}`, name: r.name, lines };
    }).filter((r) => r.lines.length > 0);
  }

  if (spec.lakes) {
    const rank = spec.lakes.rank ?? 9;
    const lakes = [];
    for (const f of featuresOf(files.lakes)) {
      if (f.properties.scalerank > rank) continue;
      for (const ring of outerRings(f.geometry)) {
        if (!boxesMeet(lonLatBox(ring), lonlat)) continue;
        for (const r of ringsInFrame(ring, proj, box, tol / 2, 0, (spec.lakes.minArea ?? minArea))) lakes.push({ name: f.properties.name_en || f.properties.name || '', ring: r });
      }
    }
    lakes.sort((a, b) => area(b.ring) - area(a.ring));
    out.lakes = lakes.map((l, k) => ({ id: `lake-${k}`, ...l }));
  }
  return out;
}

/**
 * Water at a city's scale: a river with its banks, lakes, basins, the sea. Every source asked for is
 * filled into one grid, and its outline is traced, so the water comes out as a few whole forms
 * however many pieces a river is mapped in; an island is a ring of its own, to be drawn over the water.
 *   osm      an Overpass answer of OpenStreetMap: water areas, and coastlines (the sea is the frame
 *            less the land they close with its edge)
 *   ohm      an Overpass answer of OpenHistoricalMap: the water areas and islets that stand in
 *            `spec.year` (today by default); its coastlines are not used, they come in pieces
 *   waterAt  ([lon, lat]) => 0..1, the water mask of an elevation model: the sea, and what the others lack
 * Also the rivers as lines along their middle, from the waterways of either answer.
 */
export function buildWater(spec, frame, { osm = [], ohm = [], waterAt = null }) {
  const { proj, box } = frame;
  const cell = spec.cell ?? 8;
  const tol = spec.detail ?? cell * 0.75;
  const grid = makeGrid(box, cell);
  const isWater = (t) => (t.natural === 'water' || t.waterway === 'riverbank' || t.natural === 'bay') && !/^(pond|fountain|swimming_pool|wastewater|reflecting_pool|moat|reservoir|basin)$/.test(t.water ?? '');
  const skip = new Set(spec.skip ?? []);
  const standing = ohm.filter((e) => alive(e.tags ?? {}, spec.year ?? null));
  let sea = false;
  if (waterAt) {
    // The mask is coarser than the grid: it is read a sample every 24 m or so, and spread between.
    const step = Math.max(1, Math.round(24 / cell));
    const coarse = makeGrid(box, cell * step);
    for (let j = 0; j < coarse.h; j++) for (let i = 0; i < coarse.w; i++) coarse.data[j * coarse.w + i] = waterAt(proj.inverse([coarse.x0 + (i + 0.5) * coarse.cell, coarse.y0 + (j + 0.5) * coarse.cell]));
    const soft = blur(coarse, spec.maskSmooth ?? 0.8);
    const at = (i, j) => soft.data[Math.min(coarse.h - 1, Math.max(0, j)) * coarse.w + Math.min(coarse.w - 1, Math.max(0, i))];
    for (let j = 0; j < grid.h; j++) {
      for (let i = 0; i < grid.w; i++) {
        // Between the four coarse samples round the cell.
        const fi = (i + 0.5) / step - 0.5;
        const fj = (j + 0.5) / step - 0.5;
        const [i0, j0] = [Math.floor(fi), Math.floor(fj)];
        const [u, v] = [fi - i0, fj - j0];
        const value = (at(i0, j0) * (1 - u) + at(i0 + 1, j0) * u) * (1 - v) + (at(i0, j0 + 1) * (1 - u) + at(i0 + 1, j0 + 1) * u) * v;
        if (value >= 0.5) grid.data[j * grid.w + i] = 1;
      }
    }
    sea = true;
  }
  // The sea of OpenStreetMap: the frame less the land that the coastlines close with the frame's edge.
  const coast = [];
  for (const chain of joinLines(waysOf(osm, (t) => t.natural === 'coastline').map((w) => w.line), { directed: true })) {
    const pts = dedupe(chain.line.map(proj.forward), 1e-6, chain.closed);
    if (chain.closed) coast.push({ ring: pts });
    else for (const piece of clipLine(pts, box)) coast.push({ chain: piece });
  }
  if (coast.length > 0) {
    sea = true;
    const land = makeGrid(box, cell);
    for (const ring of closeChains(coast.filter((c) => c.chain).map((c) => c.chain), box)) fillPolygon(land, [ring], 1);
    // An island: a closed coastline with the land on its left runs counter-clockwise.
    for (const c of coast) if (c.ring && signedArea(c.ring) > 0) fillPolygon(land, [c.ring], 1);
    for (let k = 0; k < grid.data.length; k++) grid.data[k] = land.data[k] ? 0 : 1;
  }
  for (const a of [...areasOf(osm, isWater), ...areasOf(standing, isWater)]) {
    if (skip.has(a.id)) continue;
    fillPolygon(grid, [...a.outer, ...a.inner].map((r) => r.map(proj.forward)), 1);
  }
  // An islet mapped as a place of its own stays land, whatever the water round it was drawn as.
  for (const a of areasOf(standing, (t) => t.place === 'islet' || t.place === 'island')) fillPolygon(grid, a.outer.map((r) => r.map(proj.forward)), 0);
  // Specks are dropped: water smaller than `minArea`, and islands smaller than `minIsland`.
  const minArea = spec.minArea ?? 20000;
  const minIsland = spec.minIsland ?? 4000;
  const soft = blur(grid, 0.6);
  const traced = contours(soft, 0.5);
  const water = [];
  const islands = [];
  for (const ring of traced.rings) {
    const ccw = signedArea(ring) > 0;
    if (area(ring) < (ccw ? minArea : minIsland)) continue;
    const cut = soften(ring, tol, 1, true);
    if (!cut) continue;
    const r = roundPoints(cut, 1, true);
    if (r.length < 3 || crosses(r)) continue;
    (ccw ? water : islands).push(orient(r, true));
  }
  const bySize = (a, b) => area(b) - area(a) || a[0][0] - b[0][0];
  water.sort(bySize);
  islands.sort(bySize);
  // The rivers as lines: the ways of each wanted river, joined. A river is a name, or { id, name, match }.
  const rivers = riverLines(spec.rivers, [...osm, ...standing], frame, { tol: tol * 2, digits: 1, minLength: spec.minLength ?? 500 });
  return {
    water: water.map((ring, k) => ({ id: `water-${k}`, areaHa: ha(ring), ring })),
    islands: islands.map((ring, k) => ({ id: `island-${k}`, areaHa: ha(ring), ring })),
    rivers,
    sea,
  };
}

/** The ground's height on a grid of a frame: a sample every `cell` metres, read from the tiles through `heightAt([lon, lat])`. */
export function heightGrid(frame, box, cell, heightAt) {
  const g = makeGrid(box, cell);
  for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) g.data[j * g.w + i] = heightAt(frame.proj.inverse([g.x0 + (i + 0.5) * cell, g.y0 + (j + 0.5) * cell]));
  return g;
}

/**
 * The grid of heights a spec asks for with `grid`: `true` for one at the cell of the ground it is read from and
 * smoothed as its lines are; `{ cell, smooth }` for a cell and a smoothing of its own, in metres (each may be left
 * out). Null when it asks for none; otherwise `{ cell, smooth }`, `smooth` null for the smoothing of the lines.
 */
export function gridCell(spec, cell, what) {
  if (spec.grid === undefined || spec.grid === false) return null;
  if (spec.grid === true) return { cell, smooth: null };
  const g = spec.grid;
  const fine = (v) => v === undefined || (Number.isFinite(v) && v >= 0);
  if (g === null || typeof g !== 'object' || Object.keys(g).some((k) => k !== 'cell' && k !== 'smooth') || !fine(g.cell) || g.cell === 0 || !fine(g.smooth)) {
    throw new Error(`${what}: "grid" is true, or { cell, smooth } with the metres between its points and the metres it is smoothed over`);
  }
  return { cell: g.cell ?? cell, smooth: g.smooth ?? null };
}

/**
 * The ground as a grid of heights, for a scene that lights it (relief shading): a point every `cell` metres over
 * the box, from its north-west corner, each the height of `ground` there (read between its samples along straight
 * lines), to a tenth of a metre. `values` holds `cols` by `rows` heights row by row from the north, each row from
 * the west, as an image holds its pixels; `box` runs from the first point to the last, so the points lie on its edges.
 */
export function heightLayer(ground, box, cell) {
  const cols = Math.max(2, Math.floor((box[2] - box[0]) / cell + 1e-9) + 1);
  const rows = Math.max(2, Math.floor((box[3] - box[1]) / cell + 1e-9) + 1);
  const at = (x, y) => {
    const fx = Math.min(ground.w - 1, Math.max(0, (x - ground.x0) / ground.cell - 0.5));
    const fy = Math.min(ground.h - 1, Math.max(0, (y - ground.y0) / ground.cell - 0.5));
    const [i, j] = [Math.min(ground.w - 2, Math.floor(fx)), Math.min(ground.h - 2, Math.floor(fy))];
    const [u, v] = [fx - i, fy - j];
    const d = ground.data;
    const k = j * ground.w + i;
    return (d[k] * (1 - u) + d[k + 1] * u) * (1 - v) + (d[k + ground.w] * (1 - u) + d[k + ground.w + 1] * u) * v;
  };
  const values = new Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) values[r * cols + c] = round1(at(box[0] + c * cell, box[3] - r * cell));
  return { box: [round1(box[0]), round1(box[3] - (rows - 1) * cell), round1(box[0] + (cols - 1) * cell), round1(box[3])], cell, cols, rows, values };
}

/** The distance from a point to a line of points (one point: to that point). */
function distanceToLine(p, line) {
  let best = Infinity;
  for (let i = 0; i < Math.max(1, line.length - 1); i++) {
    const a = line[i];
    const b = line[Math.min(line.length - 1, i + 1)];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return best;
}

/**
 * The hills round the summits given: each summit takes the ground that falls away from it, down to
 * its `floor` and out to its `reach`, and two neighbours part along the hollow between them (a
 * watershed grown from the summits, the highest ground first). A hill is given by its summit (`at`:
 * the highest sample within `snap` metres of it is taken) or, where it is a ridge with no one top, by
 * its `spine`, a line along its crest: the hill grows from every sample of the line. With `allowed`
 * (a sample each, 0 or 1) no hill grows onto a sample that is 0. Returns a label for every sample
 * (0: no hill) and the highest sample each hill grew from.
 */
export function growHills(g, hills, allowed = null) {
  const { w, h, cell } = g;
  const labels = new Int32Array(w * h);
  // A heap of samples, the highest first; equal heights in the order they came, so the result is fixed.
  const heap = [];
  let serial = 0;
  const above = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[2] < b[2]);
  const push = (item) => {
    heap.push(item);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (!above(heap[k], heap[p])) break;
      [heap[k], heap[p]] = [heap[p], heap[k]];
      k = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const [l, r] = [2 * k + 1, 2 * k + 2];
        let m = k;
        if (l < heap.length && above(heap[l], heap[m])) m = l;
        if (r < heap.length && above(heap[r], heap[m])) m = r;
        if (m === k) break;
        [heap[k], heap[m]] = [heap[m], heap[k]];
        k = m;
      }
    }
    return top;
  };
  const centre = (k) => [g.x0 + ((k % w) + 0.5) * cell, g.y0 + (Math.floor(k / w) + 0.5) * cell];
  const lines = hills.map((hill) => hill.spine ?? [hill.at]);
  const seeds = hills.map((hill, n) => {
    const line = lines[n];
    // A summit is the highest sample within `snap` metres of the place given; a spine is taken as it is drawn.
    const snap = hill.spine ? cell * 0.75 : hill.snap ?? 150;
    const xs = line.map((p) => p[0]);
    const ys = line.map((p) => p[1]);
    const own = [];
    for (let j = Math.max(0, Math.floor((Math.min(...ys) - snap - g.y0) / cell)); j <= Math.min(h - 1, Math.floor((Math.max(...ys) + snap - g.y0) / cell)); j++) {
      for (let i = Math.max(0, Math.floor((Math.min(...xs) - snap - g.x0) / cell)); i <= Math.min(w - 1, Math.floor((Math.max(...xs) + snap - g.x0) / cell)); i++) {
        const k = j * w + i;
        if (allowed && !allowed[k]) continue;
        if (labels[k] || distanceToLine(centre(k), line) > snap) continue;
        own.push(k);
      }
    }
    if (own.length === 0) throw new Error(`hills: ${hill.id} lies outside the relief's box${allowed ? ' or outside the limit of the hills' : ''}`);
    let best = own[0];
    for (const k of own) if (g.data[k] > g.data[best]) best = k;
    for (const k of hill.spine ? own : [best]) {
      labels[k] = n + 1;
      push([g.data[k], k, serial++]);
    }
    return best;
  });
  while (heap.length > 0) {
    const [, k] = pop();
    const label = labels[k];
    const hill = hills[label - 1];
    const i = k % w;
    const j = (k - i) / w;
    for (const m of [i > 0 ? k - 1 : -1, i < w - 1 ? k + 1 : -1, j > 0 ? k - w : -1, j < h - 1 ? k + w : -1]) {
      if (m < 0 || labels[m] || g.data[m] < hill.floor || (allowed && !allowed[m])) continue;
      if (distanceToLine(centre(m), lines[label - 1]) > hill.reach) continue;
      labels[m] = label;
      push([g.data[m], m, serial++]);
    }
  }
  return { labels, seeds };
}

/**
 * The relief of a city, from an elevation model: contour lines at the heights chosen, and the named
 * hills as soft forms of their own, each a stack of rings from its foot up (its `levels`: the share
 * of the hill's ground that each ring leaves below it). Where the hills are spurs of higher
 * ground and have no foot on that side, `limit` ({ ring, margin }) ends them: no hill reaches more
 * than `margin` metres outside the ring (the wall that ran across the high ground, for one).
 */
export function buildRelief(spec, frame, heightAt, limit = null) {
  const cell = spec.cell ?? 30;
  const box = frame.reliefBox;
  const raw = heightGrid(frame, box, cell, heightAt);
  const ground = blur(raw, (spec.smooth ?? 90) / cell);
  // A grid of heights may be smoothed less (or more) than the lines are traced on.
  const gridOf = (g) => heightLayer(g.smooth === null ? ground : blur(raw, g.smooth / cell), box, g.cell);
  const tol = spec.detail ?? cell * 0.5;
  const out = { contours: [], hills: [] };
  const gridStep = gridCell(spec, cell, 'relief');
  let levels = spec.contours ?? [];
  if (!Array.isArray(levels)) {
    // { step, from?, to?, max? }: a line every `step` metres between the lowest and the highest ground of the box.
    const step = levels.step;
    if (!(step > 0)) throw new Error('relief: "contours" is a list of heights or { step }');
    let [lo, hi] = [Infinity, -Infinity];
    for (const v of ground.data) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const from = levels.from ?? Math.max(step, Math.ceil((lo + 1e-6) / step) * step);
    const list = [];
    for (let height = from; height < (levels.to ?? hi) && list.length < (levels.max ?? 12); height += step) list.push(height);
    levels = list;
  }
  for (const level of levels) {
    const traced = contours(ground, level, { closed: false });
    const minLength = spec.minLength ?? 1200;
    const rings = [];
    const lines = [];
    for (const ring of traced.rings) {
      if (lengthOf(ring, true) < minLength) continue;
      const cut = soften(ring, tol, 2, true);
      if (cut && cut.length >= 3) rings.push(roundPoints(cut, 1, true));
    }
    for (const line of traced.lines) {
      if (lengthOf(line) < minLength) continue;
      const cut = soften(line, tol, 2, false);
      if (cut && cut.length >= 2) lines.push(roundPoints(cut, 1));
    }
    rings.sort((a, b) => area(b) - area(a) || a[0][0] - b[0][0]);
    lines.sort((a, b) => lengthOf(b) - lengthOf(a) || a[0][0] - b[0][0]);
    out.contours.push({ id: `contour-${level}`, height: level, rings, lines });
  }
  const hills = (spec.hills ?? []).map((hill) => {
    if (!hill.summit && !hill.spine) throw new Error(`hills: ${hill.id} has neither a summit nor a spine`);
    return { ...hill, ...(hill.spine ? { spine: hill.spine.map(frame.proj.forward) } : { at: frame.proj.forward(hill.summit) }), floor: hill.floor ?? spec.floor ?? 0, reach: hill.reach ?? spec.reach ?? 1500 };
  });
  if (hills.length > 0) {
    let allowed = null;
    if (limit) {
      const inside = like(ground);
      fillPolygon(inside, [limit.ring], 1);
      allowed = grow(inside, (limit.margin ?? 0) / cell).data;
    }
    const { labels, seeds } = growHills(ground, hills, allowed);
    const levels = spec.levels ?? [0, 0.5];
    hills.forEach((hill, n) => {
      const own = like(ground);
      const heights = [];
      for (let k = 0; k < own.data.length; k++) {
        if (labels[k] !== n + 1) continue;
        own.data[k] = 1;
        heights.push(ground.data[k]);
      }
      heights.sort((x, y) => x - y);
      const rings = [];
      for (const share of levels) {
        // The ring that leaves this share of the hill's ground below it: the foot at 0, the higher half at 0.5.
        // A share of the ground, not of the height, so that one tall roof does not shrink the upper ring to a dot.
        const height = share <= 0 ? hill.floor : heights[Math.min(heights.length - 1, Math.floor(share * heights.length))];
        const high = mask(like(ground, ground.data.map((v, k) => (own.data[k] ? v : -1e6))), (v) => v >= height);
        let part = component(high, seeds[n]);
        if (share > 0) {
          // The largest piece of the higher ground, which need not hold the highest sample.
          const pieces = components(high);
          const big = pieces.sizes.indexOf(Math.max(...pieces.sizes.slice(1)), 1);
          part = like(high, Float32Array.from(pieces.labels, (l) => (l === big ? 1 : 0)));
        }
        const ring = contours(blur(part, spec.round ?? 1.2), spec.gap ?? 0.56).rings.filter((r) => signedArea(r) > 0).sort((x, y) => area(y) - area(x))[0];
        if (!ring) continue;
        const cut = soften(ring, tol, 2, true);
        if (cut && cut.length >= 3) rings.push({ height: round1(height), ring: roundPoints(cut, 1, true) });
      }
      const summit = [ground.x0 + ((seeds[n] % ground.w) + 0.5) * cell, ground.y0 + (Math.floor(seeds[n] / ground.w) + 0.5) * cell];
      // The height is that of the hill's high ground (19 samples in 20 lie below it), not of its one highest sample:
      // the model is of the surface, and a tall roof is not the hill.
      const height = heights[Math.floor(0.95 * (heights.length - 1))];
      if (rings.length > 0) out.hills.push({ id: hill.id, name: hill.name, summit: summit.map(round1), centre: centroid(rings[0].ring).map(round1), height: round1(height), areaHa: ha(rings[0].ring), rings });
    });
  }
  if (gridStep) out.grid = gridOf(gridStep);
  return out;
}

/**
 * The mean of `at([lon, lat])` over each cell of a grid of a frame, from `n` by `n` places spread
 * evenly over the cell (one, at its middle, by default). Fills the grid and returns it.
 */
export function meanGrid(proj, g, at, n = 1) {
  for (let j = 0; j < g.h; j++) {
    for (let i = 0; i < g.w; i++) {
      let sum = 0;
      for (let b = 0; b < n; b++) for (let a = 0; a < n; a++) sum += at(proj.inverse([g.x0 + (i + (a + 0.5) / n) * g.cell, g.y0 + (j + (b + 0.5) / n) * g.cell]));
      g.data[j * g.w + i] = sum / (n * n);
    }
  }
  return g;
}

/** The cell of a terrain whose spec names none, by the scale: about 800 cells from the south of its box to the north, in whole tens of metres, 30 m at the least. */
export const terrainCell = (box) => Math.max(30, Math.round((box[3] - box[1]) / 8000) * 10);

/** The heights a terrain is banded at when its spec names none: those of this list that its ground reaches. */
export const TERRAIN_LEVELS = [25, 50, 100, 200, 400, 800, 1600, 3200, 6400];

/**
 * How the terrain of a box is laid out: the `cell` of its grid of heights, the metres its ground is
 * `smooth`ed over, the finer `waterCell` its coast is traced on, and its `reach`: the box grown by
 * what the smoothing reads past its edge, which is what the tiles have to cover.
 */
export function terrainPlan(spec, box) {
  const cell = spec.cell ?? terrainCell(box);
  const smooth = spec.smooth ?? cell * 2;
  const pad = (Math.ceil((3 * smooth) / cell) + 2) * cell;
  return { cell, smooth, waterCell: spec.coast?.cell ?? Math.max(30, cell / 2), reach: [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad] };
}

/**
 * The terrain of a wide view, for a map with depth: the land that stands out of the sea, its lakes,
 * its rivers, and the ground as bands of height, each a ring to paint over those before it.
 *   heightAt       ([lon, lat]) => metres, from an elevation model; `heightSamples` a side make the mean of a cell
 *   seaAt          ([lon, lat]) => 0..1, the share of sea, from a water mask; or
 *   seaRings       the sea as polygons in lon/lat, each a list of rings (an island is a hole)
 *   lakeAt         ([lon, lat]) => 0..1, the share of lake; `waterSamples` a side make the mean of a cell
 *   osm, ohm       an answer of OpenStreetMap or OpenHistoricalMap with the rivers wanted
 * The heights are the mean of each cell, smoothed over `smooth` metres, so a band is a soft form
 * and never a speck; the water is traced on a finer grid. Returns
 *   land[]    { id, areaHa, ring }: the land, an island a ring of its own; the sea is what it leaves
 *   bands[]   { id, band, height, pit?, areaHa, ring } in the order to paint them, the largest first:
 *             a ring at `height` holds the ground at least that high, band k + 1 where it is level k; a
 *             `pit` holds a hollow below `height` in higher ground, band k. Band 0 is the land itself
 *   lakes[]   { id, areaHa, ring }: standing water apart from the sea, painted over the bands
 *   rivers[]  { id, name, lengthKm, lines }, cut where they meet the sea
 * and `lost`, the rings that could not be drawn without crossing themselves (none, as a rule).
 * No band comes nearer the sea than about a cell: a cliff keeps a rim of the land below it, so the
 * bands always lie on the land.
 */
export function buildTerrain(spec, frame, { heightAt, heightSamples = 1, seaAt = null, seaRings = null, lakeAt = null, waterSamples = 1, osm = [], ohm = [] }) {
  const { proj, box } = frame;
  const { cell, smooth, waterCell, reach } = terrainPlan(spec, box);
  const tol = spec.detail ?? cell * 0.4;
  const coastTol = spec.coast?.detail ?? waterCell * 0.75;
  const minArea = spec.minArea ?? (cell * 8) ** 2;
  const minIsland = spec.coast?.minIsland ?? (cell * 4) ** 2;
  const minLake = spec.lakes?.minArea ?? minArea;
  const lost = [];
  // A traced ring as rings of the layer: softened, cut to the box, rounded to whole metres, none crossing itself.
  const tidy = (ring, t, times, least, what) => {
    if (area(ring) < least) return [];
    const soft = soften(ring, t, times, true);
    if (!soft) lost.push(`${what} of ${ha(ring)} ha`);
    const out = [];
    for (const piece of soft ? clipRing(soft, box) : []) {
      if (area(piece) < least) continue;
      let r = roundPoints(piece, 0, true);
      if (r.length >= 3 && crosses(r)) r = simplifySafe(r, 1.5, true) ?? [];
      if (r.length >= 3 && !crosses(r)) out.push(orient(r, true));
      else lost.push(`${what} of ${ha(piece)} ha`);
    }
    return out;
  };
  const bySize = (a, b) => area(b) - area(a) || a[0][0] - b[0][0] || a[0][1] - b[0][1];

  // The sea, on the finer grid.
  const sea = makeGrid(reach, waterCell);
  if (seaRings) for (const rings of seaRings) fillPolygon(sea, rings.map((r) => r.map(proj.forward)), 1);
  else if (seaAt) {
    meanGrid(proj, sea, seaAt, waterSamples);
    for (let k = 0; k < sea.data.length; k++) sea.data[k] = sea.data[k] >= 0.5 ? 1 : 0;
  }
  // The lakes: the water that stands apart from the sea, less those the spec leaves out and the specks.
  let lake = makeGrid(reach, waterCell);
  if (lakeAt) {
    meanGrid(proj, lake, lakeAt, waterSamples);
    for (let k = 0; k < lake.data.length; k++) lake.data[k] = lake.data[k] >= 0.5 && !sea.data[k] ? 1 : 0;
    for (const at of spec.lakes?.skip ?? []) {
      // A lake left out (a reservoir of today on a map of the past) is named by a place on it.
      const gone = component(lake, cellAt(lake, proj.forward(at)));
      if (!gone.data.some((v) => v > 0)) throw new Error(`terrain: "lakes.skip" names ${JSON.stringify(at)}, where the water mask has no lake`);
      for (let k = 0; k < lake.data.length; k++) if (gone.data[k]) lake.data[k] = 0;
    }
    const { labels, sizes } = components(lake);
    for (let k = 0; k < lake.data.length; k++) if (labels[k] && sizes[labels[k]] * waterCell ** 2 < minLake) lake.data[k] = 0;
    // An island in a lake is not drawn: the lake is one form.
    lake = fillHoles(lake);
  }
  const land = [];
  const lakes = [];
  for (const ring of contours(blur(like(sea, Float32Array.from(sea.data, (v) => 1 - v)), 0.8), 0.5).rings) {
    // Counter-clockwise round land; clockwise round water that the land closes in (a lagoon the smoothing has shut).
    if (signedArea(ring) > 0) land.push(...tidy(ring, coastTol, 1, minIsland, 'land'));
    else lakes.push(...tidy(ring, coastTol, 1, minLake, 'water in the land'));
  }
  for (const ring of contours(blur(lake, 0.8), 0.5).rings) if (signedArea(ring) > 0) lakes.push(...tidy(ring, coastTol, 1, minLake, 'a lake'));
  land.sort(bySize);
  lakes.sort(bySize);

  // The ground: the mean height of each cell, smoothed.
  const mean = meanGrid(proj, makeGrid(reach, cell), heightAt, heightSamples);
  const ground = blur(mean, smooth / cell);
  const gridStep = gridCell(spec, cell, 'terrain');
  // A grid of heights smoothed apart from the bands is held at the shore as they are.
  const own = gridStep && gridStep.smooth !== null ? blur(mean, gridStep.smooth / cell) : null;
  let levels = spec.levels ?? null;
  if (!levels) {
    let top = -Infinity;
    for (const v of ground.data) if (v > top) top = v;
    levels = TERRAIN_LEVELS.filter((level) => level < top);
  }
  if (!Array.isArray(levels) || levels.some((level, k) => !Number.isFinite(level) || (k > 0 && level <= levels[k - 1]))) throw new Error('terrain: "levels" is a list of heights, each above the one before');
  if (levels.length > 0) {
    // The cells the sea touches, and those within two cells of them, are held under the first level.
    const wet = like(ground);
    for (let j = 0; j < sea.h; j++) {
      for (let i = 0; i < sea.w; i++) {
        if (!sea.data[j * sea.w + i]) continue;
        const k = cellAt(wet, [sea.x0 + (i + 0.5) * sea.cell, sea.y0 + (j + 0.5) * sea.cell]);
        if (k >= 0) wet.data[k] = 1;
      }
    }
    const shore = grow(wet, 2.5);
    for (let k = 0; k < ground.data.length; k++) if (shore.data[k] && ground.data[k] > levels[0] - 1) ground.data[k] = levels[0] - 1;
    if (own) for (let k = 0; k < own.data.length; k++) if (shore.data[k] && own.data[k] > levels[0] - 1) own.data[k] = levels[0] - 1;
  }
  const grid = gridStep ? heightLayer(own ?? ground, box, gridStep.cell) : null;
  const bands = [];
  levels.forEach((height, k) => {
    for (const ring of contours(ground, height).rings) {
      const pit = signedArea(ring) < 0;
      for (const r of tidy(ring, tol, 2, minArea, `${pit ? 'a pit' : 'a band'} at ${height} m`)) bands.push({ band: pit ? k : k + 1, height, pit, ring: r });
    }
  });
  // The order to paint them in: a ring before those inside it, so the largest first.
  bands.sort((a, b) => area(b.ring) - area(a.ring) || a.band - b.band || a.ring[0][0] - b.ring[0][0] || a.ring[0][1] - b.ring[0][1]);
  const count = new Map();
  const named = bands.map(({ band, height, pit, ring }) => {
    const stem = `${pit ? 'pit' : 'band'}-${height}`;
    count.set(stem, (count.get(stem) ?? -1) + 1);
    return { id: `${stem}-${count.get(stem)}`, band, height, ...(pit ? { pit: true } : {}), areaHa: ha(ring), ring };
  });

  // The rivers, each cut where it meets the sea: a stretch on land runs on to the water's edge.
  const inSea = (p) => {
    const k = cellAt(sea, proj.forward(p));
    return k >= 0 && sea.data[k] > 0;
  };
  // The first place in the water on the way from a point on land to a point in the sea, found by halving.
  const edge = (dry, wet) => {
    let [a, b] = [dry, wet];
    for (let k = 0; k < 16; k++) {
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (inSea(mid)) b = mid;
      else a = mid;
    }
    return b;
  };
  const part = (line) => {
    const out = [];
    let run = [];
    let before = null;
    for (const p of line) {
      if (inSea(p)) {
        if (run.length > 0) out.push([...run, edge(run[run.length - 1], p)]);
        run = [];
        before = p;
      } else {
        if (run.length === 0 && before) run.push(edge(p, before));
        run.push(p);
      }
    }
    if (run.length > 1) out.push(run);
    return out;
  };
  const rivers = riverLines(spec.rivers?.list, [...osm, ...ohm.filter((e) => alive(e.tags ?? {}, spec.year ?? null))], frame, { tol, digits: 0, minLength: spec.rivers?.minLength ?? cell * 20, part });

  return {
    box,
    cell,
    levels,
    land: land.map((ring, k) => ({ id: `land-${k}`, areaHa: ha(ring), ring })),
    bands: named,
    lakes: lakes.map((ring, k) => ({ id: `lake-${k}`, areaHa: ha(ring), ring })),
    rivers,
    ...(grid ? { grid } : {}),
    lost,
  };
}

/** The distance from a point to a ring's outline. */

function distanceToRing(p, ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return best;
}

/**
 * A wall as one closed circuit. Its ways (from OpenHistoricalMap or OpenStreetMap) are joined end to
 * end; stretches given by hand as [lon, lat] points (`draw`) join them as more ways; what still
 * stands apart by less than `bridge` metres (a gate between two ways) is closed with a straight
 * line. `check` measures how far the stretches another source maps lie from the circuit.
 */
export function buildWall(spec, frame, ways, checkWays = []) {
  const { proj } = frame;
  const bridge = spec.bridge ?? 40;
  let chains = joinLines([...ways.map((w) => w.line), ...(spec.draw ?? []).map((d) => d.points)], { eps: 1e-7 }).map((c) => ({ pts: c.line.map(proj.forward), closed: c.closed }));
  const notes = [];
  // Bridge the nearest ends, the closest pair first, while they are within `bridge`.
  for (;;) {
    const open = chains.filter((c) => !c.closed);
    if (open.length === 0) break;
    let best = null;
    for (let a = 0; a < open.length; a++) {
      for (let b = a; b < open.length; b++) {
        for (const [ea, eb] of a === b ? [[1, 0]] : [[1, 0], [1, 1], [0, 0], [0, 1]]) {
          const pa = ea ? open[a].pts[open[a].pts.length - 1] : open[a].pts[0];
          const pb = eb ? open[b].pts[open[b].pts.length - 1] : open[b].pts[0];
          const d = dist(pa, pb);
          if (!best || d < best.d) best = { d, a, b, ea, eb };
        }
      }
    }
    if (!best || best.d > bridge) break;
    const A = open[best.a];
    if (best.a === best.b) {
      A.closed = true;
      if (best.d > 0.5) notes.push(`closed across ${Math.round(best.d)} m`);
      continue;
    }
    const B = open[best.b];
    const first = best.ea ? A.pts : [...A.pts].reverse();
    const second = best.eb ? [...B.pts].reverse() : B.pts;
    if (best.d > 0.5) notes.push(`joined across ${Math.round(best.d)} m`);
    chains = chains.filter((c) => c !== A && c !== B);
    chains.push({ pts: [...first, ...second], closed: false });
  }
  const rings = chains.filter((c) => c.closed).sort((a, b) => area(b.pts) - area(a.pts));
  if (rings.length === 0) {
    const gaps = chains.map((c) => `${Math.round(dist(c.pts[0], c.pts[c.pts.length - 1]))} m`);
    throw new Error(`wall ${spec.id}: the ways do not close into a circuit (${chains.length} chain(s), ends ${gaps.join(', ')} apart): add the missing stretches under "draw" or raise "bridge"`);
  }
  const whole = dedupe(rings[0].pts, 0.05, true);
  const cut = simplifySafe(whole, spec.detail ?? 2, true);
  if (!cut) throw new Error(`wall ${spec.id}: the circuit crosses itself`);
  const ring = orient(roundPoints(cut, 1, true), true);
  const out = { id: spec.id, name: spec.name, ...(spec.built === undefined ? {} : { built: spec.built }), lengthKm: km(lengthOf(ring, true)), areaHa: ha(ring), ring };
  let check = null;
  if (checkWays.length > 0) {
    const d = [];
    for (const w of checkWays) for (const p of w.line) d.push(distanceToRing(proj.forward(p), ring));
    d.sort((a, b) => a - b);
    check = { ways: checkWays.length, points: d.length, median: Math.round(d[Math.floor(d.length / 2)]), p90: Math.round(d[Math.floor(d.length * 0.9)]), max: Math.round(d[d.length - 1]) };
  }
  return { wall: out, notes, check };
}

/** The classes of Natural Earth's roads: its `type`, written as a class ("Major Highway" is `major-highway`). */
export const NATURAL_EARTH_ROADS = ['major-highway', 'secondary-highway', 'beltway', 'bypass', 'road', 'track', 'unknown', 'ferry-route', 'ferry-seasonal'];

/**
 * The classes of streets a spec asks for, in its order: OpenStreetMap's and OpenHistoricalMap's `highway` values
 * (motorway, trunk and primary by default), or Natural Earth's road classes (major and secondary highways by
 * default), of which a class it does not have is refused.
 */
export function streetClasses(spec) {
  if (spec.from !== 'natural-earth') return spec.classes ?? ['motorway', 'trunk', 'primary'];
  const classes = spec.classes ?? ['major-highway', 'secondary-highway'];
  const bad = classes.find((c) => !NATURAL_EARTH_ROADS.includes(c));
  if (bad !== undefined) throw new Error(`streets: Natural Earth has no road class "${bad}" (its classes: ${NATURAL_EARTH_ROADS.join(', ')})`);
  return classes;
}

/**
 * The roads of Natural Earth's file of roads that reach a lon/lat box, as the ways of an Overpass answer, for
 * buildStreets: `highway` is the road's class, `ref` its route numbers as Natural Earth writes them (its `routeraw`,
 * else its `label`, else its `name`, which there is a number).
 */
export function roadsOf(path, lonlat) {
  const out = [];
  for (const f of featuresOf(path)) {
    const p = f.properties ?? {};
    const route = typeof p.routeraw === 'string' && !p.routeraw.startsWith('_') ? p.routeraw : '';
    const ref = String(route || (p.label ?? '') || (p.name ?? ''));
    for (const line of linesOfGeometry(f.geometry)) {
      if (line.length < 2 || !boxesMeet(lonLatBox(line), lonlat)) continue;
      out.push({ type: 'way', id: out.length + 1, tags: { highway: slug(String(p.type ?? 'unknown')), ...(ref ? { ref } : {}) }, geometry: line.map(([lon, lat]) => ({ lon, lat })) });
    }
  }
  return out;
}

/**
 * The main streets of a city: the ways of the classes wanted, joined where they share a class, a name
 * and a number, cut to the frame. From OpenStreetMap they are the streets of today. From
 * OpenHistoricalMap (`spec.from: "ohm"`) each street also carries the years it stood (`from`, `to`; a
 * missing one is not known, or not yet), so a scene can show the roads of an epoch; `spec.year` keeps
 * only those of one year. From Natural Earth (`spec.from: "natural-earth"`, the ways of `roadsOf`) they
 * are a country's main roads at 1:10m, a point every few kilometres.
 */
export function buildStreets(spec, frame, elements) {
  const { proj, box } = frame;
  const classes = streetClasses(spec);
  const tol = spec.detail ?? 8;
  const dated = spec.from === 'ohm';
  const groups = new Map();
  for (const w of waysOf(elements, (t) => classes.includes(t.highway) && (!dated || spec.year === undefined || alive(t, spec.year)))) {
    const [from, to] = dated ? [yearOf(w.tags.start_date), yearOf(w.tags.end_date)] : [null, null];
    const key = `${w.tags.highway}|${w.tags.ref ?? ''}|${w.tags.name ?? ''}|${from ?? ''}|${to ?? ''}`;
    if (!groups.has(key)) groups.set(key, { cls: w.tags.highway, ref: w.tags.ref ?? '', name: w.tags.name ?? '', from, to, lines: [] });
    groups.get(key).lines.push(w.line);
  }
  const out = [];
  for (const [key, g] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const lines = [];
    for (const chain of joinLines(g.lines)) lines.push(...linesInFrame(chain.closed ? [...chain.line, chain.line[0]] : chain.line, proj, box, tol, 1, 0, 1));
    const length = lines.reduce((sum, l) => sum + lengthOf(l), 0);
    if (lines.length === 0 || length < (spec.minLength ?? 400)) continue;
    lines.sort((a, b) => lengthOf(b) - lengthOf(a) || a[0][0] - b[0][0]);
    out.push({ class: g.cls, ...(g.name ? { name: g.name } : {}), ...(g.ref ? { ref: g.ref } : {}), ...(g.from === null ? {} : { from: g.from }), ...(g.to === null ? {} : { to: g.to }), lengthKm: km(length), lines, key });
  }
  // The classes in the order asked, the earliest first within a class, then the longest.
  out.sort((a, b) => classes.indexOf(a.class) - classes.indexOf(b.class) || (a.from ?? 99999) - (b.from ?? 99999) || b.lengthKm - a.lengthKm || (a.key < b.key ? -1 : 1));
  return out.map(({ key, ...street }, k) => ({ id: `street-${k}`, ...street }));
}

/**
 * The built-up land of a year as one outline: the city as one body. What is built comes either as
 * `areas` (the land-use blocks of OpenStreetMap, or the urban areas of Natural Earth; each a list of
 * rings in lon/lat), filled into a grid, or as `shareAt` ([lon, lat] => the share of the ground built
 * on, from the Global Human Settlement Layer), where a cell counts as built from `share` (0.2) up.
 * The gaps narrower than `2 bridge` metres (streets, squares, small parks, a river) are closed, and
 * the piece that holds the city's centre is traced: `ring`, its outer outline. What a strait or a
 * wide valley parts from it comes as `pieces`: the other bodies of at least `minPiece` of its area
 * (0.03), the largest first.
 */
export function buildBuiltUp(spec, frame, { areas = null, shareAt = null }) {
  const { proj, box } = frame;
  const cell = spec.cell ?? 40;
  let grid = makeGrid(box, cell);
  for (const rings of areas ?? []) fillPolygon(grid, rings.map((r) => r.map(proj.forward)), 1);
  if (shareAt) {
    for (let j = 0; j < grid.h; j++) {
      for (let i = 0; i < grid.w; i++) grid.data[j * grid.w + i] = shareAt(proj.inverse([grid.x0 + (i + 0.5) * cell, grid.y0 + (j + 0.5) * cell]));
    }
    grid = mask(blur(grid, spec.maskSmooth ?? 1), (v) => v >= (spec.share ?? 0.2));
  }
  const m = closeGaps(grid, (spec.bridge ?? 250) / cell);
  const seed = cellAt(m, spec.seedAt ?? [0, 0]);
  let body = component(m, seed);
  if (!body.data.some((v) => v > 0)) {
    // The centre itself is not built on (a square, a park, ruins): the largest piece is taken.
    const { labels, sizes } = components(m);
    if (sizes.length < 2) throw new Error('built-up: nothing built in the frame');
    const big = sizes.indexOf(Math.max(...sizes.slice(1)), 1);
    body = like(m, Float32Array.from(labels, (l) => (l === big ? 1 : 0)));
  }
  const outline = (part) => {
    const whole = spec.fill ?? true ? fillHoles(part) : part;
    const ring = contours(blur(whole, spec.round ?? 1.5), 0.5).rings.filter((r) => signedArea(r) > 0).sort((a, b) => area(b) - area(a))[0];
    const cut = ring ? soften(ring, spec.detail ?? cell * 1.2, 2, true) : null;
    return cut && cut.length >= 3 ? orient(roundPoints(cut, 1, true), true) : null;
  };
  const ring = outline(body);
  if (!ring) throw new Error('built-up: nothing built in the frame');
  const pieces = [];
  const { labels, sizes } = components(m);
  const main = body.data.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
  for (let label = 1; label < sizes.length; label++) {
    if (sizes[label] < main * (spec.minPiece ?? 0.03)) continue;
    const part = like(m, Float32Array.from(labels, (l) => (l === label ? 1 : 0)));
    // The main body is one of the pieces of the grid: it is the one that shares a sample with `body`.
    if (part.data.some((v, k) => v > 0 && body.data[k] > 0)) continue;
    const other = outline(part);
    if (other) pieces.push(other);
  }
  pieces.sort((a, b) => area(b) - area(a) || a[0][0] - b[0][0]);
  return { ring, pieces };
}

/** The areas of an Overpass answer as lists of rings in lon/lat, for buildBuiltUp. */
export const areasOfAnswer = (elements) => areasOf(elements).map((a) => [...a.outer, ...a.inner]);

/** The urban areas of Natural Earth that reach a lon/lat box, as lists of rings in lon/lat, for buildBuiltUp. */
export function urbanAreas(path, lonlat) {
  const out = [];
  for (const f of featuresOf(path)) {
    const polys = f.geometry?.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates : [];
    for (const poly of polys) {
      const rings = poly.map((r) => r.slice(0, -1)).filter((r) => r.length >= 3);
      if (rings.length > 0 && boxesMeet(boxOf(rings[0]), lonlat)) out.push(rings);
    }
  }
  return out;
}

/**
 * The outline of the city at each epoch, in the order of the years, with for each a ring of the
 * same number of points, turned to match the one before it: the rings a morph runs between.
 */
export function buildEpochs(specs, frame, { walls, hills, builtUp = [], points = 160 }) {
  const { proj } = frame;
  const out = [];
  for (const e of specs) {
    const o = e.outline;
    let ring;
    if (o.wall) {
      ring = walls.find((w) => w.id === o.wall)?.ring;
      if (!ring) throw new Error(`epoch ${e.id}: no wall ${o.wall}`);
    } else if (o.hill) {
      const hill = hills.find((h) => h.id === o.hill);
      ring = hill?.rings[o.level ?? 0]?.ring;
      if (!ring) throw new Error(`epoch ${e.id}: no hill ${o.hill}`);
    } else if (o.builtUp) {
      // `true` is the latest built-up outline; a number, that of the year.
      ring = (o.builtUp === true ? builtUp[builtUp.length - 1] : builtUp.find((b) => b.year === o.builtUp))?.ring;
      if (!ring) throw new Error(`epoch ${e.id}: no built-up outline${o.builtUp === true ? ' (the spec has no "builtUp")' : ` of ${o.builtUp} (name the year under "builtUp.years")`}`);
    } else if (o.points) {
      const drawn = dedupe(o.points.map(proj.forward), 0.5, true);
      // An outline drawn by hand through a few places has no detail to keep: its corners are rounded all the way.
      const cut = soften(drawn, o.detail ?? 4, o.smooth ?? 2, true, Infinity);
      if (!cut || crosses(cut)) throw new Error(`epoch ${e.id}: the outline drawn crosses itself`);
      ring = roundPoints(cut, 1, true);
    } else throw new Error(`epoch ${e.id}: its outline names no wall, hill, points or builtUp`);
    out.push({ id: e.id, year: e.year, name: e.name, areaHa: ha(ring), ring: orient(ring, true) });
  }
  out.sort((a, b) => a.year - b.year);
  // An outline with far more detail than the ring of a morph can hold (a city of today, with its
  // inlets and arms) is calmed first: averaged along itself over about two steps of the ring, so the
  // ring follows its body and not every inlet. An outline the ring can hold is taken as it is.
  const calm = (ring) => {
    if (ring.length <= 2 * points) return ring;
    let dense = resample(ring, 8 * points, true);
    for (let pass = 0; pass < 2; pass++) {
      const n = dense.length;
      dense = dense.map((_, k) => {
        let [x, y] = [0, 0];
        for (let d = -8; d <= 8; d++) {
          const p = dense[(k + d + n) % n];
          x += p[0];
          y += p[1];
        }
        return [x / 17, y / 17];
      });
    }
    return dense;
  };
  const morph = morphRings(out.map((e) => calm(e.ring)), points);
  // Rounded point by point: none is dropped, so every epoch keeps the same number.
  return out.map((e, k) => ({ ...e, morph: morph[k].map(([x, y]) => [round1(x), round1(y)]) }));
}

/** The landmarks: each a named place of the frame. */
export function buildLandmarks(specs, frame) {
  return specs.map((l) => ({ id: l.id, name: l.name, ...(l.built === undefined ? {} : { built: l.built }), at: frame.proj.forward(l.at).map(round1), lonlat: l.at }));
}

/**
 * A point well inside a ring, where its label belongs: its centre of area where that lies inside, else the middle of
 * the widest stretch of the ring along the line east and west through that centre.
 */
export function pointInside(ring) {
  const c = centroid(ring);
  if (pointInRing(c, ring)) return c;
  const y = c[1];
  const xs = [];
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    if (y0 > y !== y1 > y) xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
  }
  xs.sort((a, b) => a - b);
  let best = null;
  for (let k = 0; k + 1 < xs.length; k += 2) if (!best || xs[k + 1] - xs[k] > best[1] - best[0]) best = [xs[k], xs[k + 1]];
  return best ? [(best[0] + best[1]) / 2, y] : [...ring[0]];
}

/** A name in small Latin letters, digits and dashes, its accents left off (`Gréngewald` → `grengewald`). */
const plainSlug = (text) => slug(text.normalize('NFD').replace(/\p{M}+/gu, ''));

/** Ids made of names, each given once: a name met again takes the element of the source it came from. */
function idsByName() {
  const used = new Set();
  return (name, osm) => {
    const base = plainSlug(name) || osm.replace('/', '-');
    const id = used.has(base) ? `${base}-${osm.replace('/', '-')}` : base;
    used.add(id);
    return id;
  };
}

/** The member node a relation of an answer maps as the place of its label, as [lon, lat], or null. */
function labelOf(element) {
  const m = (element?.members ?? []).find((x) => x.type === 'node' && x.role === 'label' && Number.isFinite(x.lon) && Number.isFinite(x.lat));
  return m ? [m.lon, m.lat] : null;
}

/** The admin levels a spec of divisions asks for (OpenStreetMap's `admin_level`): a whole number from 1 to 12, or a list of them. */
export function divisionLevels(spec) {
  const levels = Array.isArray(spec.level) ? spec.level : [spec.level];
  if (levels.length === 0 || levels.some((l) => !Number.isInteger(l) || l < 1 || l > 12)) throw new Error('divisions: "level" is an admin_level of OpenStreetMap, a whole number from 1 to 12, or a list of them');
  return [...new Set(levels)].sort((a, b) => a - b);
}

/**
 * The administrative divisions of a country below its whole: the boundary relations of OpenStreetMap
 * (`boundary=administrative`) of the admin levels asked for that reach the box, or only those of the names asked
 * for (`spec.names`, as a division's `name` or `name:en`; a name not found is refused). The divisions of a level are
 * thinned together, so two neighbours share their border point for point, then cut to the box. Each comes as
 * { id, name, level, osm, areaKm2, at, ring, pieces }: `ring` its largest part in the box, `pieces` the others, the
 * largest first, `areaKm2` the area of what is in the box, `at` a point inside `ring` for its label (the label node
 * the source maps for it, where that lies inside); the lowest level first, and in a level the largest first, the order
 * to paint them in. A division's holes are not kept: an enclave of the same level, painted after it, covers it.
 * Beside them come the lines to draw them with as strokes, each once and never along the edge of the box:
 * { id, level, between, lines }, the border of two divisions (`between` their ids), or the outline of all the
 * divisions of a level where no other asked for lies beyond it (`between` empty: a coast, the edge of a country).
 */
export function buildDivisions(spec, frame, elements) {
  const { proj, box } = frame;
  const levels = divisionLevels(spec);
  const tol = spec.detail ?? Math.max(1, Math.round((box[3] - box[1]) / 2200));
  const minArea = spec.minArea ?? (tol * 6) ** 2;
  const wanted = spec.names ? new Set(spec.names) : null;
  const nameOf = (t) => t.name ?? t['name:en'] ?? '';
  const areas = areasOf(elements, (t, e) => e.type === 'relation' && t.boundary === 'administrative' && levels.includes(Number(t.admin_level)) && nameOf(t) !== '' && (!wanted || wanted.has(t.name) || wanted.has(t['name:en'])));
  for (const name of wanted ?? []) if (!areas.some((a) => a.tags.name === name || a.tags['name:en'] === name)) throw new Error(`divisions: no division named "${name}" of admin_level ${levels.join(' or ')} reaches the view`);
  if (areas.length === 0) throw new Error(`divisions: no division of admin_level ${levels.join(' or ')} reaches the view`);
  const byId = new Map(elements.map((e) => [`${e.type}/${e.id}`, e]));
  const number = (osm) => Number(osm.split('/')[1]);
  // A sliver the cut leaves of a division that only grazes the view is left out, as a small island is.
  const cut = (ring) => clipRing(ring, box).map((piece) => orient(roundPoints(piece, 1, true), true)).filter((r) => r.length >= 3 && area(r) >= minArea);
  const cutLine = (line) => clipLine(line, box).map((piece) => roundPoints(piece, 1)).filter((l) => l.length >= 2);
  const made = [];
  const strokes = [];
  for (const level of levels) {
    const list = areas.filter((a) => Number(a.tags.admin_level) === level).sort((a, b) => number(a.id) - number(b.id));
    const shapes = list.map((a) => ({ rings: [...a.outer.map((r) => ({ points: r.map(proj.forward) })), ...a.inner.map((r) => ({ points: r.map(proj.forward), hole: true }))] }));
    const thin = thinTogether(shapes, { tol, minArea, digits: 1 });
    const kept = new Map();
    list.forEach((a, k) => {
      const parts = thin.shapes[k].rings.flatMap(cut).sort((p, q) => area(q) - area(p) || p[0][0] - q[0][0] || p[0][1] - q[0][1]);
      if (parts.length === 0) return;
      const [ring, ...pieces] = parts;
      const label = labelOf(byId.get(a.id));
      const mark = label ? proj.forward(label) : null;
      const at = mark && pointInRing(mark, ring) ? mark : pointInside(ring);
      const d = { name: nameOf(a.tags), level, osm: a.id, areaKm2: Math.round(parts.reduce((sum, r) => sum + area(r), 0) / 1e4) / 100, at: at.map(round1), ring, pieces };
      kept.set(k, d);
      made.push(d);
    });
    for (const b of thin.borders) if (kept.has(b.a) && kept.has(b.b)) strokes.push({ level, between: [kept.get(b.a), kept.get(b.b)], lines: b.lines.flatMap(cutLine) });
    strokes.push({ level, between: [], lines: [...thin.land, ...thin.gaps].flatMap((r) => cutLine([...r, r[0]])) });
  }
  if (made.length === 0) throw new Error(`divisions: no division of admin_level ${levels.join(' or ')} reaches the view`);
  made.sort((p, q) => p.level - q.level || q.areaKm2 - p.areaKm2 || number(p.osm) - number(q.osm));
  const idOf = idsByName();
  const divisions = made.map((d) => ({ id: (d.id = idOf(d.name, d.osm)), ...d }));
  const borders = strokes
    .filter((s) => s.lines.length > 0)
    .map((s) => {
      const between = s.between.map((d) => d.id).sort();
      return { id: between.length > 0 ? between.join('-') : `outline-${s.level}`, level: s.level, between, lines: s.lines };
    })
    .sort((p, q) => p.level - q.level || (p.id < q.id ? -1 : 1));
  return { divisions, borders };
}

/** The kinds of named places a spec can ask for: values of OpenStreetMap's `place`, inside a country. */
export const PLACE_KINDS = ['city', 'borough', 'suburb', 'quarter', 'neighbourhood', 'city_block', 'town', 'village', 'hamlet', 'isolated_dwelling', 'farm', 'locality', 'square', 'island', 'islet'];

/** The kinds of places a spec asks for, in its order: suburbs, quarters and neighbourhoods by default. */
export function placeKinds(spec) {
  const kinds = spec.kinds ?? ['suburb', 'quarter', 'neighbourhood'];
  if (!Array.isArray(kinds) || kinds.length === 0) throw new Error(`places: "kinds" is a list of values of OpenStreetMap's place: ${PLACE_KINDS.join(', ')}`);
  const bad = kinds.find((k) => !PLACE_KINDS.includes(k));
  if (bad !== undefined) throw new Error(`places: "${bad}" is not a kind of place (the kinds: ${PLACE_KINDS.join(', ')})`);
  return kinds;
}

/**
 * The named places of the kinds asked for (OpenStreetMap's `place=suburb`, `quarter`, `neighbourhood`...) whose point
 * lies in the box: each { id, name, kind, osm, at, lonlat, ring? }. A place mapped as a point stands there; one mapped
 * as an area stands at its label node, or at a point inside it, and brings its outline cut to the box as `ring` (its
 * largest part). A place mapped both ways, a point inside an area of the same kind and the same place (a name the same
 * but for case, accents, spaces and dashes, or the same `wikidata` item), comes once: the area, at the point. In the
 * order of the kinds asked for, then of their names.
 */
export function buildPlaces(spec, frame, elements) {
  const { proj, box } = frame;
  const kinds = placeKinds(spec);
  const tol = spec.detail ?? 4;
  const inBox = ([x, y]) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
  const byId = new Map(elements.map((e) => [`${e.type}/${e.id}`, e]));
  const areas = [];
  for (const a of areasOf(elements, (t, e) => e.type !== 'node' && kinds.includes(t.place) && Boolean(t.name))) {
    const outer = a.outer.map((r) => ({ lonlat: r, plane: r.map(proj.forward) })).sort((p, q) => area(q.plane) - area(p.plane));
    const label = labelOf(byId.get(a.id));
    const mark = label ? proj.forward(label) : null;
    const at = mark && outer.some((r) => pointInRing(mark, r.plane)) ? mark : pointInside(outer[0].plane);
    const ring = ringsInFrame(outer[0].lonlat, proj, box, tol, 1, 0).sort((p, q) => area(q) - area(p))[0];
    areas.push({ name: a.tags.name, kind: a.tags.place, wikidata: a.tags.wikidata, osm: a.id, at, outer: outer.map((r) => r.plane), ...(ring ? { ring } : {}) });
  }
  const same = (a, t) => plainSlug(a.name) === plainSlug(t.name) || (a.wikidata !== undefined && a.wikidata === t.wikidata);
  const points = [];
  for (const e of elements.filter((x) => x.type === 'node').sort((p, q) => p.id - q.id)) {
    const t = e.tags ?? {};
    if (!kinds.includes(t.place) || !t.name || !Number.isFinite(e.lon) || !Number.isFinite(e.lat)) continue;
    const at = proj.forward([e.lon, e.lat]);
    const host = areas.find((a) => a.kind === t.place && !a.point && same(a, t) && a.outer.some((r) => pointInRing(at, r)));
    if (host) Object.assign(host, { at, point: true });
    else points.push({ name: t.name, kind: t.place, osm: `node/${e.id}`, at });
  }
  const all = [...areas, ...points].filter((p) => inBox(p.at));
  all.sort((p, q) => kinds.indexOf(p.kind) - kinds.indexOf(q.kind) || (p.name < q.name ? -1 : p.name > q.name ? 1 : 0) || (p.osm < q.osm ? -1 : 1));
  const idOf = idsByName();
  return all.map((p) => ({ id: idOf(p.name, p.osm), name: p.name, kind: p.kind, osm: p.osm, at: p.at.map(round1), lonlat: proj.inverse(p.at).map((v) => Math.round(v * 1e6) / 1e6), ...(p.ring ? { ring: p.ring } : {}) }));
}

export { centroid, pointInRing };

// Named features of a map that no other layer has a kind for: an open line (a channel, a railway, a runway, an open
// wall, a street picked by name) or an area (a basin, a lake long filled, the footprint of a building, an old
// district), from the ways and relations a source maps, from points drawn after a written source, or from both.

/** The keys a feature of a spec takes. */
export const FEATURE_KEYS = ['id', 'name', 'kind', 'from', 'start', 'built', 'until', 'under', 'view', 'detail', 'smooth', 'source'];

const lonLat = (p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;

/** What is wrong with a feature of a spec, thrown as an error; nothing when it keeps to its form (README.md, "The spec"). */
export function checkFeature(f) {
  const where = `feature ${typeof f?.id === 'string' ? f.id : JSON.stringify(f?.id)}`;
  if (f === null || typeof f !== 'object' || Array.isArray(f)) throw new Error(`features: each is an object { id, name, kind, from, source }, not ${JSON.stringify(f)}`);
  for (const key of Object.keys(f)) if (!FEATURE_KEYS.includes(key)) throw new Error(`${where}: no key "${key}" (a feature takes ${FEATURE_KEYS.join(', ')})`);
  if (typeof f.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(f.id)) throw new Error(`${where}: its id is lower-case letters, digits and hyphens, beginning with a letter`);
  if (typeof f.name !== 'string' || f.name.trim() === '') throw new Error(`${where}: it has a name`);
  if (f.kind !== 'line' && f.kind !== 'area') throw new Error(`${where}: its kind is "line" or "area", not ${JSON.stringify(f.kind)}`);
  if (typeof f.source !== 'string' || f.source.trim() === '') throw new Error(`${where}: it names its source, a sentence for SOURCES.md: the written source it is drawn after, or what the map it is taken from shows`);
  const from = f.from;
  if (from === null || typeof from !== 'object' || Array.isArray(from)) throw new Error(`${where}: "from" is { ohm, osm, points }, one of them or more`);
  for (const key of Object.keys(from)) if (!['ohm', 'osm', 'points'].includes(key)) throw new Error(`${where}: "from" takes ohm, osm and points, not "${key}"`);
  if (!from.ohm && !from.osm && !from.points) throw new Error(`${where}: "from" names elements (ohm, osm) or points drawn by hand`);
  for (const source of ['ohm', 'osm']) {
    if (from[source] === undefined) continue;
    if (!Array.isArray(from[source]) || from[source].length === 0) throw new Error(`${where}: "from.${source}" is a list of elements, way/<id> or relation/<id>`);
    for (const id of from[source]) {
      if (typeof id === 'string' && /^node\/\d+$/.test(id)) throw new Error(`${where}: ${id} is a point; a feature is made of ways and relations (a point of its own is a landmark)`);
      if (typeof id !== 'string' || !/^(way|relation)\/\d+$/.test(id)) throw new Error(`${where}: "${id}" is not way/<id> or relation/<id>`);
    }
  }
  const least = f.kind === 'line' ? 2 : 3;
  if (from.points !== undefined && (!Array.isArray(from.points) || from.points.length < least || !from.points.every(lonLat))) throw new Error(`${where}: "from.points" is a list of ${least} [lon, lat] or more`);
  for (const key of ['built', 'until']) if (f[key] !== undefined && !Number.isInteger(f[key])) throw new Error(`${where}: "${key}" is a year, a whole number (negative before the common era)`);
  if (f.built !== undefined && f.until !== undefined && f.until < f.built) throw new Error(`${where}: it ends (${f.until}) before it is built (${f.built})`);
  if (f.detail !== undefined && !(typeof f.detail === 'number' && f.detail > 0)) throw new Error(`${where}: "detail" is metres above 0`);
  if (f.smooth !== undefined && !(Number.isInteger(f.smooth) && f.smooth >= 0 && f.smooth <= 4)) throw new Error(`${where}: "smooth" is how many times its corners are cut, 0 to 4`);
  if (f.view !== undefined && typeof f.view !== 'string') throw new Error(`${where}: "view" names a view of the spec`);
  if (f.kind === 'area') {
    for (const key of ['under', 'start']) if (f[key] !== undefined) throw new Error(`${where}: "${key}" is for a line, and it is an area`);
    return;
  }
  if (f.start !== undefined && !lonLat(f.start)) throw new Error(`${where}: "start" is [lon, lat], the place the line begins at`);
  if (f.under === undefined) return;
  if (!Array.isArray(f.under) || f.under.length === 0) throw new Error(`${where}: "under" is a list of [from, to] in kilometres along the line`);
  let at = 0;
  for (const pair of f.under) {
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((v) => typeof v === 'number' && Number.isFinite(v))) throw new Error(`${where}: "under" is a list of [from, to] in kilometres along the line, not ${JSON.stringify(pair)}`);
    if (!(pair[0] >= at && pair[1] > pair[0])) throw new Error(`${where}: the stretches of "under" run from the start onwards, each ending after it begins and none over another: ${JSON.stringify(pair)}`);
    at = pair[1];
  }
}

/** The features of a spec, each checked, with no id twice. */
export function checkFeatures(list) {
  if (!Array.isArray(list)) throw new Error('features: a list of features');
  for (const f of list) checkFeature(f);
  const ids = list.map((f) => f.id);
  const twice = ids.find((id, k) => ids.indexOf(id) !== k);
  if (twice !== undefined) throw new Error(`features: the id "${twice}" is given twice`);
}

/**
 * The lines of the elements named, as [lon, lat], from an Overpass answer with their geometry: a way's own line, a
 * relation's member ways (those whose role `keep` takes). `missing` names the elements the answer lacks.
 */
export function elementLines(elements, ids, keep = () => true) {
  const lines = [];
  const missing = [];
  for (const id of ids ?? []) {
    const [type, ref] = id.split('/');
    const e = (elements ?? []).find((x) => x.type === type && String(x.id) === ref);
    if (!e) {
      missing.push(id);
      continue;
    }
    if (type === 'way') lines.push(...waysOf([e]).map((w) => w.line));
    else {
      for (const m of e.members ?? []) {
        if (m.type !== 'way' || !m.geometry || !keep(m.role ?? '')) continue;
        const line = m.geometry.filter(Boolean).map((p) => [p.lon, p.lat]);
        if (line.length >= 2) lines.push(line);
      }
    }
  }
  return { lines, missing };
}

/**
 * A feature of the map in the plane of its frame, cut to its view. `mapped` are the lines of its elements in
 * [lon, lat] (elementLines); the points drawn by hand (`from.points`) are one line more.
 *
 * A line: the lines are joined end to end where their ends meet, each begins at its end nearer `start` (the first
 * point given by default), and the longest comes first: `lines`, cut to the view; `lengthKm` is the whole of it, also
 * where the view cuts it. `under`, stretches in kilometres from its start, splits a line that joins into one into
 * `stretches`, in order along it, each { under, fromKm, toKm, lines } cut to the view, so a scene can draw the
 * stretches below the ground apart (dashed, or faint).
 *
 * An area: the ways close into rings (a relation's inner ways are left out: an area keeps no holes), the points drawn
 * are a ring more; `ring` is its largest part in the view, `pieces` the others, the largest first, and `areaHa` all of
 * it in the view.
 *
 * `detail` is the thinning in metres (2); `smooth` cuts the corners that many times, a quarter of each side at a
 * time (0: as drawn or mapped).
 */
export function buildFeature(spec, frame, mapped = []) {
  checkFeature(spec);
  const { proj, box } = frame;
  const tol = spec.detail ?? 2;
  const times = spec.smooth ?? 0;
  const drawn = spec.from.points;
  const head = { id: spec.id, name: spec.name, kind: spec.kind, ...(spec.built === undefined ? {} : { built: spec.built }), ...(spec.until === undefined ? {} : { until: spec.until }) };
  if (spec.kind === 'line') {
    const inputs = [...mapped, ...(drawn ? [drawn] : [])];
    if (inputs.length === 0) throw new Error(`feature ${spec.id}: its elements hold no way`);
    const start = proj.forward(spec.start ?? inputs[0][0]);
    const chains = joinLines(inputs, { eps: 1e-7 }).map((c) => {
      let pts = dedupe(c.line.map(proj.forward), 1e-6, c.closed);
      // Its corners cut all the way, a quarter of each side at a time, where the spec smooths it.
      if (times > 0) pts = soften(pts, tol, times, c.closed, Infinity) ?? pts;
      if (c.closed) {
        // A line that closes on itself begins at its point nearest the start, and ends there.
        let k = 0;
        for (let i = 1; i < pts.length; i++) if (dist(pts[i], start) < dist(pts[k], start)) k = i;
        return [...pts.slice(k), ...pts.slice(0, k), pts[k]];
      }
      return dist(pts[pts.length - 1], start) < dist(pts[0], start) ? [...pts].reverse() : pts;
    });
    chains.sort((a, b) => lengthOf(b) - lengthOf(a) || a[0][0] - b[0][0] || a[0][1] - b[0][1]);
    const pieces = (pts) => {
      const out = [];
      for (const piece of clipLine(pts, box)) {
        const r = roundPoints(simplify(piece, tol), 1);
        if (r.length >= 2 && lengthOf(r) > 0) out.push(r);
      }
      return out;
    };
    const lines = chains.flatMap(pieces);
    if (lines.length === 0) throw new Error(`feature ${spec.id}: no part of it lies in its view`);
    const out = { ...head, lengthKm: km(chains.reduce((sum, c) => sum + lengthOf(c), 0)), lines };
    if (spec.under) {
      if (chains.length > 1) throw new Error(`feature ${spec.id}: "under" needs a line that joins into one, and its ways and points make ${chains.length} lines whose ends lie apart: draw the missing stretch under "points", or leave "under" out`);
      const length = lengthOf(chains[0]) / 1000;
      const last = spec.under[spec.under.length - 1][1];
      if (last > length + 0.005) throw new Error(`feature ${spec.id}: "under" runs to ${last} km, and the line is ${km(length * 1000)} km long`);
      const marks = [];
      let at = 0;
      for (const [a, b] of spec.under) {
        if (a > at) marks.push([at, a, false]);
        marks.push([a, Math.min(b, length), true]);
        at = Math.min(b, length);
      }
      if (length - at > 1e-6) marks.push([at, length, false]);
      out.stretches = marks.map(([a, b, under]) => ({ under, fromKm: km(a * 1000), toKm: km(b * 1000), lines: pieces(sliceLine(chains[0], a * 1000, b * 1000)) })).filter((s) => s.lines.length > 0);
    }
    return out;
  }
  const rings = [];
  if (mapped.length > 0) {
    const chains = joinLines(mapped, { eps: 1e-7 });
    const open = chains.filter((c) => !c.closed);
    if (open.length > 0) throw new Error(`feature ${spec.id}: its ways do not close into rings (${open.length} open line(s)): name every way of its outline, or draw it under "points"`);
    rings.push(...chains.map((c) => c.line));
  }
  if (drawn) rings.push(drawn);
  const parts = [];
  for (const r of rings) {
    let pts = dedupe(r.map(proj.forward), 1e-6, true);
    if (times > 0) pts = soften(pts, tol, times, true, Infinity) ?? pts;
    if (pts.length < 3 || crosses(pts)) throw new Error(`feature ${spec.id}: its outline crosses itself`);
    for (const piece of clipRing(pts, box)) {
      const cut = simplifySafe(piece, tol, true);
      if (!cut || cut.length < 3) continue;
      const q = roundPoints(cut, 1, true);
      if (q.length >= 3 && area(q) > 0 && !crosses(q)) parts.push(orient(q, true));
    }
  }
  if (parts.length === 0) throw new Error(`feature ${spec.id}: no part of it lies in its view`);
  parts.sort((a, b) => area(b) - area(a) || a[0][0] - b[0][0] || a[0][1] - b[0][1]);
  return { ...head, areaHa: Math.round(parts.reduce((sum, p) => sum + area(p), 0) / 1000) / 10, ring: parts[0], pieces: parts.slice(1) };
}
