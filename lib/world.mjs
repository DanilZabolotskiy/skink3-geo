// A map of the world with the outline of every country, flat: the whole world on the Equal Earth projection, or the
// countries of a box on a plane centred on it (Lambert's azimuthal equal-area, as a region of a city). The countries
// come from Natural Earth's admin-0 countries, thinned together (lib/topology.mjs), so two neighbours keep one border:
// the land is their outlines as one, and each land border is a line between the two countries it parts. Both
// projections keep areas true, so a country's area on the map is its area on the Earth (thinning aside).

import { area, boxesMeet, boxOf, clipLine, clipRing, dedupe, orient, simplifySafe } from './geom.mjs';
import { equalEarth, projectBox, projection } from './project.mjs';
import { densify, thinTogether } from './topology.mjs';

/** The Natural Earth files a world build reads, by its scale (10, 50 or 110). */
export function worldSources(scale, lakes = false) {
  if (![10, 50, 110].includes(scale)) throw new Error(`world: the scale is 10, 50 or 110 (Natural Earth's 1:10m, 1:50m or 1:110m), got ${scale}`);
  return { countries: `ne_${scale}m_admin_0_countries`, ...(lakes ? { lakes: `ne_${scale}m_lakes` } : {}) };
}

/** The polygons of a GeoJSON geometry, each its rings without the repeated last point: the outer ring, then its holes. */
function polygonsOf(geometry) {
  if (!geometry) return [];
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polys.map((p) => p.map((r) => r.slice(0, -1)).filter((r) => r.length >= 3)).filter((p) => p.length > 0);
}

const roundBox = ([x0, y0, x1, y1]) => [Math.floor(x0), Math.floor(y0), Math.ceil(x1), Math.ceil(y1)];
const km2 = (rings) => Math.round(rings.reduce((sum, r) => sum + area(r), 0) / 1e6);
const slugOf = (text) => String(text).toLowerCase();
const at = (proj, lonlat) => proj.forward(lonlat).map((v) => Math.round(v) + 0);

/** The ISO 3166 code of a country of Natural Earth, where it has one of its own. */
function isoOf(p) {
  if (p.ISO_A3 && p.ISO_A3 !== '-99') return p.ISO_A3;
  if (p.ISO_A3_EH && p.ISO_A3_EH === p.ADM0_A3) return p.ISO_A3_EH;
  return undefined;
}

const ninth = (v) => Math.round(v * 1e9) / 1e9 + 0;
const STRIP = (k) => [-180 + 360 * k, -91, 180 + 360 * k, 91];

/**
 * How a frame takes lines and rings given in [lon, lat]: `lines(line)` and `rings(ring)` give the pieces to project,
 * `forward` projects them. Round the 0th meridian, and in a box that does not cross the 180th meridian, a ring is
 * taken as it is. Round another meridian, the world is cut along the meridian opposite it: each ring and line is cut
 * into the strip of longitudes each side of the centre, the piece beyond the edge carried round to the other side,
 * and the longitudes are taken relative to the centre, so the pieces that Natural Earth parts at the 180th meridian
 * meet again inside the map, point for point. A box across the 180th meridian carries the rings of the west round to
 * the east, so the pieces parted there meet again too. A line's longitudes are first made to run on without a jump
 * (from 179 on to 181, not to -179), so a line drawn across the 180th meridian is one line.
 */
