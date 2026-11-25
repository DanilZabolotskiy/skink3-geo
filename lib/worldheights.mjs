// The heights and depths of a world map: a coarse grid of the ground and the sea floor in metres (from a global relief
// model, ETOPO1), resampled onto the plane of the map's frame, and the shallows, the sea above a depth, as regions.
// A relief of the land reads the grid with its sea part held at sea level; the shallows are painted under the land.

import { area, dedupe, orient, simplifySafe } from './geom.mjs';
import { equalEarth, unprojectBox } from './project.mjs';
import { contours, makeGrid } from './raster.mjs';
import { frameOptions, worldFrame } from './world.mjs';

const round1 = (v) => Math.round(v * 10) / 10 + 0;

/**
 * An Esri ASCII grid, as text: { cols, rows, west, south, cell, values } with `west` and `south` the longitude and
 * latitude of the middle of its first column and last row, `cell` the degrees between samples, and `values` row by
 * row from the north, each row from the west. A sample the grid has no value for is refused: a relief model of the
 * whole Earth has one everywhere.
 */
export function readEsriAscii(text) {
  const lines = String(text).split(/\r?\n/);
  const head = {};
  let k = 0;
  for (; k < lines.length; k++) {
    const m = /^\s*([a-z_]+)\s+(\S+)\s*$/i.exec(lines[k]);
    if (!m) break;
    head[m[1].toLowerCase()] = Number(m[2]);
  }
  const { ncols: cols, nrows: rows, cellsize: cell } = head;
  const west = head.xllcenter ?? (head.xllcorner === undefined ? NaN : head.xllcorner + cell / 2);
  const south = head.yllcenter ?? (head.yllcorner === undefined ? NaN : head.yllcorner + cell / 2);
  if (!(Number.isInteger(cols) && Number.isInteger(rows) && cols >= 2 && rows >= 2 && cell > 0 && Number.isFinite(west) && Number.isFinite(south))) throw new Error('etopo: not an Esri ASCII grid (ncols, nrows, xllcenter, yllcenter, cellsize)');
  const values = new Float32Array(cols * rows);
  let n = 0;
  const none = head.nodata_value;
  for (; k < lines.length && n < values.length; k++) {
    for (const word of lines[k].trim().split(/\s+/)) {
      if (word === '') continue;
      const v = Number(word);
      if (!Number.isFinite(v) || v === none) throw new Error(`etopo: the grid has no height at its sample ${n}`);
      values[n++] = v;
    }
  }
  if (n !== values.length) throw new Error(`etopo: the grid holds ${n} heights, not ${cols} by ${rows}`);
  return { cols, rows, west, south, cell, values };
}

/**
 * The height of a grid of degrees at [lon, lat], read between its four nearest samples; a grid round the whole Earth
 * wraps, and one across the 180th meridian (joinGrids) reads a longitude named either way round.
 */
export function degreesAt(grid, [lon, lat]) {
  const { cols, rows, west, south, cell, values } = grid;
  const round = Math.abs(cols * cell - 360) < cell * 1.01 || Math.abs((cols - 1) * cell - 360) < cell * 0.01;
  let u = (lon - west) / cell;
  const span = Math.round(360 / cell);
  if (round) u = ((u % span) + span) % span;
  // A grid across the 180th meridian carries its longitudes on past it; a point may be named either way round.
  else if (u < 0 && u + span <= cols - 1) u += span;
  else if (u > cols - 1 && u - span >= 0) u -= span;
  const v = (south + (rows - 1) * cell - lat) / cell;
  const fu = Math.min(cols - 1, Math.max(0, u));
  const fv = Math.min(rows - 1, Math.max(0, v));
  const c0 = Math.min(cols - 2, Math.floor(fu));
  const r0 = Math.min(rows - 2, Math.floor(fv));
  const [a, b] = [fu - c0, fv - r0];
  const at = (c, r) => values[r * cols + c];
  return (at(c0, r0) * (1 - a) + at(c0 + 1, r0) * a) * (1 - b) + (at(c0, r0 + 1) * (1 - a) + at(c0 + 1, r0 + 1) * a) * b;
}

