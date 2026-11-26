// The sea floor of a world map and of a globe, by bands and by kinds: the age of the oceanic crust in bands of age
// (EarthByte's age grid, Seton et al. 2020), the depth of the sea in bands of depth (ETOPO1), and the sediments that
// cover the floor by kind (EarthByte's seafloor lithology, Dutkiewicz et al. 2015). Each is a grid of the Earth in
// degrees; each cell of the map's own grid takes the band or the kind most of its points have, the cells of one band
// or kind are traced into outlines along their edges, and the outlines are thinned together, so that two bands or two
// kinds share their border point for point, and painted one after the other they leave no gap and no overlap.
//
// On a world map the grid lies on the plane of its frame, in metres. On a globe it lies in degrees, cut into four
// lunes of 90 degrees of longitude: no polygon is larger than a quarter of the sphere, so each is whole on it, and a
// band that runs over a lune's meridian is parted there, as Natural Earth's islands at the 180th meridian are.

import { area, orient, pointInRing, signedArea } from './geom.mjs';
import { areaKm2, EARTH_KM, orientOnSphere, wholeRing } from './globe.mjs';
import { readNetcdfHeader, readNetcdfVariable } from './netcdf.mjs';
import { thinTogether } from './topology.mjs';
import { inverseOf } from './worldheights.mjs';

/** The kinds of sediment of the seafloor lithology grid, by their codes in it (its README). */
export const SEDIMENT_KINDS = Object.freeze([
  { code: 1, id: 'gravel', name: 'Gravel and coarser' },
  { code: 2, id: 'sand', name: 'Sand' },
  { code: 3, id: 'silt', name: 'Silt' },
  { code: 4, id: 'clay', name: 'Clay' },
  { code: 5, id: 'calcareous-ooze', name: 'Calcareous ooze' },
  { code: 6, id: 'radiolarian-ooze', name: 'Radiolarian ooze' },
  { code: 7, id: 'diatom-ooze', name: 'Diatom ooze' },
  { code: 8, id: 'sponge-spicules', name: 'Sponge spicules' },
  { code: 9, id: 'mixed-ooze', name: 'Mixed calcareous/siliceous ooze' },
  { code: 10, id: 'shells-coral', name: 'Shells and coral fragments' },
  { code: 11, id: 'volcanic', name: 'Ash and volcanic sand/gravel' },
  { code: 12, id: 'siliceous-mud', name: 'Siliceous mud' },
  { code: 13, id: 'calcareous-sediment', name: 'Fine-grained calcareous sediment' },
]);

/**
 * A grid of the Earth in degrees from a netCDF classic file whose variable `z` runs over `lat` (south first) and
 * `lon`: `{ cols, rows, west, south, cell, values }`, the values row by row from the north (as an Esri ASCII grid is
 * read), NaN where the grid has none. `west` and `south` are the longitude and latitude of the first sample.
 */
export function degreeGridOf(bytes, varName = 'z') {
  const header = readNetcdfHeader(bytes);
  const z = header.vars.find((v) => v.name === varName);
  if (!z || z.dims.length !== 2) throw new Error(`seafloor: the grid has no variable "${varName}" over two dimensions (it has ${header.vars.map((v) => v.name).join(', ')})`);
  const [latName, lonName] = z.dims;
  const lat = readNetcdfVariable(bytes, latName).values;
  const lon = readNetcdfVariable(bytes, lonName).values;
  const [rows, cols] = z.shape;
  const cell = (lon[cols - 1] - lon[0]) / (cols - 1);
  if (!(cell > 0) || Math.abs((lat[rows - 1] - lat[0]) / (rows - 1) - cell) > cell * 1e-6) throw new Error('seafloor: the grid is not of one cell in longitude and latitude, south first');
  const { values } = readNetcdfVariable(bytes, varName);
  // Row by row from the north.
  const out = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) out.set(values.subarray((rows - 1 - r) * cols, (rows - r) * cols), r * cols);
  return { cols, rows, west: lon[0], south: lat[0], cell, values: out };
}