export function frameCut(frame) {
  const unwrap = (line) => {
    const out = [[line[0][0], line[0][1]]];
    for (let i = 1; i < line.length; i++) {
      let d = line[i][0] - line[i - 1][0];
      if (d > 180) d -= 360;
      else if (d < -180) d += 360;
      out.push([out[i - 1][0] + d, line[i][1]]);
    }
    return out;
  };
  if (frame.projection === 'equal-earth') {
    const lon0 = frame.centre[0];
    const plane = equalEarth();
    // The strips a set of longitudes (relative to the centre) reaches, each with the shift that brings it home.
    const strips = (points) => {
      let [a, b] = [Infinity, -Infinity];
      for (const [x] of points) [a, b] = [Math.min(a, x), Math.max(b, x)];
      const out = [];
      for (let k = Math.floor((a + 180) / 360); k <= Math.floor((b + 180) / 360); k++) out.push(k);
      if (out.length === 0) out.push(0);
      return out;
    };
    const home = (pieces, k) => pieces.map((piece) => piece.map(([x, y]) => [ninth(x - 360 * k), y]));
    if (lon0 === 0) {
      return {
        forward: plane.forward,
        rings: (ring) => [ring],
        lines: (line) => {
          const run = unwrap(line);
          return strips(run).flatMap((k) => home(clipLine(run, STRIP(k)), k));
        },
      };
    }
    const rel = (points) => points.map(([x, y]) => [x - lon0, y]);
    const across = 180 - lon0;
    return {
      forward: plane.forward,
      seam: ninth(across > 180 ? across - 360 : across),
      rings: (ring) => {
        const r = rel(ring);
        return strips(r).flatMap((k) => home(clipRing(r, STRIP(k)), k)).map((piece) => dedupe(piece, 0, true)).filter((piece) => piece.length >= 3 && area(piece) > 0);
      },
      lines: (line) => {
        const run = rel(unwrap(line));
        return strips(run).flatMap((k) => home(clipLine(run, STRIP(k)), k)).filter((piece) => piece.length >= 2);
      },
    };
  }
  const [w, , e] = frame.lonlat;
  const proj = projection({ lon: frame.centre[0], lat: frame.centre[1] });
  if (w < e) return { forward: proj.forward, rings: (ring) => [ring], lines: (line) => [unwrap(line)] };
  // Across the 180th meridian: a ring of the west half of the world is carried round by 360°, which the projection
  // does not see, so its points on the meridian are those of its neighbour on the other side.
  return {
    forward: proj.forward,
    seam: 180,
    rings: (ring) => {
      let [a, b] = [Infinity, -Infinity];
      for (const [x] of ring) [a, b] = [Math.min(a, x), Math.max(b, x)];
      return [(a + b) / 2 < 0 ? ring.map(([x, y]) => [x + 360, y]) : ring];
    },
    lines: (line) => [unwrap(line)],
  };
}

/**
 * The rings of one country made whole across a seam, the meridian at longitude `seam`: Natural Earth parts a land
 * that the 180th meridian runs through into two pieces, one each side, whose edges along the meridian need not share
 * their points. Each ring is cut open where it runs along the seam, and the open pieces are joined end to start where
 * they meet on it (within `tol` degrees of latitude), the nearest first; a piece with no partner closes on itself as
 * it was. Rings that do not run along the seam come back as they are.
 */
