// Thematic layers of a world map beyond its countries: Natural Earth's rivers, by name or by rank; its populated
// places as towns, by their people; and the water risk of WRI's Aqueduct, by category. Each is in metres on the plane
// of the map's frame and cut to a box's edge, as the countries are.

import { area, boxOf, clipRing, dedupe, orient } from './geom.mjs';
import { readGdbCatalog, readGdbFields, readGdbTable } from './gdb.mjs';
import { joinLines } from './osm.mjs';
import { equalEarth, projection } from './project.mjs';
import { thinTogether } from './topology.mjs';
import { featureRings, nearFrame } from './world.mjs';
import { linesInFrame } from './worldlines.mjs';
import { unzip, zipEntries } from './zip.mjs';

const whole = (points) => points.map(([x, y]) => [Math.round(x) + 0, Math.round(y) + 0]);
const plainSlug = (text) => String(text).normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The lines of a GeoJSON geometry, each its points. */
function linesOf(geometry) {
  const parts = geometry?.type === 'LineString' ? [geometry.coordinates] : geometry?.type === 'MultiLineString' ? geometry.coordinates : [];
  return parts.map((coords) => dedupe(coords.filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])).map((c) => [c[0], c[1]]), 0)).filter((l) => l.length >= 2);
}

/**
 * What `--rivers` asks for: a number is Natural Earth's scalerank, the rivers of that rank and below (0 the largest);
 * anything else a name, as Natural Earth writes it or in English. Both may be given: `3,Ebro`.
 */
export function riverPicks(text) {
  const items = String(text).split(',').map((v) => v.trim()).filter((v) => v !== '');
  if (items.length === 0) throw new Error('world: --rivers takes a rank (0 to 12) or names of rivers, separated by commas');
  const ranks = items.filter((v) => /^\d+$/.test(v)).map(Number);
  if (ranks.length > 1) throw new Error(`world: --rivers takes one rank, got ${ranks.join(' and ')}`);
  if (ranks.length === 1 && ranks[0] > 12) throw new Error(`world: the rank of --rivers is Natural Earth's scalerank, 0 to 12, got ${ranks[0]}`);
  return { rank: ranks.length === 1 ? ranks[0] : null, names: items.filter((v) => !/^\d+$/.test(v)) };
}

/**
 * The rivers of Natural Earth's centerlines of rivers and lakes (`ne_<scale>m_rivers_lake_centerlines`) that a map
 * asks for: those of scalerank `rank` and below, and those named in `names`, as Natural Earth writes them or in
 * English. The pieces of one river (one name) are joined end to end where they meet, cut to the map and thinned to
 * `detail` metres; a river that runs through a lake runs on through it, as a line to be painted under the lake.
 * Each is { id, name, rank, lines }, the largest rank first (0 the largest), then by name. A name the map does not
 * hold is refused.
 */
export function buildRivers(collection, frame, { detail, rank = null, names = [] }) {
  const want = new Set(names);
  const found = new Set();
  const near = frame.projection === 'laea' ? nearFrame(frame, 1) : null;
  const byName = new Map();
  for (const f of collection.features ?? []) {
    const p = f.properties ?? {};
    const name = String(p.name ?? '').trim();
    if (!name) continue;
    const en = String(p.name_en ?? '').trim();
    const named = want.has(name) || (en !== '' && want.has(en));
    if (!named && !(rank !== null && Number(p.scalerank) <= rank)) continue;
    for (const line of linesOf(f.geometry)) {
      if (near && !near(boxOf(line))) continue;
      if (want.has(name)) found.add(name);
      if (en !== '' && want.has(en)) found.add(en);
      if (!byName.has(name)) byName.set(name, { name: en || name, rank: Number(p.scalerank), lines: [] });
      const r = byName.get(name);
      r.rank = Math.min(r.rank, Number(p.scalerank));
      r.lines.push(line);
    }
  }
  const missing = names.filter((n) => !found.has(n));
  if (missing.length > 0) throw new Error(`world: Natural Earth has no river ${missing.map((n) => JSON.stringify(n)).join(', ')} in this map (a name as it writes it, or in English)`);
  const used = new Set();
  return [...byName.entries()]
    .sort((a, b) => a[1].rank - b[1].rank || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, r]) => {
      const lines = linesInFrame(joinLines(r.lines, { eps: 1e-9 }).map((c) => (c.closed ? [...c.line, c.line[0]] : c.line)), frame, detail);
      if (lines.length === 0) return null;
      let id = `river-${plainSlug(key) || 'unnamed'}`;
      for (let k = 2; used.has(id); k++) id = `river-${plainSlug(key) || 'unnamed'}-${k}`;
      used.add(id);
      return { id, name: r.name, rank: r.rank, lines };
    })
    .filter((r) => r !== null);
}

/** From [lon, lat] to the plane of a frame. */
const forwardOf = (frame) => (frame.projection === 'equal-earth' ? equalEarth(frame.centre[0]) : projection({ lon: frame.centre[0], lat: frame.centre[1] })).forward;

/**
 * The towns of Natural Earth's populated places (`ne_10m_populated_places_simple`) of at least `minPop` people (their
 * greatest population, `pop_max`) that stand on the map: in a box's box, anywhere on the whole world. Each is
 * { id, name, country, pop, capital?, at, lonlat }: `country` the id of its country as the countries have it, `capital`
 * true for the capital of a country; the largest first.
 */
