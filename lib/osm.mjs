// Reading Overpass answers (OpenStreetMap and OpenHistoricalMap, `out geom`): ways as lines of
// [lon, lat], ways joined end to end, and areas (closed ways and multipolygon relations) as rings.
// The answers are data: parsed as JSON, never run.

import { readFileSync } from 'node:fs';

export const readOverpass = (path) => JSON.parse(readFileSync(path, 'utf8')).elements ?? [];

/** The time the data of an Overpass answer is of, as its server states it (a date), or null. */
export function overpassDate(path) {
  const m = /"timestamp_osm_base"\s*:\s*"([^"]+)"/.exec(readFileSync(path, 'utf8').slice(0, 2000));
  return m ? m[1].slice(0, 10) : null;
}

const lineOf = (geometry) => (geometry ?? []).filter(Boolean).map((p) => [p.lon, p.lat]);

/** The ways of an answer that `pick(tags, element)` takes, as { id, tags, line }. */
export function waysOf(elements, pick = () => true) {
  const out = [];
  for (const e of elements) {
    if (e.type !== 'way' || !e.geometry) continue;
    if (!pick(e.tags ?? {}, e)) continue;
    const line = lineOf(e.geometry);
    if (line.length >= 2) out.push({ id: e.id, tags: e.tags ?? {}, line });
  }
  return out.sort((a, b) => a.id - b.id);
}

const same = (p, q, eps) => Math.abs(p[0] - q[0]) <= eps && Math.abs(p[1] - q[1]) <= eps;

/**
 * Lines joined end to end into chains, as far as they go. With `directed`, a line is never turned
 * round (a coastline keeps its land on the left); otherwise it is turned where that joins it.
 * A chain that ends where it begins is a ring: { line, closed }, the ring without its last point.
 * `eps` is how near two ends are to be one, in degrees.
 */
export function joinLines(lines, { directed = false, eps = 1e-7 } = {}) {
  const left = lines.map((l) => [...l]);
  const out = [];
  while (left.length > 0) {
    let line = left.shift();
    for (let joined = true; joined && !same(line[0], line[line.length - 1], eps); ) {
      joined = false;
      for (let k = 0; k < left.length; k++) {
        const arc = left[k];
        const end = line[line.length - 1];
        const start = line[0];
        if (same(arc[0], end, eps)) line = [...line, ...arc.slice(1)];
        else if (same(arc[arc.length - 1], start, eps)) line = [...arc, ...line.slice(1)];
        else if (!directed && same(arc[arc.length - 1], end, eps)) line = [...line, ...[...arc].reverse().slice(1)];
        else if (!directed && same(arc[0], start, eps)) line = [...[...arc].reverse(), ...line.slice(1)];
        else continue;
        left.splice(k, 1);
        joined = true;
        break;
      }
    }
    const closed = line.length > 3 && same(line[0], line[line.length - 1], eps);
    out.push({ line: closed ? line.slice(0, -1) : line, closed });
  }
  return out;
}

/**
 * The areas of an answer that `pick(tags)` takes: each { id, tags, outer: [ring...], inner: [ring...] },
 * from closed ways and from multipolygon relations, whose member ways are joined into rings. A ring
 * that does not close is left out.
 */
export function areasOf(elements, pick = () => true) {
  const out = [];
  for (const e of elements) {
    const tags = e.tags ?? {};
    if (!pick(tags, e)) continue;
    if (e.type === 'way' && e.geometry) {
      const line = lineOf(e.geometry);
      if (line.length >= 4 && same(line[0], line[line.length - 1], 1e-9)) out.push({ id: `way/${e.id}`, tags, outer: [line.slice(0, -1)], inner: [] });
    } else if (e.type === 'relation' && e.members) {
      const rings = (role) =>
        joinLines(e.members.filter((m) => m.type === 'way' && m.geometry && (role === 'inner' ? m.role === 'inner' : m.role !== 'inner')).map((m) => lineOf(m.geometry)).filter((l) => l.length >= 2))
          .filter((c) => c.closed && c.line.length >= 3)
          .map((c) => c.line);
      const outer = rings('outer');
      if (outer.length > 0) out.push({ id: `relation/${e.id}`, tags, outer, inner: rings('inner') });
    }
  }
  return out;
}

/** The middle of an element of an answer given with `out center` or `out geom`, as [lon, lat], or null. */
export function centreOf(e) {
  if (e.type === 'node') return [e.lon, e.lat];
  if (e.center) return [e.center.lon, e.center.lat];
  if (e.bounds) return [(e.bounds.minlon + e.bounds.maxlon) / 2, (e.bounds.minlat + e.bounds.maxlat) / 2];
  return null;
}

/** The Overpass box of a lon/lat box: south, west, north, east, to six decimals. */
export const overpassBox = ([lon0, lat0, lon1, lat1]) => [lat0, lon0, lat1, lon1].map((v) => v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')).join(',');

/** The year of a date as OpenHistoricalMap writes it ("1748", "-0399", "1975-05", "2012-04-20"), or null. */
export function yearOf(date) {
  const m = /^(-?\d{1,4})(?:-|$)/.exec(String(date ?? '').trim());
  return m ? Number(m[1]) : null;
}

/**
 * Whether a thing with these tags stands in `year`: begun by then and not yet ended. Without a year
 * it is asked of today: a thing with an end date is gone. OpenStreetMap's things carry no dates, and
 * all stand.
 */
export function alive(tags, year = null) {
  const start = yearOf(tags.start_date);
  const end = yearOf(tags.end_date);
  if (year === null) return end === null;
  return (start === null || start <= year) && (end === null || end > year);
}
