// A round body as layers for a globe: the polygons of its surface (the land, lakes and ice of the Earth
// from the public-domain Natural Earth; the dark seas of the Moon from the public-domain mare boundaries
// of the Lunar Reconnaissance Orbiter Camera), and the Earth's towns, in degrees of longitude and
// latitude. A globe turns, so nothing here is projected: a scene's renderer places every point on its
// own sphere.
//
// A ring is written without its first point repeated at the end. Seen from outside the body, an outer
// ring runs counter-clockwise round what it holds and a hole clockwise; on a map with north up, what it
// holds lies to the left of the line. The outlines are simplified on the sphere itself, so that a ring by
// a pole is thinned as much as one by the equator, and the cuts a flat map makes (the edge along the
// south pole and the slit down the 180th meridian round Antarctica) are taken out: on a sphere they are
// no coast.

import { crosses, simplify } from './geom.mjs';

const DEG = Math.PI / 180;
/** The mean radius of the Earth, in kilometres. */
export const EARTH_KM = 6371.0088;

/** The bodies a globe is built for: their names and mean radii (km), the Moon's that of its reference sphere (IAU). */
export const BODIES = Object.freeze({
  earth: Object.freeze({ name: 'The Earth', radiusKm: EARTH_KM }),
  moon: Object.freeze({ name: 'The Moon', radiusKm: 1737.4 }),
});

/** A point [lon, lat] in degrees as a unit vector: x toward lon 0 on the equator, y toward lon 90 east, z toward the north pole. */
export function unit([lon, lat]) {
  const c = Math.cos(lat * DEG);
  return [c * Math.cos(lon * DEG), c * Math.sin(lon * DEG), Math.sin(lat * DEG)];
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

/** True when two points [lon, lat] are one place on the sphere (180 and -180 are one meridian; a pole has every longitude). */
export function samePlace(a, b) {
  const u = unit(a);
  const v = unit(b);
  return Math.abs(u[0] - v[0]) + Math.abs(u[1] - v[1]) + Math.abs(u[2] - v[2]) < 1e-9;
}

/** The middle of a ring on the sphere: the unit vector of the mean of its points. */
function middle(ring) {
  const s = [0, 0, 0];
  for (const p of ring) {
    const v = unit(p);
    s[0] += v[0];
    s[1] += v[1];
    s[2] += v[2];
  }
  return norm(s);
}

/**
 * The area of a ring on the unit sphere, in steradians, with its sign: positive when it runs
 * counter-clockwise seen from outside, round its middle. Each edge makes a triangle with the middle
 * (the formula of Van Oosterom and Strackee), so a ring round a pole is measured as well as any.
 */
export function sphericalArea(ring) {
  const c = middle(ring);
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = unit(ring[i]);
    const b = unit(ring[(i + 1) % ring.length]);
    sum += 2 * Math.atan2(dot(c, cross(a, b)), 1 + dot(c, a) + dot(a, b) + dot(b, c));
  }
  return sum;
}

/** The area of a ring in square kilometres of a sphere of that radius (the Earth's by default). */
export const areaKm2 = (ring, radiusKm = EARTH_KM) => Math.abs(sphericalArea(ring)) * radiusKm * radiusKm;

/** The ring running counter-clockwise seen from outside (or clockwise, `ccw: false`). */
export function orientOnSphere(ring, ccw = true) {
  return sphericalArea(ring) >= 0 === ccw ? ring : [...ring].reverse();
}

/**
 * A ring of a flat map made whole on the sphere: its closing point, its points on a pole, the
 * repeats of one place, and the points where it turns straight back along itself (the slit of
 * Antarctica down the 180th meridian, which goes out and comes back the same way) are taken out. Returns null when fewer than three points are left.
 */
