// Lines and places of a world map beyond its countries: the sea lanes of a global shipping network, named places
// (given by hand, or the ports and airports of Natural Earth), and named lines (mapped elements of OpenStreetMap, a
// line drawn through given places after a written source, or the great circle between two places). Each is in metres
// on the plane of the map's frame, cut to its box and at its edge, as the countries are.

import { boxOf, clipLine, dedupe, lengthOf, simplify } from './geom.mjs';
import { joinLines } from './osm.mjs';
import { arcLength, greatCircle } from './route.mjs';
import { frameCut, frameOptions, nearFrame, worldFrame } from './world.mjs';

const lonLat = (p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
const whole = (points) => dedupe(points.map(([x, y]) => [Math.round(x) + 0, Math.round(y) + 0]), 0);
const idOk = (id) => typeof id === 'string' && /^[a-z][a-z0-9-]*$/.test(id);

/**
 * Lines in [lon, lat] on the plane of a frame: cut at the edge of the world (or carried across the 180th meridian in
 * a box that crosses it), projected, cut to a box's edge, thinned to `detail` metres and rounded to whole metres.
 * The ends of each line are kept, so lines that met at a point still meet there.
 */
export function linesInFrame(lines, frame, detail) {
  const cut = frameCut(frame);
  const box = frame.projection === 'laea' ? frame.box : null;
  const out = [];
  for (const line of lines) {
    for (const piece of cut.lines(line)) {
      const flat = piece.map(cut.forward);
      for (const part of box ? clipLine(flat, box) : [flat]) {
        const pts = whole(simplify(dedupe(part, 0), detail));
        if (pts.length >= 2) out.push(pts);
      }
    }
  }
  return out;
}

/** The rank of a lane by how many routes used it: 0 for none, then 1 for 1 to 9, 2 for 10 to 99, and so on by tens. */
export const laneRank = (freq) => (freq >= 1 ? Math.floor(Math.log10(freq) + 1e-9) + 1 : 0);

/**
 * The sea lanes of a global shipping network, as its collection of links comes: GeoJSON lines, each a link between two
 * junctions in one direction, with `Route Freq`, how many of the routes its publisher ran over the network used it,
 * and `Name0`, the name of a waterway where it has one. A link given both ways is one, used by the routes of both.
 * Links of one rank (`laneRank`) and one name that meet end to end, at a point no third link meets, are joined into
 * one lane. Each lane is { id, rank, name?, lines }: the lanes of the main routes have a high rank (5 and above), the
 * open-sea grid that lets a route reach anywhere a low one. A box keeps the lanes that come into it, cut to its edge.
 * The lanes keep their ends, so lanes that met still meet: `routeAlong` finds a way along them.
 */
export function buildLanes(collection, frame, { detail }) {
  const key = (p) => `${p[0]},${p[1]}`;
  const byLine = new Map();
  for (const f of collection.features ?? []) {
    const g = f.geometry;
    const parts = g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : [];
    const p = f.properties ?? {};
    const freq = Math.max(0, Math.round(Number(p['Route Freq']) || 0));
    const name = String(p.Name0 ?? '').trim();
    for (const coords of parts) {
      const line = dedupe(coords.filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])).map((c) => [c[0], c[1]]), 0);
      if (line.length < 2) continue;
      const [ab, ba] = [line.map(key).join(';'), [...line].reverse().map(key).join(';')];
      const id = ab < ba ? ab : ba;
      const was = byLine.get(id);
      if (was) {
        was.freq += freq;
        if (!was.name) was.name = name;
      } else byLine.set(id, { line: ab < ba ? line : [...line].reverse(), freq, name, id });
    }
  }
  const links = [...byLine.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((l) => ({ line: l.line, rank: laneRank(l.freq), name: l.name }));
  // Where links meet: a point two links share, and no other, joins them if they are alike.
  const at = new Map();
  links.forEach((l, k) => {
    for (const p of [l.line[0], l.line[l.line.length - 1]]) {
      if (!at.has(key(p))) at.set(key(p), []);
      at.get(key(p)).push(k);
    }
  });
  const used = new Array(links.length).fill(false);
  const lanes = [];
  const partner = (k, p) => {
    const here = at.get(key(p));
    if (here.length !== 2) return -1;
    const j = here[0] === k ? here[1] : here[0];
    return j !== k && !used[j] && links[j].rank === links[k].rank && links[j].name === links[k].name ? j : -1;
  };
  for (let k = 0; k < links.length; k++) {
    if (used[k]) continue;
    used[k] = true;
    let line = [...links[k].line];
    // On from its last point, then back from its first.
    for (const end of ['last', 'first']) {
      for (;;) {
        if (key(line[0]) === key(line[line.length - 1])) break;
        const tip = end === 'last' ? line[line.length - 1] : line[0];
        const j = partner(k, tip);
        if (j < 0) break;
        used[j] = true;
        const l = links[j].line;
        if (end === 'last') line = [...line, ...(key(l[0]) === key(tip) ? l : [...l].reverse()).slice(1)];
        else line = [...(key(l[l.length - 1]) === key(tip) ? l : [...l].reverse()), ...line.slice(1)];
      }
    }
    lanes.push({ line, rank: links[k].rank, name: links[k].name });
  }
  const near = frame.projection === 'laea' ? nearFrame(frame, 1) : null;
  const out = [];
  for (const lane of lanes) {
    if (near && !near(boxOf(lane.line))) continue;
    const lines = linesInFrame([lane.line], frame, detail);
    if (lines.length > 0) out.push({ rank: lane.rank, ...(lane.name ? { name: lane.name } : {}), lines });
  }
  // The highest rank first; then from west to east, so the same network gives the same order.
  out.sort((a, b) => b.rank - a.rank || a.lines[0][0][0] - b.lines[0][0][0] || a.lines[0][0][1] - b.lines[0][0][1]);
  return out.map((l, k) => ({ id: `lane-${k}`, ...l }));
}