/**
 * What a world map's heights are read from: the parts of the relief model it needs, in degrees ([west, south, east,
 * north] from -180 to 180: two parts for a box across the 180th meridian, the west one ending on it), and one sample
 * every `stride` minutes, two to a cell of the grid it makes. `cell` is that grid's metres between points; by default
 * the box's longer side is cut into 600.
 */
export function heightsPlan(frame, cell = null) {
  const [x0, y0, x1, y1] = frame.box;
  const c = cell ?? Math.max(1000, Math.round(Math.max(x1 - x0, y1 - y0) / 600 / 1000) * 1000);
  if (!(Number.isFinite(c) && c >= 100)) throw new Error(`world: the cell of the heights is metres, 100 or more, got ${cell}`);
  const stride = Math.max(1, Math.min(60, Math.round(c / 1852 / 2)));
  if (frame.projection === 'equal-earth') return { cell: c, stride, boxes: [[-180, -90, 180, 90]] };
  const { proj } = worldFrame(frameOptions(frame));
  let [a0, b0, a1, b1] = unprojectBox(proj, frame.box);
  if (a0 < -180) [a0, a1] = [a0 + 360, a1 + 360];
  const pad = stride / 60;
  // On the model's own samples, every `stride` minutes from -180°, so that two parts meet on one.
  const down = (v) => (Math.floor(((v + 180) * 60) / stride) * stride) / 60 - 180;
  const up = (v) => (Math.ceil(((v + 180) * 60) / stride) * stride) / 60 - 180;
  const lat = (v, f) => Math.max(-90, Math.min(90, f(v * 60) / 60));
  const [south, north] = [lat(b0 - pad, Math.floor), lat(b1 + pad, Math.ceil)];
  [a0, a1] = [down(a0 - pad), up(a1 + pad)];
  if (a1 - a0 >= 360) return { cell: c, stride, boxes: [[-180, south, 180, north]] };
  if (a1 <= 180) return { cell: c, stride, boxes: [[Math.max(-180, a0), south, a1, north]] };
  return { cell: c, stride, boxes: [[a0, south, 180, north], [-180, south, a1 - 360, north]] };
}

/**
 * Two grids of the model side by side as one: `east` the part beyond the 180th meridian, its longitudes carried on past
 * 180, its first column dropped where it is the last of `west` again.
 */
export function joinGrids(west, east) {
  if (west.rows !== east.rows || Math.abs(west.south - east.south) > 1e-9 || Math.abs(west.cell - east.cell) > 1e-12) throw new Error('etopo: the two parts of the grid do not meet row for row');
  const last = west.west + (west.cols - 1) * west.cell;
  const first = east.west + 360;
  const skip = Math.abs(first - last) < west.cell / 100 ? 1 : 0;
  if (!skip && Math.abs(first - last - west.cell) > west.cell / 100) throw new Error(`etopo: the two parts of the grid do not meet (the west ends at ${last}°, the east begins at ${east.west}°)`);
  const cols = west.cols + east.cols - skip;
  const values = new Float32Array(cols * west.rows);
  for (let r = 0; r < west.rows; r++) {
    values.set(west.values.subarray(r * west.cols, (r + 1) * west.cols), r * cols);
    values.set(east.values.subarray(r * east.cols + skip, (r + 1) * east.cols), r * cols + west.cols);
  }
  return { cols, rows: west.rows, west: west.west, south: west.south, cell: west.cell, values };
}

