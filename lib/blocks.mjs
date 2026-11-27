// A city's blocks: the land its streets leave between them, as outlines. The streets (OpenStreetMap's or
// OpenHistoricalMap's ways of the classes asked for, or lines drawn by hand after a historic plan) are laid on a
// raster of the view, each as wide as its class; the open squares and the water are taken out with them; what is left
// inside the city's bounds falls into pieces, and each piece is traced, thinned and kept if it is large enough: a block.
// For a scene, `mergeBlocks` makes the blocks of a stage coarser: it joins blocks across lanes too narrow to be seen.

import { area, centroid, orient, roundPoints, signedArea, simplifySafe } from './geom.mjs';
import { alive, areasOf, waysOf } from './osm.mjs';
import { closeGaps, contours, distanceTo, fillPolygon, makeGrid } from './raster.mjs';

/** The classes of OpenStreetMap's `highway` that part blocks, unless a spec names its own. */
export const BLOCK_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'pedestrian', 'service'];

/** How wide a street of each class is laid on the raster, in metres, unless a spec says otherwise (`widths`). */
export const BLOCK_WIDTHS = {
  motorway: 26, trunk: 22, primary: 18, secondary: 15, tertiary: 12, unclassified: 9, residential: 9, living_street: 7,
  pedestrian: 7, service: 5, road: 8, track: 4, footway: 3, path: 3, cycleway: 3, steps: 3,
};

/** The keys a spec's `blocks` may have. */
const KEYS = ['view', 'from', 'classes', 'widths', 'cell', 'within', 'water', 'squares', 'minArea', 'detail', 'lines', 'year'];

/** The classes of a spec's blocks, each with its width; refused when a class has none. */
export function blockClasses(spec) {
  const classes = spec.classes ?? BLOCK_CLASSES;
  if (!Array.isArray(classes) || classes.length === 0) throw new Error('blocks: "classes" is a list of values of highway');
  const widths = { ...BLOCK_WIDTHS, ...(spec.widths ?? {}) };
  for (const c of classes) {
    if (!(typeof widths[c] === 'number' && widths[c] > 0)) throw new Error(`blocks: the class "${c}" has no width: give it in "widths" (metres)`);
  }
  return { classes, widths };
}

/** A spec's `blocks`, checked: what is wrong with it stops the build. */
export function checkBlocks(spec) {
  for (const k of Object.keys(spec)) if (!KEYS.includes(k)) throw new Error(`blocks: unknown key "${k}" (keys: ${KEYS.join(', ')})`);
  if (spec.from !== undefined && spec.from !== 'osm' && spec.from !== 'ohm') throw new Error(`blocks: "from" is "osm" or "ohm", not "${spec.from}"`);
  if (spec.from === undefined && !(Array.isArray(spec.lines) && spec.lines.length > 0)) throw new Error('blocks: give "from" (osm or ohm), or the streets as "lines" drawn by hand, or both');
  if (spec.year !== undefined && spec.from !== 'ohm') throw new Error('blocks: "year" picks the streets of OpenHistoricalMap that stood then: give "from": "ohm"');
  const { classes, widths } = blockClasses(spec);
  for (const [k, l] of (spec.lines ?? []).entries()) {
    if (!l || !Array.isArray(l.points) || l.points.length < 2) throw new Error(`blocks: lines[${k}] is { class?, points: [[lon, lat], ...] } with two points or more`);
    if (l.class !== undefined && !(typeof widths[l.class] === 'number')) throw new Error(`blocks: lines[${k}] is of the class "${l.class}", which has no width`);
  }
  const w = spec.within;
  if (w !== undefined && !(w && (typeof w.wall === 'string' || (Array.isArray(w.points) && w.points.length >= 3)))) {
    throw new Error('blocks: "within" is { wall: <the id of a wall of the spec> } or { points: [[lon, lat], ...] }');
  }
  const cell = spec.cell ?? 2;
  if (!(cell >= 0.5 && cell <= 20)) throw new Error('blocks: "cell" is 0.5 to 20 metres');
  return { classes, widths, cell };
}

/**
 * The street lines of an answer of Overpass and of the spec's own lines, on the plane of `proj`: { width, line }
 * each. From OpenHistoricalMap with `year`, only the streets that stood that year. A line drawn by hand without a
 * class is a residential street.
 */
export function blockStreets(spec, proj, elements = []) {
  const { classes, widths } = blockClasses(spec);
  const out = [];
  const dated = spec.from === 'ohm' && spec.year !== undefined;
  for (const w of waysOf(elements, (t) => classes.includes(t.highway) && t.area !== 'yes' && (!dated || alive(t, spec.year)))) {
    out.push({ width: widths[w.tags.highway], line: w.line.map(proj.forward) });
  }
  for (const l of spec.lines ?? []) out.push({ width: widths[l.class ?? 'residential'], line: l.points.map(proj.forward) });
  return out;
}