export function wholeRing(ring) {
  let pts = ring.filter((p) => Math.abs(p[1]) < 89.99);
  let changed = true;
  while (changed && pts.length >= 3) {
    changed = false;
    const out = [];
    for (const p of pts) if (out.length === 0 || !samePlace(out[out.length - 1], p)) out.push(p);
    while (out.length > 1 && samePlace(out[0], out[out.length - 1])) out.pop();
    if (out.length !== pts.length) changed = true;
    pts = out;
    // A spike: a, b, a. Both b and the second a go.
    for (let i = 0; i < pts.length && pts.length >= 3; i++) {
      const n = pts.length;
      if (samePlace(pts[(i + n - 1) % n], pts[(i + 1) % n])) {
        const drop = new Set([i, (i + 1) % n]);
        pts = pts.filter((_, k) => !drop.has(k));
        changed = true;
        break;
      }
    }
    // A point where the line turns straight back along itself (down a meridian to a cut and up again): it goes.
    for (let i = 0; i < pts.length && pts.length >= 3; i++) {
      const n = pts.length;
      // a, b, c on one great circle, and the ways from b to a and from b to c the same way along it.
      const a = unit(pts[(i + n - 1) % n]);
      const b = unit(pts[i]);
      const c = unit(pts[(i + 1) % n]);
      const ta = sub(a, scale(b, dot(a, b)));
      const tc = sub(c, scale(b, dot(c, b)));
      if (Math.abs(dot(cross(a, c), b)) < 1e-12 && dot(ta, tc) > 0) {
        pts = pts.filter((_, k) => k !== i);
        changed = true;
        break;
      }
    }
  }
  return pts.length >= 3 ? pts : null;
}

/**
 * A ring thinned to `tol` degrees of arc. It is laid on the plane of an azimuthal equidistant projection round
 * its middle, where a degree is a degree in every direction near the ring, and thinned there by Douglas–Peucker;
 * the points kept are the ring's own. Where the thinned ring would cross itself the tolerance is halved, twice at
 * the most: a ring that still crosses itself then (a coast that nearly touches itself across a narrow neck, or one
 * that crossed itself before) is thinned at `tol` all the same, for its crossings are no wider than `tol` and a
 * fill at the scale `tol` is chosen for does not show them. Null when fewer than three points would be left.
 */
export function simplifyOnSphere(ring, tol) {
  const c = middle(ring);
  const e1 = norm(Math.abs(c[2]) < 0.9 ? cross([0, 0, 1], c) : cross([1, 0, 0], c));
  const e2 = cross(c, e1);
  const plane = ring.map((p, k) => {
    const v = unit(p);
    const along = Math.acos(Math.max(-1, Math.min(1, dot(v, c)))) / DEG;
    const x = dot(v, e1);
    const y = dot(v, e2);
    const r = Math.hypot(x, y);
    return r > 0 ? [(along * x) / r, (along * y) / r, k] : [0, 0, k];
  });
  let kept = null;
  for (let t = tol; t >= tol / 4 && !kept; t /= 2) {
    const out = simplify(plane, t, true);
    if (!crosses(out, true)) kept = out;
  }
  kept ??= simplify(plane, tol, true);
  return kept.length >= 3 ? kept.map((q) => ring[q[2]]) : null;
}

const round = (v, digits) => {
  const r = Math.round(v * 10 ** digits) / 10 ** digits;
  return r === 0 ? 0 : r;
};

/** The polygons of a GeoJSON feature collection, each a list of rings (outer first), with the feature's properties. */
export function polygonsOf(fc) {
  const out = [];
  for (const f of fc.features ?? []) {
    const g = f.geometry;
    if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const p of polys) out.push({ rings: p, properties: f.properties ?? {} });
  }
  return out;
}

/**
 * Polygons made whole, thinned and rounded: those smaller than `minArea` km² go, and so do holes
 * smaller than it. Outer rings counter-clockwise, holes clockwise, the largest polygon first.
 */
export function globePolygons(fc, { tolerance, minArea, digits = 2, name = null, radiusKm = EARTH_KM }) {
  const out = [];
  for (const p of polygonsOf(fc)) {
    const rings = [];
    for (const [k, raw] of p.rings.entries()) {
      const whole = wholeRing(raw);
      if (!whole || areaKm2(whole, radiusKm) < minArea) {
        if (k === 0) break;
        continue;
      }
      const thin = simplifyOnSphere(whole, tolerance) ?? whole;
      const rounded = wholeRing(thin.map(([lon, lat]) => [round(lon, digits), round(lat, digits)]));
      if (!rounded) {
        if (k === 0) break;
        continue;
      }
      rings.push(orientOnSphere(rounded, k === 0));
    }
    if (rings.length === 0) continue;
    out.push({ areaKm2: Math.round(areaKm2(rings[0], radiusKm)), ...(name ? { name: name(p.properties) } : {}), rings });
  }
  out.sort((a, b) => b.areaKm2 - a.areaKm2 || a.rings[0][0][0] - b.rings[0][0][0] || a.rings[0][0][1] - b.rings[0][0][1]);
  return out;
}