/** The value of the sample of a grid of degrees nearest to [lon, lat]; a grid round the whole Earth wraps. */
export function nearestAt(grid, lon, lat) {
  const { cols, rows, west, south, cell, values } = grid;
  const span = Math.round(360 / cell);
  let c = Math.round((lon - west) / cell);
  if (cols >= span) c = ((c % span) + span) % span;
  c = Math.min(cols - 1, Math.max(0, c));
  const r = Math.min(rows - 1, Math.max(0, Math.round((south + (rows - 1) * cell - lat) / cell)));
  return values[r * cols + c];
}

/**
 * Bands between levels: `levels` in order (20, 40, 60), each band from one level to the next, the first from 0 and the
 * last open: `{ id, from, to }` with `to` null for the last, `id` as `<kind>-<from>-<to>` (`age-0-20`, `age-60-more`).
 */
export function bandsOf(kind, levels) {
  if (!Array.isArray(levels) || levels.length === 0 || !levels.every((v, k) => Number.isFinite(v) && v > 0 && (k === 0 || v > levels[k - 1]))) {
    throw new Error(`seafloor: the levels of the bands of ${kind} are numbers above 0, in order, each once; got ${JSON.stringify(levels)}`);
  }
  const edges = [0, ...levels];
  return edges.map((from, k) => ({ id: `${kind}-${from}-${k + 1 < edges.length ? edges[k + 1] : 'more'}`, from, to: k + 1 < edges.length ? edges[k + 1] : null }));
}

/** The band of a value among the bands of `levels`: 0 below the first level, k between level k and the next; -1 for no value or one below 0. */
export function bandIndex(levels, v) {
  if (!(v >= 0)) return -1;
  let k = 0;
  while (k < levels.length && v >= levels[k]) k++;
  return k;
}

/**
 * The groups of sediment a map asks for, from the text of its option: `all`, every kind of the grid on its own; or
 * names with the codes they join, `carbonate=5+9+13,other=rest`, where `rest` is every code no other group names.
 * Returns `[{ id, codes, names }]` in the order given.
 */
export function sedimentGroups(text) {
  const t = String(text ?? '').trim();
  if (t === 'all') return SEDIMENT_KINDS.map((k) => ({ id: k.id, codes: [k.code], names: [k.name] }));
  const parts = t.split(',').map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length === 0) throw new Error('seafloor: --sediments takes all, or groups as name=code+code (carbonate=5+9+13,other=rest)');
  const known = new Set(SEDIMENT_KINDS.map((k) => k.code));
  const taken = new Set();
  const groups = parts.map((p) => {
    const m = /^([a-z][a-z0-9-]*)=(rest|\d+(?:\+\d+)*)$/.exec(p);
    if (!m) throw new Error(`seafloor: a group of sediments is name=code+code or name=rest, in small letters (carbonate=5+9+13); got ${JSON.stringify(p)}`);
    const codes = m[2] === 'rest' ? null : m[2].split('+').map(Number);
    for (const c of codes ?? []) {
      if (!known.has(c)) throw new Error(`seafloor: the sediment grid has no code ${c} (it has ${[...known].join(', ')}: ${SEDIMENT_KINDS.map((k) => `${k.code} ${k.name}`).join('; ')})`);
      if (taken.has(c)) throw new Error(`seafloor: the code ${c} is in two groups of sediments`);
      taken.add(c);
    }
    return { id: m[1], codes };
  });
  if (new Set(groups.map((g) => g.id)).size !== groups.length) throw new Error('seafloor: two groups of sediments have one name');
  if (groups.filter((g) => g.codes === null).length > 1) throw new Error('seafloor: rest is given to one group of sediments at most');
  return groups.map((g) => {
    const codes = g.codes ?? SEDIMENT_KINDS.map((k) => k.code).filter((c) => !taken.has(c));
    return { id: g.id, codes, names: codes.map((c) => SEDIMENT_KINDS.find((k) => k.code === c).name) };
  });
}

/** The class most of a cell's points have, -1 (none) taking part as any class; a tie goes to the class of its middle. */
function majority(votes, middle) {
  let best = middle;
  let most = 0;
  const counts = new Map();
  for (const v of votes) counts.set(v, (counts.get(v) ?? 0) + 1);
  for (const [v, n] of counts) if (n > most || (n === most && v === middle)) [best, most] = [v, n];
  return best;
}