/** The open squares of an answer: places mapped as squares and pedestrian areas, { id, tags, outer, inner } in lon/lat. */
export function blockSquares(elements = [], year = null) {
  return areasOf(elements, (t) => (t.place === 'square' || (t.highway === 'pedestrian' && t.area === 'yes')) && (year === null || alive(t, year)));
}

/** The cells a polyline of the plane passes, marked 1 on a grid: a sample at least every half cell. */
function markLine(g, line) {
  for (let k = 1; k < line.length; k++) {
    const [ax, ay] = line[k - 1];
    const [bx, by] = line[k];
    const steps = Math.max(1, Math.ceil((2 * Math.hypot(bx - ax, by - ay)) / g.cell));
    for (let s = 0; s <= steps; s++) {
      const i = Math.floor((ax + ((bx - ax) * s) / steps - g.x0) / g.cell);
      const j = Math.floor((ay + ((by - ay) * s) / steps - g.y0) / g.cell);
      if (i >= 0 && j >= 0 && i < g.w && j < g.h) g.data[j * g.w + i] = 1;
    }
  }
}

/** The outlines of the land of a grid: traced, thinned to `detail` without crossing, counter-clockwise, at least `minArea`. */
function traced(g, detail, minArea) {
  const out = [];
  for (const ring of contours(g, 0.5).rings) {
    // A hole in the land (a square, a court) runs the other way round: not a block.
    if (signedArea(ring) <= 0) continue;
    const thin = simplifySafe(ring, detail, true);
    if (!thin || thin.length < 3) continue;
    const pts = orient(roundPoints(thin, 1, true), true);
    if (pts.length >= 3 && area(pts) >= minArea) out.push(pts);
  }
  return out;
}

/**
 * The blocks of a city on the plane of `frame` ({ box }): the land inside `within` (a ring; the whole box without one)
 * that the streets ({ width, line }), the squares and the water (rings) leave, traced on a raster of `cell` metres (2),
 * each outline thinned to `detail` metres (1.5) without crossing itself, and kept when it holds `minArea` square metres
 * (150). They come counter-clockwise, the largest first: { id, areaHa, ring }. A hole in a block (a court closed all
 * round) is not kept: the block is drawn whole.
 */
export function buildBlocks(spec, frame, { streets = [], squares = [], water = [], within = null } = {}) {
  const cell = spec.cell ?? 2;
  if (!(cell >= 0.5 && cell <= 20)) throw new Error('blocks: "cell" is 0.5 to 20 metres');
  const land = makeGrid(frame.box, cell, within ? 0 : 1);
  if (within) fillPolygon(land, [within], 1);
  // One distance to the nearest centre line for each width of street: the land within half a width of one is street.
  const byWidth = new Map();
  for (const s of streets) {
    if (!byWidth.has(s.width)) byWidth.set(s.width, []);
    byWidth.get(s.width).push(s.line);
  }
  for (const [width, lines] of [...byWidth.entries()].sort((a, b) => a[0] - b[0])) {
    const centres = makeGrid(frame.box, cell);
    for (const line of lines) markLine(centres, line);
    const d = distanceTo(centres, (v) => v >= 0.5);
    const half = width / 2 / cell;
    for (let k = 0; k < land.data.length; k++) if (d.data[k] <= half) land.data[k] = 0;
  }
  for (const ring of [...squares, ...water]) fillPolygon(land, [ring], 0);
  const out = traced(land, spec.detail ?? 1.5, spec.minArea ?? 150);
  const key = out.map((ring) => ({ ring, area: area(ring), at: centroid(ring) }));
  key.sort((a, b) => b.area - a.area || a.at[0] - b.at[0] || a.at[1] - b.at[1]);
  return key.map(({ ring, area: a }, k) => ({ id: `block-${k}`, areaHa: Math.round(a / 100) / 100, ring }));
}

/**
 * Blocks made coarser: the outlines of a plane (a stage, say) joined across the gaps between them narrower than
 * `merge` units, on a raster of `cell` units (a third of `merge`), traced, thinned to `detail` units (half a cell) and
 * kept when they hold `minArea` square units (0). They come counter-clockwise in the plane's own axes: on a stage,
 * whose y runs down, they turn the other way on the screen; a renderer that fills outlines of one winding together
 * takes them all alike.
 */
export function mergeBlocks(rings, { merge, cell = merge / 3, detail = cell / 2, minArea = 0 }) {
  if (!(merge > 0)) throw new Error('mergeBlocks: merge must be above 0');
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const ring of rings) {
    for (const [x, y] of ring) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  if (!(x1 > x0 && y1 > y0)) return [];
  const pad = merge + 2 * cell;
  const g = makeGrid([x0 - pad, y0 - pad, x1 + pad, y1 + pad], cell);
  for (const ring of rings) fillPolygon(g, [ring], 1);
  return traced(closeGaps(g, merge / 2 / cell), detail, minArea);
}