/** What a globe is built with, by body, unless the caller says otherwise. */
export const GLOBE_DEFAULTS = Object.freeze({
  earth: Object.freeze({ scale: 50, tolerance: 0.08, minArea: 300, lakeArea: 4000, iceArea: 300, minPop: 200000, digits: 2 }),
  moon: Object.freeze({ tolerance: 0.15, minArea: 300, digits: 2 }),
});

const ids = (prefix, list) => list.map((p, k) => ({ id: `${prefix}-${k}`, ...p }));

/**
 * The Earth's layers from the Natural Earth collections given (each a parsed GeoJSON feature collection):
 * `land`, `lakes`, `ice` (a list: the glaciated areas, the ice shelves) and `places`. The same collections
 * and options give the same layers: `{ layers: { land, lakes?, ice? }, places? }`.
 */
export function buildEarth({ land, lakes = null, ice = [], places = null }, options = {}) {
  const o = { ...GLOBE_DEFAULTS.earth, ...options };
  const layers = { land: ids('land', globePolygons(land, { tolerance: o.tolerance, minArea: o.minArea, digits: o.digits })) };
  if (lakes) layers.lakes = ids('lake', globePolygons(lakes, { tolerance: o.tolerance, minArea: o.lakeArea, digits: o.digits, name: (q) => String(q.name ?? '') }));
  if (ice.length > 0) {
    const all = ice.flatMap((fc) => globePolygons(fc, { tolerance: o.tolerance, minArea: o.iceArea, digits: o.digits }));
    all.sort((a, b) => b.areaKm2 - a.areaKm2 || a.rings[0][0][0] - b.rings[0][0][0]);
    layers.ice = ids('ice', all);
  }
  const out = { layers };
  if (places) {
    out.places = (places.features ?? [])
      .map((f) => ({ p: f.properties ?? {}, g: f.geometry }))
      .filter(({ p, g }) => g && g.type === 'Point' && Number.isFinite(p.pop_max) && p.pop_max >= o.minPop)
      .map(({ p, g }) => ({ name: String(p.name ?? ''), at: [round(g.coordinates[0], o.digits), round(g.coordinates[1], o.digits)], pop: Math.round(p.pop_max) }))
      .sort((a, b) => b.pop - a.pop || a.name.localeCompare(b.name, 'en') || a.at[0] - b.at[0]);
  }
  return out;
}

/**
 * The Moon's layers from the mare boundaries given (a feature collection with a `MARE_NAME` field, as the
 * shapefile of the Lunar Reconnaissance Orbiter Camera has it): `{ layers: { maria } }`, the dark seas of
 * basalt, the largest first. The highlands are the rest of the sphere.
 */
export function buildMoon({ maria }, options = {}) {
  const o = { ...GLOBE_DEFAULTS.moon, ...options };
  const name = (q) => String(q.MARE_NAME ?? q.name ?? '');
  return { layers: { maria: ids('mare', globePolygons(maria, { tolerance: o.tolerance, minArea: o.minArea, digits: o.digits, name, radiusKm: BODIES.moon.radiusKm })) } };
}

/** The names of the Natural Earth files an Earth build reads at that scale. */
export function earthSources(scale) {
  if (scale !== 110 && scale !== 50) throw new Error(`globe: the scale is 110 or 50, got ${scale}`);
  return {
    land: `ne_${scale}m_land`,
    lakes: `ne_${scale}m_lakes`,
    ice: [`ne_${scale}m_glaciated_areas`, 'ne_50m_antarctic_ice_shelves_polys'],
    places: 'ne_10m_populated_places_simple',
  };
}

/** The mare boundaries of the Lunar Reconnaissance Orbiter Camera, as NASA's Planetary Data System holds them. */
export const MOON_MARIA = Object.freeze({
  id: 'lroc-global-mare-180',
  url: 'https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/EXTRAS/SHAPEFILE/LROC_GLOBAL_MARE/LROC_GLOBAL_MARE_180.ZIP',
  request: 'LROC RDR LROLRC_2001 EXTRAS/SHAPEFILE/LROC_GLOBAL_MARE/LROC_GLOBAL_MARE_180.ZIP',
  dataDate: '2014',
});