/**
 * A cell's class. Of kinds: the class of most of 3 by 3 points across it (`at` gives a class). Of bands of a value
 * (`levels`): the band of the mean of 4 by 4 points across it (`at` gives the value; a cell more than half of whose
 * points have none has none), which smooths what the bands follow.
 */
function classOfCell(at, x, y, cell, levels = null) {
  if (levels) {
    let sum = 0;
    let n = 0;
    for (let b = 0; b < 4; b++) {
      for (let a = 0; a < 4; a++) {
        const v = at(x + ((a + 0.5) / 4) * cell, y + ((b + 0.5) / 4) * cell);
        if (Number.isFinite(v)) [sum, n] = [sum + v, n + 1];
      }
    }
    return n < 8 ? -1 : bandIndex(levels, sum / n);
  }
  const votes = [];
  for (let b = 0; b < 3; b++) for (let a = 0; a < 3; a++) votes.push(at(x + ((a + 0.5) / 3) * cell, y + ((b + 0.5) / 3) * cell));
  return majority(votes, votes[4]);
}

/**
 * A grid of classes over the plane of a world map's frame: cells of `cell` metres from the south-west corner of its
 * box, row 0 the southernmost, each the class `classify(lon, lat)` gives most of its points (-1: none; beyond the
 * edge of the world, -1). With `levels`, `classify` gives a value, and a cell is of the band of the mean of its points.
 */
export function planeClasses(frame, cell, classify, levels = null) {
  const [x0, y0, x1, y1] = frame.box;
  const cols = Math.max(1, Math.ceil((x1 - x0) / cell - 1e-9));
  const rows = Math.max(1, Math.ceil((y1 - y0) / cell - 1e-9));
  const back = inverseOf(frame);
  const at = (x, y) => {
    const ll = back([Math.min(x, x1), Math.min(y, y1)]);
    return ll ? classify(ll[0], ll[1]) : levels ? Number.NaN : -1;
  };
  const classes = new Int32Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) classes[j * cols + i] = classOfCell(at, x0 + i * cell, y0 + j * cell, cell, levels);
  return { x0, y0, cell, cols, rows, box: frame.box, classes };
}

/**
 * A grid of classes over the whole Earth in degrees: cells of `cell` degrees from [-180, -90], row 0 the
 * southernmost, each the class `classify(lon, lat)` gives most of its points; with `levels`, the band of the mean of
 * the values `classify` gives. `cell` divides 90.
 */
export function sphereClasses(cell, classify, levels = null) {
  if (!(cell > 0 && Math.abs(90 / cell - Math.round(90 / cell)) < 1e-9)) throw new Error(`seafloor: the cell of a globe's grid is degrees that divide 90 (0.25, 0.5, 1), got ${cell}`);
  const cols = Math.round(360 / cell);
  const rows = Math.round(180 / cell);
  const classes = new Int32Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) classes[j * cols + i] = classOfCell(classify, -180 + i * cell, -90 + j * cell, cell, levels);
  return { x0: -180, y0: -90, cell, cols, rows, box: [-180, -90, 180, 90], classes };
}

/**
 * The outlines of the classes of a grid, along the edges of its cells: by class, rings that keep the class on their
 * left (outer rings counter-clockwise, y up; holes clockwise), as `{ points, hole }`. Cells of class -1 belong to no
 * outline. Where two cells of a class touch only at a corner, the outline turns to keep them apart, so that no ring
 * meets itself.
 */