export function stitchSeam(rings, seam, tol = 1) {
  // Natural Earth puts some of its points on the meridian a hair off it (179.9922 at 1:10m, -179.99995 at 1:50m).
  const on = (p) => Math.abs(p[0] - seam) < 0.01;
  const keep = [];
  const chains = [];
  for (const ring of rings) {
    const n = ring.length;
    // The stretches of two points or more along the seam: where the ring is opened.
    const along = ring.map((p, i) => on(p) && on(ring[(i + 1) % n]));
    if (!along.some(Boolean) || along.every(Boolean)) {
      keep.push(ring);
      continue;
    }
    const first = along.findIndex((v, i) => !v && along[(i + n - 1) % n]);
    let open = null;
    for (let s = 0; s < n; s++) {
      const i = (first + s) % n;
      if (along[i]) {
        if (open) {
          open.push(ring[i]);
          chains.push(open);
          open = null;
        }
        continue;
      }
      if (!open) open = [ring[i]];
      else open.push(ring[i]);
      if (s === n - 1 && open) {
        open.push(ring[(i + 1) % n]);
        chains.push(open);
      }
    }
  }
  if (chains.length === 0) return rings;
  // Each end meets the nearest start along the seam, the nearest pairs first.
  const pairs = [];
  chains.forEach((c, i) => chains.forEach((d, j) => pairs.push({ i, j, gap: Math.abs(c[c.length - 1][1] - d[0][1]) })));
  pairs.sort((p, q) => p.gap - q.gap || p.i - q.i || p.j - q.j);
  const next = new Array(chains.length).fill(-1);
  const taken = new Set();
  for (const { i, j, gap } of pairs) {
    if (next[i] >= 0 || taken.has(j) || (gap > tol && i !== j)) continue;
    next[i] = j;
    taken.add(j);
  }
  const used = new Set();
  const out = [...keep];
  for (let c = 0; c < chains.length; c++) {
    if (used.has(c)) continue;
    const ring = [];
    for (let k = c; k >= 0 && !used.has(k); k = next[k]) {
      used.add(k);
      ring.push(...chains[k]);
    }
    const clean = dedupe(ring, 0, true);
    if (clean.length >= 3 && area(clean) > 0) out.push(clean);
  }
  return out;
}

/** Whether a lon/lat box [a0, b0, a1, b1] meets the frame's degrees grown by `margin` (a box across 180° on either side). */
export function nearFrame(frame, margin) {
  const [w, s, e, n] = frame.lonlat;
  if (frame.projection === 'equal-earth') return () => true;
  const boxes = w < e ? [[w - margin, s - margin, e + margin, n + margin]] : [[w - margin, s - margin, 180 + margin, n + margin], [-180 - margin, s - margin, e + margin, n + margin]];
  return (box) => boxes.some((b) => boxesMeet(box, b));
}

/**
 * The frame of a map: the whole world (no `bbox`) or a box. The world's frame is the plane of Equal Earth round the
 * point 0° 0°, or round the meridian `centre` gives ([lon, 0]: the edge of the map is then the meridian opposite it),
 * with the edge of the world as `outline`; a box's is the plane of the azimuthal projection round `centre` (the
 * middle of the box by default). A box whose west is east of its east ([170, -20, -170, 10]) crosses the 180th
 * meridian.
 */
export function worldFrame({ bbox = null, centre = null } = {}) {
  if (!bbox) {
    if (centre !== null && !(Array.isArray(centre) && centre.length === 2 && Number.isFinite(centre[0]) && Math.abs(centre[0]) <= 180 && centre[1] === 0)) {
      throw new Error(`world: the whole world is centred on a meridian, [lon, 0] with lon from -180 to 180, got ${JSON.stringify(centre)}`);
    }
    const lon0 = centre ? centre[0] + 0 : 0;
    const proj = equalEarth(lon0);
    const plane = equalEarth();
    const edge = [];
    for (let lat = -90; lat <= 90; lat++) edge.push([-180, lat]);
    for (let lat = 90; lat >= -90; lat--) edge.push([180, lat]);
    const outline = edge.map(plane.forward);
    return { proj, frame: { projection: 'equal-earth', centre: [lon0, 0], box: roundBox(boxOf(outline)), lonlat: [-180, -90, 180, 90] }, outline };
  }
  const [w, s, e, n] = bbox;
  const ok = Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite) && w !== e && s < n && w >= -180 && w <= 180 && e >= -180 && e <= 180 && s >= -90 && n <= 90;
  if (!ok) throw new Error(`world: the box is [west, south, east, north] in degrees, west and east from -180 to 180 and apart (a west east of the east crosses the 180th meridian), south below north, got ${JSON.stringify(bbox)}`);
  const east = w < e ? e : e + 360;
  if (w > e && east - w > 180) throw new Error(`world: a box across the 180th meridian (its west east of its east) spans 180° of longitude at most, and ${JSON.stringify(bbox)} spans ${east - w}°: is it west and east the wrong way round?`);
  let c = centre;
  if (!c) {
    const mid = (w + east) / 2;
    c = [Math.round((mid > 180 ? mid - 360 : mid) * 1e6) / 1e6, Math.round(((s + n) / 2) * 1e6) / 1e6];
  }
  const proj = projection({ lon: c[0], lat: c[1] });
  return { proj, frame: { projection: 'laea', centre: c, box: roundBox(projectBox(proj, [w, s, east, n])), lonlat: [...bbox] }, outline: null };
}