/** The keys a place and a line of a features file take. */
export const PLACE_KEYS = ['id', 'name', 'at', 'port', 'airport', 'near'];
export const LINE_KEYS = ['id', 'name', 'from', 'step', 'detail', 'source'];

/**
 * What is wrong with a features file of a world map, thrown as an error: `{ places?, lines? }`, each a list.
 *   a place  { id, name?, at | port | airport, near? }: `at` [lon, lat] given by hand (with its `name`); `port` the
 *            name of a port of Natural Earth, `airport` the IATA code or the name of an airport of Natural Earth,
 *            with `near` [lon, lat] to choose among several of one name
 *   a line   { id, name, from, step?, detail?, source }: `from` is one of { osm: [elements] } (ways and relations of
 *            OpenStreetMap, joined end to end), { through: [place, ...] } (a line drawn through places, ids of this
 *            file's places or [lon, lat], after the written source `source` names: marked approximate), or
 *            { great: [place, place] } (the great circle between two places, a point every `step` degrees of arc,
 *            1 by default); `detail` is the thinning in metres (the map's by default)
 */
export function checkWorldFeatures(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('features: a features file is { places, lines }, each a list');
  for (const key of Object.keys(spec)) if (!['places', 'lines'].includes(key)) throw new Error(`features: no key "${key}" (a features file takes places and lines)`);
  const places = spec.places ?? [];
  const lines = spec.lines ?? [];
  if (!Array.isArray(places) || !Array.isArray(lines)) throw new Error('features: "places" and "lines" are lists');
  const ids = new Set();
  const own = (id, what) => {
    if (!idOk(id)) throw new Error(`features: ${what} ${JSON.stringify(id)}: its id is lower-case letters, digits and hyphens, beginning with a letter`);
    if (ids.has(id)) throw new Error(`features: the id "${id}" is given twice`);
    ids.add(id);
  };
  for (const p of places) {
    if (p === null || typeof p !== 'object' || Array.isArray(p)) throw new Error(`features: a place is an object { id, at | port | airport }, not ${JSON.stringify(p)}`);
    own(p.id, 'place');
    for (const key of Object.keys(p)) if (!PLACE_KEYS.includes(key)) throw new Error(`place ${p.id}: no key "${key}" (a place takes ${PLACE_KEYS.join(', ')})`);
    const ways = ['at', 'port', 'airport'].filter((k) => p[k] !== undefined);
    if (ways.length !== 1) throw new Error(`place ${p.id}: it is given one way: "at" by hand, or a "port" or an "airport" of Natural Earth`);
    if (p.at !== undefined && (!lonLat(p.at) || typeof p.name !== 'string' || p.name.trim() === '')) throw new Error(`place ${p.id}: "at" is [lon, lat], and a place given by hand has a name`);
    if ((p.port !== undefined && (typeof p.port !== 'string' || p.port.trim() === '')) || (p.airport !== undefined && (typeof p.airport !== 'string' || p.airport.trim() === ''))) throw new Error(`place ${p.id}: "port" and "airport" are names (an airport's IATA code will do)`);
    if (p.near !== undefined && (!lonLat(p.near) || p.at !== undefined)) throw new Error(`place ${p.id}: "near" is [lon, lat], to choose a port or an airport among several of one name`);
    if (p.name !== undefined && (typeof p.name !== 'string' || p.name.trim() === '')) throw new Error(`place ${p.id}: its name is a text`);
  }
  const placeIds = new Set(places.map((p) => p.id));
  const ref = (r, where) => {
    if (typeof r === 'string') {
      if (!placeIds.has(r)) throw new Error(`${where}: no place "${r}" in the file`);
    } else if (!lonLat(r)) throw new Error(`${where}: a place is the id of a place of the file, or [lon, lat]; got ${JSON.stringify(r)}`);
  };
  for (const l of lines) {
    if (l === null || typeof l !== 'object' || Array.isArray(l)) throw new Error(`features: a line is an object { id, name, from, source }, not ${JSON.stringify(l)}`);
    own(l.id, 'line');
    const where = `line ${l.id}`;
    for (const key of Object.keys(l)) if (!LINE_KEYS.includes(key)) throw new Error(`${where}: no key "${key}" (a line takes ${LINE_KEYS.join(', ')})`);
    if (typeof l.name !== 'string' || l.name.trim() === '') throw new Error(`${where}: it has a name`);
    if (typeof l.source !== 'string' || l.source.trim() === '') throw new Error(`${where}: it names its source, a sentence for SOURCES.md: the written source it is drawn after, or what it is`);
    const from = l.from;
    if (from === null || typeof from !== 'object' || Array.isArray(from) || Object.keys(from).length !== 1) throw new Error(`${where}: "from" is one of { osm }, { through } and { great }`);
    const [kind] = Object.keys(from);
    if (kind === 'osm') {
      if (!Array.isArray(from.osm) || from.osm.length === 0 || !from.osm.every((id) => typeof id === 'string' && /^(way|relation)\/\d+$/.test(id))) throw new Error(`${where}: "from.osm" is a list of way/<id> and relation/<id>`);
    } else if (kind === 'through') {
      if (!Array.isArray(from.through) || from.through.length < 2) throw new Error(`${where}: "from.through" is two places or more`);
      from.through.forEach((r) => ref(r, where));
    } else if (kind === 'great') {
      if (!Array.isArray(from.great) || from.great.length !== 2) throw new Error(`${where}: "from.great" is two places, the ends of the great circle`);
      from.great.forEach((r) => ref(r, where));
    } else throw new Error(`${where}: "from" is one of { osm }, { through } and { great }, not "${kind}"`);
    if (l.step !== undefined && (kind !== 'great' || !(typeof l.step === 'number' && l.step > 0 && l.step <= 10))) throw new Error(`${where}: "step" is the degrees of arc between the points of a great circle, above 0 and up to 10`);
    if (l.detail !== undefined && !(typeof l.detail === 'number' && l.detail > 0)) throw new Error(`${where}: "detail" is metres above 0`);
  }
}