/**
 * The heights of a world map on the plane of its frame, from a grid in degrees (readEsriAscii): a point every `cell`
 * metres over the frame's box, from its north-west corner, each the height there in metres to a tenth (above 0 the
 * land, below it the sea floor), row by row from the north, as `HeightGrid` holds them. Beyond the edge of the world
 * (the corners of a whole world's box) a point takes the height of the deepest sample.
 * With `shallows` (depths in metres, as positive numbers), also the shallows: for each depth, the regions where the
 * ground lies above it, the land with the sea that is shallower, thinned to `detail` and without the pieces under
 * `minArea` m²; `holes` are deeper water inside them, painted over in the sea's colour as a world map's gaps are.
 */
export function buildHeights(degrees, frame, { cell, detail, minArea = 0, shallows = [] }) {
  const [x0, y0, x1, y1] = frame.box;
  const cols = Math.max(2, Math.floor((x1 - x0) / cell + 1e-9) + 1);
  const rows = Math.max(2, Math.floor((y1 - y0) / cell + 1e-9) + 1);
  let deepest = Infinity;
  for (const v of degrees.values) if (v < deepest) deepest = v;
  const back = inverseOf(frame);
  const at = (x, y) => {
    const ll = back([x, y]);
    return ll ? degreesAt(degrees, ll) : deepest;
  };
  const values = new Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) values[r * cols + c] = round1(at(x0 + c * cell, y1 - r * cell));
  const heights = { box: [x0, round1(y1 - (rows - 1) * cell), round1(x0 + (cols - 1) * cell), y1], cell, cols, rows, values };
  const out = [];
  for (const depth of shallows) {
    if (!(Number.isFinite(depth) && depth > 0 && depth <= 11000)) throw new Error(`world: a depth of the shallows is metres below the sea, above 0, got ${depth}`);
    // A raster of the same points (its samples stand in the middle of its cells), so the contour lies where they say.
    const g = makeGrid([x0 - cell / 2, heights.box[1] - cell / 2, heights.box[2] + cell / 2, y1 + cell / 2], cell);
    for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) g.data[j * g.w + i] = values[(rows - 1 - Math.min(rows - 1, j)) * cols + Math.min(cols - 1, i)];
    const { rings } = contours(g, -depth);
    const thin = (ring) => {
      const cut = simplifySafe(dedupe(ring, 1e-6, true), detail, true);
      if (!cut) return null;
      const r = dedupe(cut.map(([x, y]) => [Math.max(x0, Math.min(x1, Math.round(x))) + 0, Math.max(y0, Math.min(y1, Math.round(y))) + 0]), 0, true);
      return r.length >= 3 && area(r) >= Math.max(minArea, 1) ? r : null;
    };
    // A ring round high ground runs counter-clockwise; one round deeper water inside it, clockwise.
    const outer = [];
    const holes = [];
    for (const ring of rings) {
      const r = thin(ring);
      if (!r) continue;
      if (signed(ring) > 0) outer.push(orient(r, true));
      else holes.push(orient(r, true));
    }
    outer.sort((a, b) => area(b) - area(a) || a[0][0] - b[0][0]);
    holes.sort((a, b) => area(b) - area(a) || a[0][0] - b[0][0]);
    out.push({ id: `shallows-${depth}`, depth, rings: outer, holes });
  }
  return { heights, shallows: out };
}

function signed(ring) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [a, b] = [ring[i], ring[(i + 1) % ring.length]];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** From the plane of a frame back to [lon, lat]; null beyond the edge of the world. */
function inverseOf(frame) {
  if (frame.projection === 'equal-earth') {
    const plane = equalEarth();
    const lon0 = frame.centre[0];
    return (p) => {
      const [lo, la] = plane.inverse(p);
      if (!(Math.abs(lo) <= 180 && Math.abs(la) <= 90)) return null;
      const l = lo + lon0;
      return [l > 180 ? l - 360 : l < -180 ? l + 360 : l, la];
    };
  }
  const { proj } = worldFrame(frameOptions(frame));
  return (p) => proj.inverse(p);
}