/** The options of worldFrame that give back a frame it made. */
export const frameOptions = (frame) => (frame.projection === 'laea' ? { bbox: frame.lonlat, centre: frame.centre } : frame.centre[0] === 0 ? {} : { centre: frame.centre });

/**
 * A world map from Natural Earth's collections, parsed: `countries` (admin-0 countries) and `lakes` (when given).
 * `made`: { scale, detail?, minArea?, lakes?, bbox?, centre? }:
 *   detail   the thinning in metres; by default half a unit of a stage of 1920 by 1080 that the frame's box covers
 *   minArea  an island smaller than this, in km², is left out (a country keeps its largest piece however small); by
 *            default that of a square six times `detail` on a side
 *   lakes    the largest rank of lake kept (Natural Earth's scalerank, 0 the largest); null: no lakes
 *   bbox     [west, south, east, north] in degrees: the countries of this box alone, cut to it; null: the world
 * Returns { frame, made, land, gaps, countries, boundaries, lakes, stats } in metres on the frame's plane, rounded
 * to whole metres; `made` holds the options as used, so the same downloads and `made` give the same map.
 */
export function buildWorld({ countries, lakes = null }, made) {
  const { proj, frame, outline } = worldFrame(made);
  const cut = frameCut(frame);
  // Whether the map has a seam of Natural Earth's inside it: the 180th meridian, away from the map's edge.
  const seam = frame.projection === 'equal-earth' ? frame.centre[0] !== 0 : frame.lonlat[0] > frame.lonlat[2];
  const [x0, y0, x1, y1] = frame.box;
  const detail = made.detail ?? Math.max(1, Math.round(Math.min((x1 - x0) / 1920, (y1 - y0) / 1080) / 2));
  const minArea = (made.minArea ?? Math.round((detail * 6) ** 2 / 1e3) / 1e3) * 1e6;
  const used = { scale: made.scale, detail, minArea: minArea / 1e6, lakes: made.lakes ?? null, ...(made.bbox || seam ? { ...(made.bbox ? { bbox: frame.lonlat } : {}), centre: frame.centre } : {}) };
  // A box takes the countries whose rings come near it; the rest of the world plays no part in its borders.
  const near = made.bbox ? nearFrame(frame, 3) : null;
  const picked = [];
  const [outers, holes] = [[], []];
  for (const f of countries.features ?? []) {
    const p = f.properties ?? {};
    const rings = [];
    for (const poly of polygonsOf(f.geometry)) {
      if (near && !near(boxOf(poly[0]))) continue;
      if (!seam) poly.forEach((ring, k) => rings.push({ points: densify(ring, 1).map(proj.forward), hole: k > 0 }));
      else poly.forEach((ring, k) => cut.rings(ring).forEach((piece) => (k > 0 ? holes : outers).push(piece)));
    }
    // The pieces Natural Earth parts at the 180th meridian, made whole again where the map has it inside.
    if (seam) {
      for (const ring of stitchSeam(outers, cut.seam)) rings.push({ points: densify(ring, 1).map(cut.forward), hole: false });
      for (const ring of holes) rings.push({ points: densify(ring, 1).map(cut.forward), hole: true });
      outers.length = 0;
      holes.length = 0;
    }
    if (rings.length > 0 && p.ADM0_A3) picked.push({ p, rings });
  }
  const thin = thinTogether(picked, { tol: detail, minArea, digits: 0 });
  const box = frame.box;
  // A world is drawn whole; a box keeps what lies in it, cut along its edge.
  const cutRings = (rings) =>
    near
      ? rings.flatMap((r) => clipRing(r, box).map((piece) => dedupe(piece.map(([x, y]) => [Math.round(x) + 0, Math.round(y) + 0]), 0, true))).filter((r) => r.length >= 3 && area(r) > 0)
      : rings;
  const cutLines = (lines) =>
    near ? lines.flatMap((l) => clipLine(l, box).map((piece) => dedupe(piece.map(([x, y]) => [Math.round(x) + 0, Math.round(y) + 0]), 0))).filter((l) => l.length >= 2) : lines;

  const list = picked
    .map(({ p }, k) => {
      const rings = cutRings(thin.shapes[k].rings).sort((a, b) => area(b) - area(a));
      const iso = isoOf(p);
      return { id: slugOf(p.ADM0_A3), name: String(p.NAME ?? p.ADMIN ?? p.ADM0_A3), ...(iso ? { iso } : {}), continent: String(p.CONTINENT ?? ''), label: at(proj, [Number(p.LABEL_X), Number(p.LABEL_Y)]), areaKm2: km2(rings), rings, k };
    })
    .filter((c) => c.rings.length > 0 && Number.isFinite(c.label[0]) && Number.isFinite(c.label[1]));
  // The largest first: painted in this order, an enclave comes after the country round it.
  list.sort((a, b) => b.areaKm2 - a.areaKm2 || (a.id < b.id ? -1 : 1));
  const idOf = new Map(list.map((c) => [c.k, c.id]));
  const boundaries = thin.borders
    .filter((b) => idOf.has(b.a) && idOf.has(b.b))
    .map((b) => {
      const [p, q] = [idOf.get(b.a), idOf.get(b.b)].sort();
      return { id: `${p}-${q}`, between: [p, q], lines: cutLines(b.lines) };
    })
    .filter((b) => b.lines.length > 0)
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  const lakeList = [];
  if (made.lakes != null && lakes) {
    for (const f of lakes.features ?? []) {
      const p = f.properties ?? {};
      if (!(Number(p.scalerank) <= made.lakes)) continue;
      for (const poly of polygonsOf(f.geometry)) {
        if (near && !nearFrame(frame, 0)(boxOf(poly[0]))) continue;
        const flat = seam ? cut.rings(poly[0]).map((r) => r.map(cut.forward)) : [poly[0].map(proj.forward)];
        for (const piece of near ? flat.flatMap((r) => clipRing(r, box)) : flat) {
          const cut = simplifySafe(dedupe(piece, 1e-6, true), detail, true);
          if (!cut) continue;
          const ring = orient(dedupe(cut.map(([x, y]) => [Math.round(x) + 0, Math.round(y) + 0]), 0, true), true);
          if (ring.length >= 3 && area(ring) >= minArea) lakeList.push({ name: String(p.name || p.name_en || ''), ring });
        }
      }
    }
    lakeList.sort((a, b) => area(b.ring) - area(a.ring) || a.ring[0][0] - b.ring[0][0]);
  }

  return {
    made: used,
    frame: outline ? { ...frame, outline: dedupe(simplifySafe(orient(outline, true), detail, true).map(([x, y]) => [Math.round(x) + 0, Math.round(y) + 0]), 0, true) } : frame,
    land: cutRings(thin.land).sort((a, b) => area(b) - area(a)).map((ring, k) => ({ id: `land-${k}`, ring })),
    gaps: cutRings(thin.gaps.map((r) => orient(r, true))).filter((r) => area(r) >= minArea).sort((a, b) => area(b) - area(a)).map((ring, k) => ({ id: `gap-${k}`, ring })),
    countries: list.map(({ k: _k, ...c }) => c),
    boundaries,
    lakes: lakeList.map((l, k) => ({ id: `lake-${k}`, ...l })),
    stats: thin.stats,
  };
}