export function cellOutlines(grid) {
  const { x0, y0, cell, cols, rows, classes, box } = grid;
  const W = cols + 1;
  const cls = (i, j) => (i < 0 || j < 0 || i >= cols || j >= rows ? -1 : classes[j * cols + i]);
  const px = (i) => Math.min(box[2], x0 + i * cell);
  const py = (j) => Math.min(box[3], y0 + j * cell);
  // The directed edges of every class, keyed by their start: a corner of the grid.
  const byClass = new Map();
  const add = (c, a, b, dir) => {
    let e = byClass.get(c);
    if (!e) byClass.set(c, (e = new Map()));
    const list = e.get(a);
    if (list) list.push({ to: b, dir });
    else e.set(a, [{ to: b, dir }]);
  };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const c = classes[j * cols + i];
      if (c < 0) continue;
      // Counter-clockwise round the cell; a side is an edge where the neighbour differs. Directions: 0 east, 1 north, 2 west, 3 south.
      if (cls(i, j - 1) !== c) add(c, j * W + i, j * W + i + 1, 0);
      if (cls(i + 1, j) !== c) add(c, j * W + i + 1, (j + 1) * W + i + 1, 1);
      if (cls(i, j + 1) !== c) add(c, (j + 1) * W + i + 1, (j + 1) * W + i, 2);
      if (cls(i - 1, j) !== c) add(c, (j + 1) * W + i, j * W + i, 3);
    }
  }
  const out = new Map();
  for (const [c, edges] of [...byClass].sort((a, b) => a[0] - b[0])) {
    const rings = [];
    // A ring starts where only one edge of the class leaves a corner, so that it is closed where it began by the
    // rule it follows everywhere else; a corner where two leave is taken as a start only when none other is left.
    const starts = [...edges.keys()].sort((a, b) => a - b);
    for (const start of [...starts.filter((v) => edges.get(v).length === 1), ...starts]) {
      while ((edges.get(start)?.length ?? 0) > 0) {
        const list = edges.get(start);
        let { to, dir } = list.shift();
        const corners = [start];
        let at = to;
        while (at !== start) {
          const next = edges.get(at);
          if (!next || next.length === 0) throw new Error('seafloor: an outline of the grid does not close');
          // The sharpest turn to the left keeps two cells that touch at a corner apart.
          let pick = 0;
          let best = Infinity;
          for (let k = 0; k < next.length; k++) {
            const turn = (next[k].dir - dir + 4) % 4; // 1 left, 0 straight, 3 right
            const rank = turn === 1 ? 0 : turn === 0 ? 1 : turn === 3 ? 2 : 3;
            if (rank < best) [best, pick] = [rank, k];
          }
          const e = next.splice(pick, 1)[0];
          if (e.dir !== dir) corners.push(at);
          dir = e.dir;
          at = e.to;
        }
        // Where the ring passes a corner twice (two cells of the class that touch at a corner, or an outline that
        // touches its hole there), it is parted into simple rings, each counter-clockwise round cells of the class
        // or clockwise round a hole: together they hold what the one ring held.
        for (const loop of simpleLoops(corners)) {
          const points = loop.map((v) => [px(v % W), py(Math.floor(v / W))]);
          if (points.length >= 3) rings.push({ points, hole: signedArea(points) < 0 });
        }
      }
    }
    out.set(c, rings);
  }
  return out;
}

/** A ring of degrees with points put into every edge longer than `step` degrees, evenly in longitude and latitude, rounded to `digits`. */
function densify(ring, step, digits) {
  const k = 10 ** digits;
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const [a, b] = [ring[i], ring[(i + 1) % ring.length]];
    out.push(a);
    const n = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / step);
    for (let m = 1; m < n; m++) out.push([Math.round((a[0] + ((b[0] - a[0]) * m) / n) * k) / k + 0, Math.round((a[1] + ((b[1] - a[1]) * m) / n) * k) / k + 0]);
  }
  return out;
}

/** A closed path of corners parted where it passes a corner twice: simple loops, none of which repeats a corner. */
function simpleLoops(path) {
  const loops = [];
  const stack = [];
  const at = new Map();
  for (const v of path) {
    if (at.has(v)) {
      const k = at.get(v);
      const loop = stack.splice(k + 1);
      for (const u of loop) at.delete(u);
      loops.push([v, ...loop]);
      continue;
    }
    at.set(v, stack.length);
    stack.push(v);
  }
  if (stack.length > 0) loops.push(stack);
  return loops;
}

/**
 * The classes of a grid as areas, thinned together to `tol` (in the units of the grid) and rounded to `digits`: by
 * class, `{ land, gaps }`, its outlines counter-clockwise and the holes in them clockwise, the largest first; an
 * island smaller than `minArea` is left out. `groupOf(class)` gives the key the class is made one outline with (the
 * class itself by default).
 */