export function buildTowns(collection, frame, { minPop }) {
  const forward = forwardOf(frame);
  const [x0, y0, x1, y1] = frame.box;
  const out = [];
  for (const f of collection.features ?? []) {
    const p = f.properties ?? {};
    const g = f.geometry;
    if (g?.type !== 'Point') continue;
    const pop = p.pop_max === null || p.pop_max === undefined ? Number.NaN : Number(p.pop_max);
    if (!(Number.isFinite(pop) && pop >= minPop)) continue;
    const [lon, lat] = g.coordinates;
    if (!(Number.isFinite(lon) && Number.isFinite(lat))) continue;
    const at = whole([forward([lon, lat])])[0];
    if (frame.projection === 'laea' && !(at[0] >= x0 && at[0] <= x1 && at[1] >= y0 && at[1] <= y1)) continue;
    out.push({ name: String(p.name ?? p.nameascii ?? ''), country: String(p.adm0_a3 ?? '').toLowerCase(), pop: Math.round(pop), ...(Number(p.adm0cap) === 1 ? { capital: true } : {}), at, lonlat: [Math.round(lon * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4] });
  }
  out.sort((a, b) => b.pop - a.pop || a.name.localeCompare(b.name, 'en') || a.lonlat[0] - b.lonlat[0] || a.lonlat[1] - b.lonlat[1]);
  return out.map((t, k) => ({ id: `town-${k}`, ...t }));
}

/** The indicators of the table: every name that has a field `<name>_cat` and a field `<name>_label`. */
export function waterRiskIndicators(fields) {
  const names = new Set(fields.map((f) => f.name));
  return fields.map((f) => f.name).filter((n) => n.endsWith('_cat') && names.has(`${n.slice(0, -4)}_label`)).map((n) => n.slice(0, -4));
}

/**
 * The rows of the table of WRI's Aqueduct 4.0 (`baseline_annual` of the geodatabase in its archive, given as the
 * bytes of the ZIP) that come near the map, each with its polygon (in degrees) and the category and label of one
 * indicator: `{ cat, label }`, `cat` from -1 (arid and of low water use) to 4 (extremely high), -9999 where there is
 * no data. An indicator the table lacks is refused, with those it has.
 */
export function readWaterRisk(zip, { indicator, frame, table = 'baseline_annual' }) {
  const names = zipEntries(zip).map((e) => e.name);
  const dir = names.find((n) => /\.gdb\/a00000001\.gdbtable$/.test(n))?.replace(/a00000001\.gdbtable$/, '');
  if (!dir) throw new Error('world: the archive of Aqueduct holds no file geodatabase');
  const exact = (name) => new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${name}$`);
  const catalog = readGdbCatalog(unzip(zip, exact('a00000001\\.gdbtable')), unzip(zip, exact('a00000001\\.gdbtablx')));
  const entry = catalog.find((t) => t.name === table);
  if (!entry) throw new Error(`world: the geodatabase of Aqueduct has no table ${table} (it has ${catalog.map((t) => t.name).join(', ')})`);
  const rows = unzip(zip, exact(`${entry.file}\\.gdbtable`));
  const index = unzip(zip, exact(`${entry.file}\\.gdbtablx`));
  const known = waterRiskIndicators(readGdbFields(rows).fields);
  if (!known.includes(indicator)) throw new Error(`world: Aqueduct has no indicator "${indicator}" (it has ${known.join(', ')})`);
  const near = frame.projection === 'laea' ? nearFrame(frame, 0.5) : null;
  const features = [];
  for (const f of readGdbTable(rows, index).features) {
    if (!f.geometry) continue;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    if (near && !polys.some((poly) => near(boxOf(poly[0])))) continue;
    const raw = f.properties[`${indicator}_cat`];
    const cat = raw === null || raw === undefined ? Number.NaN : Number(raw);
    const label = f.properties[`${indicator}_label`];
    features.push({ type: 'Feature', properties: { cat: Number.isFinite(cat) ? cat : -9999, label: typeof label === 'string' && label !== '' ? label : 'No Data' }, geometry: f.geometry });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * The water risk of a map by category: the pieces of a collection of `{ cat, label }` (readWaterRisk) thinned together,
 * so neighbouring categories share their border point for point, and each category's pieces made one outline, cut to
 * the map. `{ indicator, classes }`: each class { cat, label, rings, holes }, the categories in order and "no data"
 * (-9999) last; `rings` its outlines and `holes` the other categories inside them, all counter-clockwise, the largest
 * first. A class is painted as its rings less its holes (for a renderer that fills by winding, its holes turned round).
 */
export function buildWaterRisk(collection, frame, { detail, minArea, indicator }) {
  const near = frame.projection === 'laea' ? nearFrame(frame, 0.5) : null;
  const ringsOf = featureRings(frame, near);
  const labels = new Map();
  const shapes = [];
  for (const f of collection.features ?? []) {
    const { cat, label } = f.properties ?? {};
    if (!Number.isFinite(cat)) continue;
    const rings = ringsOf(f.geometry);
    if (rings.length === 0) continue;
    if (!labels.has(cat)) labels.set(cat, String(label));
    shapes.push({ rings, group: cat });
  }
  const t = thinTogether(shapes, { tol: detail, minArea, digits: 0 });
  const box = frame.projection === 'laea' ? frame.box : null;
  const cut = (rings) =>
    rings
      .flatMap((r) => (box ? clipRing(r, box) : [r]))
      .map((r) => orient(dedupe(whole(r), 0, true), true))
      .filter((r) => r.length >= 3 && area(r) >= minArea)
      .sort((a, b) => area(b) - area(a) || a[0][0] - b[0][0] || a[0][1] - b[0][1]);
  const order = (cat) => (cat === -9999 ? Infinity : cat);
  const classes = (t.groups ?? [])
    .map((g) => ({ cat: g.key, label: labels.get(g.key), rings: cut(g.land), holes: cut(g.gaps) }))
    .filter((c) => c.rings.length > 0)
    .sort((a, b) => order(a.cat) - order(b.cat));
  return { indicator, classes };
}