/** The one feature of a Natural Earth collection of points that a name (or an IATA code) names, near `near` if given. */
function pick(collection, what, wanted, near) {
  const fold = (t) => String(t ?? '').trim().toLowerCase();
  const all = (collection.features ?? []).filter((f) => f.geometry?.type === 'Point' && lonLat(f.geometry.coordinates));
  let found = all.filter((f) => fold(f.properties?.name) === fold(wanted) || (what === 'airport' && fold(f.properties?.iata_code) === fold(wanted)));
  if (found.length === 0) throw new Error(`features: Natural Earth has no ${what} "${wanted}"`);
  if (found.length > 1 && near) found = [...found].sort((a, b) => arcLength(a.geometry.coordinates, near) - arcLength(b.geometry.coordinates, near)).slice(0, 1);
  if (found.length > 1) throw new Error(`features: Natural Earth has ${found.length} ${what}s "${wanted}" (at ${found.map((f) => f.geometry.coordinates.map((v) => v.toFixed(2)).join(' ')).join('; ')}): give "near" [lon, lat] to choose one`);
  const f = found[0];
  return { name: String(f.properties.name), lonlat: [f.geometry.coordinates[0], f.geometry.coordinates[1]] };
}

/**
 * The places and lines of a features file on the plane of a frame. `ports` and `airports` are Natural Earth's
 * collections (needed only when a place names one); `mapped[id]` are the lines in [lon, lat] of a line's elements
 * of OpenStreetMap (elementLines). Returns { places, lines }:
 *   places  { id, name, kind: 'place' | 'port' | 'airport', at, lonlat }: `at` on the plane (it may lie outside a
 *           box: a route may begin beyond its edge), `lonlat` where it is
 *   lines   { id, name, kind: 'mapped' | 'drawn' | 'great', approximate?, source, lengthKm, lines }: `approximate`
 *           for a line drawn through places by hand; `source` the file's sentence; `lengthKm` its whole length on the
 *           Earth, also where the map cuts it; `lines` its pieces on the map, the longest first
 */