export function thinClasses(grid, { tol, minArea = 0, digits = 0, groupOf = (c) => c }) {
  const outlines = cellOutlines(grid);
  const shapes = [...outlines].map(([c, rings]) => ({ rings: rings.map((r) => ({ points: r.points, ...(r.hole ? { hole: true } : {}) })), group: groupOf(c) }));
  if (shapes.length === 0) return new Map();
  const t = thinTogether(shapes, { tol, minArea, digits });
  const byArea = (rings) => rings.filter((r) => r.length >= 3 && area(r) > 0).sort((a, b) => area(b) - area(a) || a[0][0] - b[0][0] || a[0][1] - b[0][1]);
  return new Map((t.groups ?? []).map((g) => [g.key, { land: byArea(g.land), gaps: byArea(g.gaps) }]));
}

/**
 * Areas of a world map by class: for each class `{ rings, holes }` on the plane, every ring counter-clockwise, the
 * largest first: its outlines, and what is not of it inside them. `classes` is the grid (planeClasses), `tol` the
 * thinning in metres.
 */
export function worldAreas(grid, { tol, minArea = 0 }) {
  const thinned = thinClasses(grid, { tol, minArea, digits: 0 });
  // A speck smaller than minArea goes, and so does the hole it fills in the class round it: the two stay one picture.
  const kept = (rings) => rings.filter((r) => area(r) >= minArea).map((r) => orient(r, true));
  return new Map([...thinned].map(([c, { land, gaps }]) => [c, { rings: kept(land), holes: kept(gaps) }]).filter(([, a]) => a.rings.length > 0));
}

/** The quarter of the sphere, a lune of 90 degrees of longitude, that a column of a globe's grid lies in. */
const luneOf = (grid, i) => Math.min(3, Math.floor((i * grid.cell) / 90));

/**
 * Areas of a globe by class: for each class, its polygons in degrees, each `{ areaKm2, rings }`, an outer ring
 * counter-clockwise seen from outside and its holes clockwise, the largest first. The grid is cut into four lunes, so
 * that no polygon is larger than a quarter of the sphere; `tol` is the thinning in degrees, `minArea` the least
 * polygon in km².
 */
