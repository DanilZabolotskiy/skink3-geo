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

/**
 * The frame of a map: the whole world (no `bbox`) or a box. The world's frame is the plane of Equal Earth round the
 * point 0° 0°, with the edge of the world as `outline`; a box's is the plane of the azimuthal projection round
 * `centre` (the middle of the box by default).
 */
export function worldFrame({ bbox = null, centre = null } = {}) {
  if (!bbox) {
    const proj = equalEarth();
    const edge = [];
    for (let lat = -90; lat <= 90; lat++) edge.push([-180, lat]);
    for (let lat = 90; lat >= -90; lat--) edge.push([180, lat]);
    const outline = edge.map(proj.forward);
    return { proj, frame: { projection: 'equal-earth', centre: [0, 0], box: roundBox(boxOf(outline)), lonlat: [-180, -90, 180, 90] }, outline };
  }
  const [w, s, e, n] = bbox;
  if (!(w < e && s < n && w >= -180 && e <= 180 && s >= -90 && n <= 90)) throw new Error(`world: the box is [west, south, east, north] in degrees, west below east and south below north, got ${JSON.stringify(bbox)}`);
  const c = centre ?? [Math.round(((w + e) / 2) * 1e6) / 1e6, Math.round(((s + n) / 2) * 1e6) / 1e6];
  const proj = projection({ lon: c[0], lat: c[1] });
  return { proj, frame: { projection: 'laea', centre: c, box: roundBox(projectBox(proj, bbox)), lonlat: [...bbox] }, outline: null };
}

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
  const [x0, y0, x1, y1] = frame.box;
  const detail = made.detail ?? Math.max(1, Math.round(Math.min((x1 - x0) / 1920, (y1 - y0) / 1080) / 2));
  const minArea = (made.minArea ?? Math.round((detail * 6) ** 2 / 1e3) / 1e3) * 1e6;
  const used = { scale: made.scale, detail, minArea: minArea / 1e6, lakes: made.lakes ?? null, ...(made.bbox ? { bbox: frame.lonlat, centre: frame.centre } : {}) };
  // A box takes the countries whose rings come near it; the rest of the world plays no part in its borders.
  const near = made.bbox ? [frame.lonlat[0] - 3, frame.lonlat[1] - 3, frame.lonlat[2] + 3, frame.lonlat[3] + 3] : null;
  const picked = [];
  for (const f of countries.features ?? []) {
    const p = f.properties ?? {};
    const rings = [];
    for (const poly of polygonsOf(f.geometry)) {
      if (near && !boxesMeet(boxOf(poly[0]), near)) continue;
      poly.forEach((ring, k) => rings.push({ points: densify(ring, 1).map(proj.forward), hole: k > 0 }));
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
        if (near && !boxesMeet(boxOf(poly[0]), frame.lonlat)) continue;
        for (const piece of near ? clipRing(poly[0].map(proj.forward), box) : [poly[0].map(proj.forward)]) {
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