export function buildWorldFeatures(spec, frame, { ports = null, airports = null, mapped = {}, detail }) {
  checkWorldFeatures(spec);
  const { proj } = worldFrame(frameOptions(frame));
  const places = [];
  for (const p of spec.places ?? []) {
    let got;
    if (p.at) got = { name: p.name, lonlat: [p.at[0], p.at[1]], kind: 'place' };
    else if (p.port) {
      if (!ports) throw new Error(`place ${p.id}: the ports of Natural Earth were not read`);
      got = { ...pick(ports, 'port', p.port, p.near), kind: 'port' };
    } else {
      if (!airports) throw new Error(`place ${p.id}: the airports of Natural Earth were not read`);
      got = { ...pick(airports, 'airport', p.airport, p.near), kind: 'airport' };
    }
    const [x, y] = proj.forward(got.lonlat);
    places.push({ id: p.id, name: p.name ?? got.name, kind: got.kind, at: [Math.round(x) + 0, Math.round(y) + 0], lonlat: got.lonlat });
  }
  const where = (r) => (typeof r === 'string' ? places.find((p) => p.id === r).lonlat : r);
  const lines = [];
  for (const l of spec.lines ?? []) {
    const [kind] = Object.keys(l.from);
    let chains;
    if (kind === 'osm') {
      const got = mapped[l.id] ?? [];
      if (got.length === 0) throw new Error(`line ${l.id}: its elements hold no way`);
      chains = joinLines(got, { eps: 1e-7 }).map((c) => (c.closed ? [...c.line, c.line[0]] : c.line));
    } else if (kind === 'through') chains = [l.from.through.map(where)];
    else chains = [greatCircle(where(l.from.great[0]), where(l.from.great[1]), { step: l.step ?? 1 })];
    let metres = 0;
    for (const c of chains) for (let k = 1; k < c.length; k++) metres += arcLength(c[k - 1], c[k]);
    const pieces = linesInFrame(chains, frame, l.detail ?? detail);
    if (pieces.length === 0) throw new Error(`line ${l.id}: no part of it lies on the map`);
    pieces.sort((a, b) => lengthOf(b) - lengthOf(a) || a[0][0] - b[0][0] || a[0][1] - b[0][1]);
    lines.push({ id: l.id, name: l.name, kind: kind === 'osm' ? 'mapped' : kind === 'through' ? 'drawn' : 'great', ...(kind === 'through' ? { approximate: true } : {}), source: l.source, lengthKm: Math.round(metres / 100) / 10, lines: pieces });
  }
  return { places, lines };
}