export function globeAreas(grid, { tol, minArea = 0, digits = 2, radiusKm = EARTH_KM }) {
  const lunes = { ...grid, classes: grid.classes.map((c, k) => (c < 0 ? -1 : c * 4 + luneOf(grid, k % grid.cols))) };
  // A square degree at the equator: what an island smaller than minArea is in the units of the grid, at most.
  const deg2 = ((Math.PI / 180) * radiusKm) ** 2;
  const thinned = thinClasses(lunes, { tol, minArea: minArea / deg2, digits });
  const out = new Map();
  for (const [key, { land, gaps }] of [...thinned].sort((a, b) => a[0] - b[0])) {
    const c = Math.floor(key / 4);
    const polygons = land.map((ring) => ({ outer: ring, holes: [] }));
    for (const hole of gaps) {
      // A point just inside the hole: beside the middle of its first edge, on its right (it runs clockwise).
      const [a, b] = [hole[0], hole[1]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const probe = [(a[0] + b[0]) / 2 + ((b[1] - a[1]) / len) * 1e-4 * grid.cell, (a[1] + b[1]) / 2 - ((b[0] - a[0]) / len) * 1e-4 * grid.cell];
      let home = null;
      for (const p of polygons) if (pointInRing(probe, p.outer) && (!home || area(p.outer) < area(home.outer))) home = p;
      if (home) home.holes.push(hole);
    }
    const list = out.get(c) ?? [];
    // On the sphere an edge is joined as on a map, as a globe draws it: no edge spans more than a degree.
    // A corner on a pole is moved just off it, along its meridian, as the format of a globe asks.
    const whole = (ring) => {
      const r = wholeRing(ring.map(([lon, lat]) => [lon, Math.max(-89.98, Math.min(89.98, lat))]));
      return r && densify(r, 1, digits);
    };
    for (const p of polygons) {
      const outer = whole(p.outer);
      if (!outer) continue;
      // A hole smaller than minArea goes, as the speck that fills it does.
      const holes = p.holes.map(whole).filter((r) => r !== null && areaKm2(r, radiusKm) >= minArea);
      const rings = [orientOnSphere(outer, true), ...holes.map((r) => orientOnSphere(r, false))];
      const km2 = Math.round(areaKm2(rings[0], radiusKm) - rings.slice(1).reduce((s, r) => s + areaKm2(r, radiusKm), 0));
      if (km2 < minArea || km2 <= 0) continue;
      list.push({ areaKm2: km2, rings });
    }
    out.set(c, list);
  }
  for (const list of out.values()) list.sort((a, b) => b.areaKm2 - a.areaKm2 || a.rings[0][0][0] - b.rings[0][0][0] || a.rings[0][0][1] - b.rings[0][0][1]);
  return out;
}

/** The bands of a grid of values, each band's polygons of a globe (globeAreas), as layers of globe.json: `{ [band id]: [{ id, areaKm2, from, to, rings }] }`. */
export function globeBands(grid, bands, o) {
  const areas = globeAreas(grid, o);
  const layers = {};
  bands.forEach((band, k) => {
    layers[band.id] = (areas.get(k) ?? []).map((p, n) => ({ id: `${band.id}-${n + 1}`, areaKm2: p.areaKm2, from: band.from, to: band.to, rings: p.rings }));
  });
  return layers;
}

/** The default cell of a world map's sea floor, in metres: the longer side of its box cut into 1600, in whole kilometres. */
export function seafloorCell(frame) {
  const [x0, y0, x1, y1] = frame.box;
  return Math.max(1000, Math.round(Math.max(x1 - x0, y1 - y0) / 1600 / 1000) * 1000);
}

/**
 * The age of the ocean floor of a world map in bands: for each band of `levels` (millions of years) that the map
 * holds, `{ id, from, to, rings, holes }` on the plane (worldAreas), the youngest first. `ages` is the grid of degrees.
 */
export function buildWorldAge(ages, frame, { levels, cell, tol, minArea = 0 }) {
  const bands = bandsOf('age', levels);
  const grid = planeClasses(frame, cell, (lon, lat) => nearestAt(ages, lon, lat), levels);
  const areas = worldAreas(grid, { tol, minArea });
  return bands.flatMap((b, k) => (areas.has(k) ? [{ ...b, ...areas.get(k) }] : []));
}

/**
 * The sediments of the sea floor of a world map by group (sedimentGroups): `{ id, codes, names, rings, holes }` on the
 * plane (worldAreas), in the order of the groups; a group the map does not hold is left out. `kinds` is the grid of
 * degrees of the lithology, its codes.
 */
export function buildWorldSediments(kinds, frame, { groups, cell, tol, minArea = 0 }) {
  const byCode = new Map(groups.flatMap((g, k) => g.codes.map((c) => [c, k])));
  const grid = planeClasses(frame, cell, (lon, lat) => byCode.get(nearestAt(kinds, lon, lat)) ?? -1);
  const areas = worldAreas(grid, { tol, minArea });
  return groups.flatMap((g, k) => (areas.has(k) ? [{ ...g, ...areas.get(k) }] : []));
}

/**
 * Bands of a value of the sea floor for a globe (the age of the crust, or the depth of the sea): the layers of
 * globe.json, one a band, `{ [band id]: [{ id, areaKm2, from, to, rings }] }`, the first band first. `value(lon, lat)`
 * is the value at a place (NaN, or below 0, where there is none: land, or crust that is not oceanic).
 */
export function buildGlobeBands(kind, value, { levels, cell, tolerance, minArea = 0, digits = 2, radiusKm = EARTH_KM }) {
  const bands = bandsOf(kind, levels);
  const grid = sphereClasses(cell, value, levels);
  // The cells' stairs are thinned away at two cells; a coarser tolerance of the body is kept where it is coarser.
  return globeBands(grid, bands, { tol: Math.max(tolerance, 2 * cell), minArea, digits, radiusKm });
}
