#!/usr/bin/env node
// The pipeline: from a city's spec to the layers of its map.
//
//   node build.mjs <city>             builds <root>/<city>/ from <root>/cities/<city>.json
//   node build.mjs <city> --preview   and draws the previews into <root>/out/<city>/ (not committed)
//   node build.mjs <city> --offline   from the cache alone: nothing is fetched
//   node build.mjs <city> --update    takes downloads that differ from the lock, and rewrites it
//   node build.mjs <city> --new --name <Name> --bbox <west,south,east,north> [--country <ISO A3>]
//        [--centre <lon,lat>] [--years 1975,2000,2020] [--wide <west,south,east,north>]
//                                     writes the spec of a new city, then builds it
//   --root <dir>                      where the cities are kept (the working directory)
//
// A project that keeps its own cities calls `run(argv, { root, command, sources, notes })` from a
// script of its own, so that its specs, layers and cache stay with it.
//
// A spec names the city, its centre, its views (boxes in lon/lat) and what each layer is made of
// (README.md, "The spec"). The pipeline fetches what the layers need into cache/ (not committed; each
// download in a directory of its own, read as data and never run), projects it, simplifies it
// without self-crossings, and writes, into <city>/:
//   layers.json         the layers, in metres of the frame (README.md, "The layers")
//   sources.lock.json   every download: its request, size and SHA-256, and the date of its data
//   SOURCES.md          the credits a film's description needs, and where each layer comes from
// The output is a pure function of the spec and the downloads: the same lock gives the same bytes.
// A download that differs from the lock stops the build, unless --update is given.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readGeoTiff, readHgt, reduceTile, sampler, scaleOf, seaTile, waterSampler, waterShare } from './lib/dem.mjs';
import { builtShare, GHSL_RELEASE, GHSL_YEARS, ghslTile, ghslTilesOf, ghslUrl, mollweideBox } from './lib/ghsl.mjs';
import { area } from './lib/geom.mjs';
import { readRaster } from './lib/tiff.mjs';
import { unzip } from './lib/zip.mjs';
import { overpass } from './lib/fetch.mjs';
import { areasOfAnswer, buildBuiltUp, buildEpochs, buildLandmarks, buildRegion, buildRelief, buildStreets, buildTerrain, buildWall, buildWater, featuresOf, riverOf, terrainPlan, urbanAreas } from './lib/layers.mjs';
import { centreOf, overpassBox, overpassDate, readOverpass, waysOf } from './lib/osm.mjs';
import { projectBox, projection, unprojectBox } from './lib/project.mjs';
import { awmc, AWMC_COMMIT, awmcName, copernicusTile, copernicusWaterMask, licencesWith, NATURAL_EARTH_VERSION, naturalEarth, tilesOf } from './lib/sources.mjs';

/** The layers file, written the same way every time: objects opened to the level of a feature, its points on one line. */
export function stringify(value) {
  const flat = (v) => v === null || typeof v !== 'object' || (Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object' || (Array.isArray(x) && x.every((y) => typeof y !== 'object'))));
  const fmt = (v, depth, ind) => {
    if (depth >= 4 || flat(v)) return JSON.stringify(v);
    const inner = `${ind}  `;
    if (Array.isArray(v)) return v.length === 0 ? '[]' : `[\n${v.map((x) => inner + fmt(x, depth + 1, inner)).join(',\n')}\n${ind}]`;
    const keys = Object.keys(v);
    return keys.length === 0 ? '{}' : `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${fmt(v[k], depth + 1, inner)}`).join(',\n')}\n${ind}}`;
  };
  return `${fmt(value, 0, '')}\n`;
}

const union = (boxes) => [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
const roundBox = (b) => b.map((v) => Math.round(v));

const numbers = (text, count, what) => {
  const out = String(text ?? '').split(',').map(Number);
  if ((count && out.length !== count) || out.some((v) => !Number.isFinite(v))) throw new Error(`build: ${what} is ${count ?? 'a list of'} numbers with commas between them`);
  return out;
};

/**
 * The spec a new city starts from: its box as the one view, the region round it, water from the
 * water mask of the elevation model, contour lines, and the built-up city of each year asked for
 * as its epochs. Everything in it comes from sources that cover the whole world, so it builds for
 * any city; walls, hills, landmarks and the epochs before 1975 are then added by hand. With `wide`, a
 * second box round the first, the city also gets a wide view of the country it stands in, and its
 * terrain: the land, the lakes and the ground in bands of height.
 */
export function scaffold({ city, name, bbox, centre = null, country = null, years = [1975, 2000, 2020], wide = null }) {
  const [w, s, e, n] = bbox;
  if (!(w < e && s < n && w >= -180 && e <= 180 && s > -85 && n < 85)) throw new Error('build: --bbox is west,south,east,north in degrees');
  if (wide && !(wide[0] <= w && wide[1] <= s && wide[2] >= e && wide[3] >= n && wide[0] >= -180 && wide[2] <= 180 && wide[1] > -85 && wide[3] < 85)) throw new Error('build: --wide is west,south,east,north in degrees, a box that holds --bbox');
  for (const year of years) if (!GHSL_YEARS.includes(year)) throw new Error(`build: no built-up layer of ${year} (there are ${GHSL_YEARS.join(', ')})`);
  const at = centre ?? [Math.round(((w + e) / 2) * 1e4) / 1e4, Math.round(((s + n) / 2) * 1e4) / 1e4];
  return {
    city,
    name,
    centre: at,
    views: { metro: bbox, ...(wide ? { wide } : {}) },
    region: {
      centre: at,
      bbox: [Math.round(at[0] - 9), Math.round(at[1] - 5.5), Math.round(at[0] + 9), Math.round(at[1] + 5.5)],
      ...(country ? { country } : {}),
      rivers: { rank: 3 },
      lakes: { rank: 4 },
    },
    water: { view: 'metro', from: ['copernicus'], mask: ['ocean', 'lake', 'river'], cell: 15 },
    relief: { view: 'metro', cell: 60, smooth: 180, contours: { step: 50 } },
    ...(wide ? { terrain: { view: 'wide' } } : {}),
    builtUp: { view: 'metro', from: 'ghsl', years, cell: 50, share: 0.2, bridge: 350, round: 2.5 },
    epochs: years.map((year) => ({
      id: `y${year}`,
      year,
      name: `${name} in ${year}`,
      outline: { builtUp: year },
      source: `The built-up city of ${year} as satellite images show it (the Global Human Settlement Layer).`,
    })),
  };
}

/** The frames of a spec: the city's (centre, box, views) and the region's. */
export function framesOf(spec) {
  const proj = projection({ lon: spec.centre[0], lat: spec.centre[1] });
  const views = Object.fromEntries(Object.entries(spec.views).map(([name, box]) => [name, roundBox(projectBox(proj, box))]));
  const lonlat = union(Object.values(spec.views));
  const city = { proj, box: union(Object.values(views)), lonlat, views, viewsLonLat: spec.views };
  let region = null;
  if (spec.region) {
    const centre = spec.region.centre ?? [(spec.region.bbox[0] + spec.region.bbox[2]) / 2, (spec.region.bbox[1] + spec.region.bbox[3]) / 2];
    const rproj = projection({ lon: centre[0], lat: centre[1] });
    region = { proj: rproj, box: roundBox(projectBox(rproj, spec.region.bbox)), lonlat: spec.region.bbox, centre };
  }
  return { city, region };
}

/** The box of a layer: the view its spec names (the whole city frame by default), in the plane and in lon/lat. */
function boxOfLayer(layerSpec, frames, fallback = null) {
  const name = layerSpec.view ?? fallback;
  if (!name) return { box: frames.city.box, lonlat: frames.city.lonlat };
  if (!frames.city.views[name]) throw new Error(`no view "${name}" in the spec`);
  return { box: frames.city.views[name], lonlat: frames.city.viewsLonLat[name] };
}

const ql = (lines, out, timeout = 240) => `[out:json][timeout:${timeout}];\n(\n${lines.map((l) => `  ${l}`).join('\n')}\n);\n${out}\n`;

const list = (value, fallback) => (value === undefined ? fallback : Array.isArray(value) ? value : [value]);

/** Where a layer of a spec comes from: its `from`, one source or several. */
export const sourcesOf = (layerSpec, fallback) => list(layerSpec.from, [fallback]);

/**
 * The Overpass requests of a spec, by layer: { source, id, query }, the source `osm` or `ohm`.
 * Their text is fixed by the spec, so the cache and the lock hold.
 */
export function requestsOf(spec, frames) {
  const out = {};
  if (spec.water) {
    const b = overpassBox(boxOfLayer(spec.water, frames).lonlat);
    const from = sourcesOf(spec.water, 'osm');
    if (from.includes('osm')) {
      out['water-osm'] = {
        source: 'osm',
        id: `${spec.city}-osm-water`,
        query: ql([`way["natural"~"^(water|bay)$"](${b});`, `relation["natural"~"^(water|bay)$"](${b});`, `way["waterway"="riverbank"](${b});`, `relation["waterway"="riverbank"](${b});`, `way["waterway"~"^(river|canal)$"](${b});`, `way["natural"="coastline"](${b});`], 'out geom;'),
      };
    }
    if (from.includes('ohm')) {
      out['water-ohm'] = {
        source: 'ohm',
        id: `${spec.city}-ohm-water`,
        query: ql([`way["natural"~"^(water|bay)$"](${b});`, `relation["natural"~"^(water|bay)$"](${b});`, `way["waterway"~"^(river|canal)$"](${b});`, `way["place"~"^(islet|island)$"](${b});`, `relation["place"~"^(islet|island)$"](${b});`], 'out geom;'),
      };
    }
  }
  if (spec.terrain?.rivers) {
    // Only the rivers wanted are asked for, by their names: a wide box holds every stream of a country.
    const b = overpassBox(boxOfLayer(spec.terrain, frames).lonlat);
    const source = spec.terrain.rivers.from ?? 'osm';
    if (source !== 'osm' && source !== 'ohm') throw new Error(`terrain: "rivers.from" is "osm" or "ohm", not "${source}"`);
    const quoted = (text) => text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const lines = (spec.terrain.rivers.list ?? []).map(riverOf).flatMap((r) => ['name', 'name:en'].map((key) => `way["waterway"~"^(river|canal)$"]["${key}"~"${quoted(r.match)}"](${b});`));
    out['terrain-rivers'] = { source, id: `${spec.city}-${source}-terrain-rivers`, query: ql(lines, 'out geom;') };
  }
  if (spec.streets) {
    const b = overpassBox(boxOfLayer(spec.streets, frames).lonlat);
    const source = spec.streets.from ?? 'osm';
    if (source !== 'osm' && source !== 'ohm') throw new Error(`streets: "from" is "osm" or "ohm", not "${source}"`);
    const classes = (spec.streets.classes ?? ['motorway', 'trunk', 'primary']).join('|');
    out.streets = { source, id: `${spec.city}-${source}-streets`, query: ql([`way["highway"~"^(${classes})$"](${b});`], 'out geom;') };
  }
  if (spec.builtUp && (spec.builtUp.from ?? 'osm') === 'osm') {
    const b = overpassBox(boxOfLayer(spec.builtUp, frames).lonlat);
    const uses = (spec.builtUp.landuse ?? ['residential', 'commercial', 'retail', 'industrial']).join('|');
    out.builtUp = { source: 'osm', id: `${spec.city}-osm-landuse`, query: ql([`way["landuse"~"^(${uses})$"](${b});`, `relation["landuse"~"^(${uses})$"](${b});`], 'out skel geom;') };
  }
  const byId = (id, what) => {
    const m = /^(node|way|relation)\/(\d+)$/.exec(id);
    if (!m) throw new Error(`${what}: "${id}" is not node/<id>, way/<id> or relation/<id>`);
    return `${m[1]}(${m[2]});`;
  };
  for (const source of ['ohm', 'osm']) {
    const walls = (spec.walls ?? []).flatMap((w) => w.from?.[source] ?? []);
    if (walls.length > 0) out[`walls-${source}`] = { source, id: `${spec.city}-${source}-walls`, query: ql(walls.map((id) => byId(id, 'walls')), 'out geom;', 120) };
    const marks = (spec.landmarks ?? []).filter((l) => l[source]).map((l) => l[source]);
    if (marks.length > 0) out[`landmarks-${source}`] = { source, id: `${spec.city}-${source}-landmarks`, query: ql(marks.map((id) => byId(id, 'landmarks')), 'out center;', 120) };
  }
  const checks = (spec.walls ?? []).filter((w) => w.check?.osm);
  if (checks.length > 0) {
    const b = overpassBox(boxOfLayer({ view: checks[0].check.view }, frames).lonlat);
    out.wallCheck = { source: 'osm', id: `${spec.city}-osm-wall-check`, query: ql([`way["barrier"="city_wall"](${b});`, `way["historic"~"^(citywalls|city_wall)$"](${b});`], 'out geom;', 120) };
  }
  return out;
}

const SOURCE_NAME = { osm: 'OpenStreetMap', ohm: 'OpenHistoricalMap' };

/**
 * The command line of the pipeline; returns its exit code. `argv` is what follows the script's name.
 *   root      the directory that holds cities/<city>.json and receives <city>/, cache/ and out/
 *             (the working directory; `--root` on the command line goes before it)
 *   command   how the build is called there, for the usage line and the head of SOURCES.md
 *   sources   the user's changes to the table of sources, by key and field (lib/sources.mjs)
 *   notes     paragraphs of the user's own for SOURCES.md, set after the table of credits
 */
export async function run(argv, { root = process.cwd(), command = 'build.mjs', sources = {}, notes: paragraphs = [] } = {}) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { offline: { type: 'boolean' }, update: { type: 'boolean' }, preview: { type: 'boolean' }, root: { type: 'string' }, cache: { type: 'string' }, new: { type: 'boolean' }, name: { type: 'string' }, bbox: { type: 'string' }, centre: { type: 'string' }, country: { type: 'string' }, years: { type: 'string' }, wide: { type: 'string' } } });
  const city = positionals[0];
  if (!city || !/^[a-z][a-z0-9-]*$/.test(city)) {
    console.error(`usage: node ${command} <city> [--preview] [--offline] [--update]\n       node ${command} <city> --new --name <Name> --bbox <west,south,east,north> [--country <ISO A3>] [--centre <lon,lat>] [--years 1975,2000,2020] [--wide <west,south,east,north>] [--preview]`);
    return 2;
  }
  const home = resolve(values.root ?? root);
  const LICENCES = licencesWith(sources);
  const specFile = join(home, 'cities', `${city}.json`);
  if (values.new) {
    // A new city: its spec is written once, from the command line, and built as any other.
    if (existsSync(specFile)) {
      console.error(`build: ${specFile} is there already: --new never overwrites a spec`);
      return 2;
    }
    if (!values.name || !values.bbox) {
      console.error('build: --new needs --name and --bbox');
      return 2;
    }
    const made = scaffold({ city, name: values.name, bbox: numbers(values.bbox, 4, '--bbox'), centre: values.centre ? numbers(values.centre, 2, '--centre') : null, country: values.country ?? null, ...(values.years ? { years: numbers(values.years, 0, '--years') } : {}), wide: values.wide ? numbers(values.wide, 4, '--wide') : null });
    writeFileSync(specFile, stringify(made));
    console.log(`wrote cities/${city}.json`);
  }
  if (!existsSync(specFile)) {
    console.error(`build: no spec ${specFile}`);
    return 2;
  }
  const spec = JSON.parse(readFileSync(specFile, 'utf8'));
  if (spec.city !== city) throw new Error(`build: the spec's city is "${spec.city}", its file is ${city}.json`);
  const cache = values.cache ?? join(home, 'cache');
  const outDir = join(home, city);
  mkdirSync(outDir, { recursive: true });
  const lockFile = join(outDir, 'sources.lock.json');
  const oldLock = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) : { downloads: [] };
  const lock = [];
  const log = (line) => console.log(line);
  const offline = values.offline ?? false;

  /** Notes a download in the lock, once however many layers read it, and holds it to the lock that was. */
  const note = (id, source, request, got, dataDate = null) => {
    if (lock.some((d) => d.id === id && d.request === request)) return got.path;
    const was = oldLock.downloads.find((d) => d.id === id && d.request === request);
    if (was && was.sha256 !== got.sha256 && !values.update) {
      throw new Error(`build: the download "${id}" differs from sources.lock.json (${got.sha256.slice(0, 12)} against ${was.sha256.slice(0, 12)}): the source has changed. Run with --update to take it, or restore the cache.`);
    }
    const same = was && was.sha256 === got.sha256;
    lock.push({ id, source, licence: LICENCES[source].licence, request, bytes: got.bytes, sha256: got.sha256, retrieved: same ? was.retrieved : got.fetched, ...(dataDate || was?.dataDate ? { dataDate: same ? was.dataDate ?? dataDate : dataDate } : {}) });
    return got.path;
  };

  const frames = framesOf(spec);
  const layers = { format: 'cities-geo/1', id: city, name: spec.name, units: 'metres on the plane of each frame: x east, y north of its centre', frames: {} };
  const used = new Map();
  const notes = [];
  const use = (layer, source, what) => used.set(layer, [...(used.get(layer) ?? []), { source, what }]);

  // The region: the country and the land round it.
  if (spec.region) {
    log('region: Natural Earth');
    const files = {};
    const names = { land: ['ne_10m_land', ...(spec.region.minorIslands ? ['ne_10m_minor_islands'] : [])], countries: ['ne_10m_admin_0_countries'], borders: ['ne_10m_admin_0_boundary_lines_land'], rivers: spec.region.rivers ? ['ne_10m_rivers_lake_centerlines'] : [], lakes: spec.region.lakes ? ['ne_10m_lakes'] : [] };
    for (const [key, list] of Object.entries(names)) {
      const paths = [];
      for (const name of list) {
        const got = await naturalEarth({ cache, name, offline, log });
        paths.push(note(name, 'natural-earth', `natural-earth ${NATURAL_EARTH_VERSION} ${name}.geojson`, got, NATURAL_EARTH_VERSION));
      }
      files[key] = key === 'land' ? paths : paths[0];
    }
    const region = buildRegion(spec.region, frames.region, files);
    region.city = { id: city, name: spec.name, at: frames.region.proj.forward(spec.centre).map((v) => Math.round(v)) };
    layers.frames.region = { centre: frames.region.centre, projection: 'laea', box: frames.region.box, lonlat: frames.region.lonlat };
    layers.region = region;
    use('region', 'natural-earth', `Natural Earth ${NATURAL_EARTH_VERSION}, 1:10m: land, countries, boundary lines, rivers and lakes`);
    log(`  land ${region.land.length} rings, ${region.land.reduce((n, f) => n + f.ring.length, 0)} points; ${spec.region.country ?? 'no country'} ${region.country?.rings.length ?? 0} rings; borders ${region.borders?.length ?? 0}; rivers ${region.rivers?.length ?? 0}; lakes ${region.lakes?.length ?? 0}`);
  }

  layers.frames.city = { centre: spec.centre, projection: 'laea', box: frames.city.box, lonlat: frames.city.lonlat.map((v) => Math.round(v * 1e6) / 1e6), views: frames.city.views };
  const cityLayers = {};
  layers.city = cityLayers;

  const requests = requestsOf(spec, frames);
  const answers = {};
  for (const [key, r] of Object.entries(requests)) {
    log(`${key}: ${SOURCE_NAME[r.source]} (Overpass)`);
    const got = await overpass({ cache, id: r.id, query: r.query, ohm: r.source === 'ohm', offline, log });
    const path = note(r.id, r.source, r.query, got, overpassDate(got.path));
    answers[key] = readOverpass(path);
  }

  if (spec.water) {
    const { box, lonlat } = boxOfLayer(spec.water, frames);
    const from = sourcesOf(spec.water, 'osm');
    let waterAt = null;
    if (from.includes('copernicus')) {
      const tiles = [];
      const seas = [];
      for (const [lon, lat] of tilesOf(lonlat)) {
        const got = await copernicusWaterMask({ cache, lon, lat, offline, log });
        if (got) tiles.push(readGeoTiff(readFileSync(note(`copernicus-wbm-${lat}-${lon}`, 'copernicus', got.url, got, '2011-2015'))));
        else seas.push(seaTile(lon, lat));
      }
      waterAt = waterSampler([...tiles, ...seas], spec.water.mask);
    }
    const w = buildWater(spec.water, { ...frames.city, box }, { osm: answers['water-osm'] ?? [], ohm: answers['water-ohm'] ?? [], waterAt });
    cityLayers.water = w.water;
    cityLayers.islands = w.islands;
    cityLayers.rivers = w.rivers;
    const layer = 'city.water, city.islands, city.rivers';
    if (from.includes('osm')) use(layer, 'osm', 'water areas, coastlines and river lines of OpenStreetMap');
    if (from.includes('ohm')) use(layer, 'ohm', `water areas, islets and river lines of OpenHistoricalMap that stand ${spec.water.year === undefined ? 'today' : `in ${spec.water.year}`}`);
    if (from.includes('copernicus')) use(layer, 'copernicus', `the water body mask of the Copernicus DEM GLO-30 (${(spec.water.mask ?? ['ocean', 'lake', 'river']).join(', ')})`);
    notes.push({ layer, name: 'Water', source: '', made: [`every source is filled into one grid of ${spec.water.cell ?? 8} m and its outline traced, so a river mapped in pieces comes out whole`] });
    log(`  water ${w.water.length} rings (${w.water.reduce((n, f) => n + f.ring.length, 0)} points), islands ${w.islands.length}, rivers ${w.rivers.map((r) => `${r.name} ${r.lengthKm} km`).join(', ')}${w.sea ? ', with the sea' : ''}`);
  }

  if (spec.walls) {
    cityLayers.walls = [];
    for (const w of spec.walls) {
      const ways = [];
      const pick = (answer, ids) => {
        for (const id of ids ?? []) {
          const [type, ref] = id.split('/');
          for (const e of answer ?? []) {
            if (e.type !== type || String(e.id) !== ref) continue;
            if (type === 'way') ways.push(...waysOf([e]));
            else for (const m of e.members ?? []) if (m.type === 'way' && m.geometry) ways.push({ id: m.ref, tags: {}, line: m.geometry.map((p) => [p.lon, p.lat]) });
          }
        }
      };
      pick(answers['walls-ohm'], w.from?.ohm);
      pick(answers['walls-osm'], w.from?.osm);
      const checkWays = w.check?.osm ? waysOf(answers.wallCheck ?? [], (t) => new RegExp(w.check.osm.name).test(t.name ?? '')) : [];
      const built = buildWall(w, frames.city, ways, checkWays);
      cityLayers.walls.push(built.wall);
      const from = [w.from?.ohm ? `OpenHistoricalMap ${w.from.ohm.join(', ')}` : null, w.from?.osm ? `OpenStreetMap ${w.from.osm.join(', ')}` : null, w.draw ? `${w.draw.length} stretch(es) drawn by hand` : null].filter(Boolean).join('; ');
      if (w.from?.ohm) use(`city.walls: ${w.id}`, 'ohm', from);
      if (w.from?.osm) use(`city.walls: ${w.id}`, 'osm', from);
      if (!w.from?.ohm && !w.from?.osm) use(`city.walls: ${w.id}`, 'own', from);
      const checked = built.check ? `checked against ${built.check.ways} stretches of "${w.check.osm.name}" in OpenStreetMap (${built.check.points} points): they lie a median of ${built.check.median} m from the circuit, 90 % within ${built.check.p90} m, at most ${built.check.max} m` : null;
      notes.push({ layer: `city.walls: ${w.id}`, name: w.name, source: w.source ?? '', made: [from, ...built.notes, ...(w.draw ?? []).map((d) => `drawn by hand: ${d.what} (${d.source})`), checked].filter(Boolean) });
      log(`  wall ${w.id}: ${built.wall.lengthKm} km, ${built.wall.areaHa} ha, ${built.wall.ring.length} points${built.notes.length ? `; ${built.notes.join(', ')}` : ''}${checked ? `; ${checked}` : ''}`);
    }
  }

  if (spec.relief) {
    const { box, lonlat } = boxOfLayer(spec.relief, frames);
    // The tiles are read a little past the box, so that the smoothing has ground to work on at its edge.
    const margin = (spec.relief.smooth ?? 90) * 3;
    const reliefBox = [box[0] - margin, box[1] - margin, box[2] + margin, box[3] + margin];
    const tiles = [];
    if (spec.relief.hgt) {
      for (const file of spec.relief.hgt) tiles.push(readHgt(readFileSync(join(home, file)), file));
      use('city.relief', 'srtm', 'SRTM .hgt files given by hand');
    } else {
      for (const [lon, lat] of tilesOf(unprojectBox(frames.city.proj, reliefBox))) {
        const got = await copernicusTile({ cache, lon, lat, offline, log });
        if (!got) continue;
        tiles.push(readGeoTiff(readFileSync(note(`copernicus-glo30-${lat}-${lon}`, 'copernicus', got.url, got, '2011-2015'))));
      }
      use('city.relief', 'copernicus', `Copernicus DEM GLO-30 (a surface model: it includes buildings), smoothed over ${spec.relief.smooth ?? 90} m`);
    }
    void lonlat;
    let limit = null;
    if (spec.relief.within) {
      const ring = cityLayers.walls?.find((w) => w.id === spec.relief.within.wall)?.ring;
      if (!ring) throw new Error(`relief: "within" names the wall "${spec.relief.within.wall}", which the spec does not have`);
      limit = { ring, margin: spec.relief.within.margin ?? 0 };
      notes.push({ layer: 'city.relief', name: 'Hills', source: '', made: [`each hill is the ground that falls away from its summit, down to its floor and out to its reach; none reaches more than ${limit.margin} m outside the wall "${spec.relief.within.wall}", which ends the hills that are spurs of higher ground`] });
    }
    const relief = buildRelief(spec.relief, { ...frames.city, reliefBox }, sampler(tiles), limit);
    cityLayers.relief = relief;
    log(`  relief: contours ${relief.contours.map((c) => `${c.height} m (${c.rings.length + c.lines.length})`).join(', ')}; hills ${relief.hills.map((h) => `${h.id} ${h.height} m ${h.areaHa} ha`).join(', ')}`);
  }

  if (spec.terrain) {
    const t = spec.terrain;
    const { box } = boxOfLayer(t, frames);
    const plan = terrainPlan(t, box);
    const coast = t.coast?.from ?? 'copernicus';
    if (coast !== 'copernicus' && coast !== 'awmc') throw new Error(`terrain: "coast.from" is "copernicus" or "awmc", not "${coast}"`);
    const lakesWanted = t.lakes !== false;
    // The tiles are read by the scale: reduced in blocks, so that a cell is the mean of the ground it covers.
    const heights = [];
    const seas = [];
    const lakes = [];
    const open = [];
    let read = { factor: 1, samples: 1 };
    let fine = { factor: 1, samples: 1 };
    for (const [lon, lat] of tilesOf(unprojectBox(frames.city.proj, plan.reach))) {
      const got = await copernicusTile({ cache, lon, lat, offline, log });
      if (got) {
        const tile = readGeoTiff(readFileSync(note(`copernicus-glo30-${lat}-${lon}`, 'copernicus', got.url, got, '2011-2015')));
        read = scaleOf(tile, plan.cell);
        heights.push(reduceTile(tile, read.factor));
      }
      if (coast !== 'copernicus' && !lakesWanted) continue;
      const mask = await copernicusWaterMask({ cache, lon, lat, offline, log });
      if (!mask) {
        // No mask where there is no land at all: a degree of open sea, read after every tile there is.
        open.push(waterShare(seaTile(lon, lat), ['ocean']));
        continue;
      }
      const tile = readGeoTiff(readFileSync(note(`copernicus-wbm-${lat}-${lon}`, 'copernicus', mask.url, mask, '2011-2015')));
      fine = scaleOf(tile, plan.waterCell);
      if (coast === 'copernicus') seas.push(reduceTile(waterShare(tile, ['ocean']), fine.factor));
      if (lakesWanted) lakes.push(reduceTile(waterShare(tile, ['lake']), fine.factor));
    }
    let seaRings = null;
    if (coast === 'awmc') {
      if (!t.coast.file) throw new Error('terrain: a coast from "awmc" names its "file", the path of a GeoJSON file of open water in the repository of the Ancient World Mapping Center');
      const got = await awmc({ cache, file: t.coast.file, offline, log });
      const path = note(`awmc-${awmcName(t.coast.file)}`, 'awmc', got.url, got, 'undated: the coast as the Center reconstructs it for antiquity');
      const lonlat = unprojectBox(frames.city.proj, plan.reach);
      seaRings = [];
      for (const f of featuresOf(path)) {
        const polys = f.geometry?.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates : [];
        for (const poly of polys) {
          const rings = poly.map((r) => r.slice(0, -1)).filter((r) => r.length >= 3);
          if (rings.length === 0) continue;
          const xs = rings[0].map((p) => p[0]);
          const ys = rings[0].map((p) => p[1]);
          const [x0, y0, x1, y1] = [xs.reduce((a, b) => Math.min(a, b)), ys.reduce((a, b) => Math.min(a, b)), xs.reduce((a, b) => Math.max(a, b)), ys.reduce((a, b) => Math.max(a, b))];
          if (x0 <= lonlat[2] && x1 >= lonlat[0] && y0 <= lonlat[3] && y1 >= lonlat[1]) seaRings.push(rings);
        }
      }
      if (seaRings.length === 0) throw new Error(`terrain: ${t.coast.file} has no water in the view: another file of the same repository covers this sea`);
    }
    const riversFrom = t.rivers ? t.rivers.from ?? 'osm' : null;
    const terrain = buildTerrain(t, { ...frames.city, box }, {
      heightAt: sampler(heights),
      heightSamples: read.samples,
      seaAt: coast === 'copernicus' ? sampler([...seas, ...open], 0) : null,
      seaRings,
      lakeAt: lakesWanted ? sampler(lakes, 0) : null,
      waterSamples: fine.samples,
      [riversFrom ?? 'osm']: answers['terrain-rivers'] ?? [],
    });
    for (const line of terrain.lost) log(`  terrain: left out, it could not be drawn without crossing itself: ${line}`);
    const { lost, ...layer } = terrain;
    void lost;
    cityLayers.terrain = { ...(t.view ? { view: t.view } : {}), ...layer };
    const blocks = read.factor > 1 ? `read in blocks of ${read.factor} by ${read.factor} samples, ` : '';
    use('city.terrain', 'copernicus', `Copernicus DEM GLO-30 (a surface model: it includes buildings and trees), ${blocks}as the mean height of each cell of ${plan.cell} m, smoothed over ${plan.smooth} m: the ground in bands at ${terrain.levels.join(', ')} m${lakesWanted ? '; the lakes from its water body mask' : ''}${coast === 'copernicus' ? '; the coast from the same mask (the sea of 2011-2015)' : ''}`);
    if (coast === 'awmc') use('city.terrain', 'awmc', `the coast: the open water of the Ancient World Mapping Center, \`${t.coast.file}\` at commit ${AWMC_COMMIT.slice(0, 12)}`);
    if (riversFrom) use('city.terrain', riversFrom, `river lines of ${SOURCE_NAME[riversFrom]}, by name: ${terrain.rivers.map((r) => r.name).join(', ') || 'none found'}`);
    notes.push({
      layer: 'city.terrain',
      name: 'Terrain',
      source: t.source ?? '',
      made: [
        'the heights are those of today (the model was measured in 2011-2015), whatever the age of the coast and the rivers drawn with them',
        'no band comes nearer the sea than about a cell, so a cliff keeps a rim of the land below it',
        ...(coast === 'copernicus' ? ['the coast is that of 2011-2015'] : []),
        ...(t.coast?.note ? [t.coast.note] : []),
        ...(t.lakes?.skip?.length ? [`${t.lakes.skip.length} lake(s) of the water mask left out by the spec${t.lakes.note ? `: ${t.lakes.note}` : ''}`] : []),
      ],
    });
    log(`  terrain: cell ${plan.cell} m; land ${terrain.land.length} ring(s); bands ${terrain.levels.map((level) => `${level} m (${terrain.bands.filter((b) => b.height === level).length})`).join(', ')}; lakes ${terrain.lakes.length}; rivers ${terrain.rivers.map((r) => `${r.name} ${r.lengthKm} km`).join(', ') || 'none'}; ${[...terrain.land, ...terrain.bands, ...terrain.lakes].reduce((n, f) => n + f.ring.length, 0)} points`);
  }

  if (spec.streets) {
    const { box } = boxOfLayer(spec.streets, frames);
    const source = spec.streets.from ?? 'osm';
    cityLayers.streets = buildStreets(spec.streets, { ...frames.city, box }, answers.streets);
    use('city.streets', source, `highways of ${SOURCE_NAME[source]}: ${(spec.streets.classes ?? ['motorway', 'trunk', 'primary']).join(', ')}${source === 'ohm' ? ', each with the years it stood' : ''}`);
    log(`  streets ${cityLayers.streets.length}, ${Math.round(cityLayers.streets.reduce((sum, x) => sum + x.lengthKm, 0))} km`);
  }

  const builtUp = [];
  if (spec.builtUp) {
    const { box, lonlat } = boxOfLayer(spec.builtUp, frames);
    const source = spec.builtUp.from ?? 'osm';
    const closed = `gaps under ${2 * (spec.builtUp.bridge ?? 250)} m closed, the piece round the centre traced`;
    const entry = (id, year, { ring, pieces }) => builtUp.push({ id, ...(year === null ? {} : { year }), areaHa: Math.round(area(ring) / 1000) / 10, ring, pieces });
    const today = (built) => entry('built-up', null, built);
    if (source === 'ghsl') {
      for (const year of spec.builtUp.years ?? [2020]) {
        const rasters = [];
        for (const { row, col } of ghslTilesOf(lonlat)) {
          const got = await ghslTile({ cache, year, row, col, offline, log });
          if (!got) continue;
          const path = note(`ghsl-built-s-${year}-r${row}-c${col}`, 'ghsl', ghslUrl(year, row, col), got, `${year} (release ${GHSL_RELEASE})`);
          const raster = readRaster(unzip(readFileSync(path), /\.tif$/i), { window: mollweideBox(lonlat) });
          if (raster && raster.w >= 2 && raster.h >= 2) rasters.push(raster);
        }
        entry(`built-${year}`, year, buildBuiltUp(spec.builtUp, { ...frames.city, box }, { shareAt: builtShare(rasters) }));
      }
      builtUp.sort((a, b) => a.year - b.year);
      use('city.builtUp', 'ghsl', `the built-up surface of the Global Human Settlement Layer (GHS-BUILT-S ${GHSL_RELEASE}, 100 m) of ${builtUp.map((b) => b.year).join(', ')}: ground built on from ${Math.round((spec.builtUp.share ?? 0.2) * 100)} % up, ${closed}`);
    } else if (source === 'osm') {
      today(buildBuiltUp(spec.builtUp, { ...frames.city, box }, { areas: areasOfAnswer(answers.builtUp) }));
      use('city.builtUp', 'osm', `land use of OpenStreetMap (${(spec.builtUp.landuse ?? ['residential', 'commercial', 'retail', 'industrial']).join(', ')}), ${closed}`);
    } else if (source === 'natural-earth') {
      const got = await naturalEarth({ cache, name: 'ne_10m_urban_areas', offline, log });
      const path = note('ne_10m_urban_areas', 'natural-earth', `natural-earth ${NATURAL_EARTH_VERSION} ne_10m_urban_areas.geojson`, got, NATURAL_EARTH_VERSION);
      today(buildBuiltUp(spec.builtUp, { ...frames.city, box }, { areas: urbanAreas(path, lonlat) }));
      use('city.builtUp', 'natural-earth', `urban areas of Natural Earth ${NATURAL_EARTH_VERSION}, 1:10m (from satellite images of 2002-2003, a sample every 500 m): ${closed}`);
    } else throw new Error(`builtUp: "from" is "ghsl", "osm" or "natural-earth", not "${source}"`);
    cityLayers.builtUp = builtUp;
    log(`  built-up: ${builtUp.map((b) => `${b.year ?? 'today'} ${b.areaHa} ha, ${b.ring.length} points, ${b.pieces.length} other piece(s)`).join('; ')}`);
  }

  if (spec.epochs) {
    cityLayers.epochs = buildEpochs(spec.epochs, frames.city, { walls: cityLayers.walls ?? [], hills: cityLayers.relief?.hills ?? [], builtUp, points: spec.morphPoints ?? 160 });
    for (const e of spec.epochs) notes.push({ layer: `city.epochs: ${e.id}`, name: `${e.name} (${e.year < 0 ? `${-e.year} BC` : `AD ${e.year}`})`, source: e.source ?? '', made: [e.outline.wall ? `the circuit of the wall "${e.outline.wall}"` : e.outline.hill ? `the foot of the hill "${e.outline.hill}" (city.relief)` : e.outline.builtUp ? `the built-up land${e.outline.builtUp === true ? '' : ` of ${e.outline.builtUp}`} (city.builtUp)` : `drawn by hand through ${e.outline.points.length} points`, ...(e.note ? [e.note] : [])] });
    for (const e of spec.epochs) if (e.outline.points) use(`city.epochs: ${e.id}`, 'own', 'drawn by hand from the sources named below');
    log(`  epochs: ${cityLayers.epochs.map((e) => `${e.id} ${e.year} ${e.areaHa} ha`).join(', ')}`);
  }

  if (spec.landmarks) {
    // A landmark stands where the spec says (`at`), or at the middle of the thing a source maps (`ohm`, `osm`: an element's id).
    const placed = spec.landmarks.map((l) => {
      const source = l.ohm ? 'ohm' : l.osm ? 'osm' : null;
      if (!source) return l;
      const [type, ref] = l[source].split('/');
      const element = (answers[`landmarks-${source}`] ?? []).find((e) => e.type === type && String(e.id) === ref);
      const at = element ? centreOf(element) : null;
      if (!at) throw new Error(`landmark ${l.id}: ${SOURCE_NAME[source]} has no ${l[source]}`);
      use(`city.landmarks: ${l.id}`, source, `the middle of ${l[source]}${element.tags?.name ? ` ("${element.tags.name}")` : ''}`);
      return { ...l, at: at.map((v) => Math.round(v * 1e6) / 1e6) };
    });
    cityLayers.landmarks = buildLandmarks(placed, frames.city);
    const byHand = spec.landmarks.filter((l) => !l.ohm && !l.osm);
    if (byHand.length > 0) notes.push({ layer: 'city.landmarks', name: `Landmarks placed by hand: ${byHand.map((l) => l.name).join(', ')}`, source: spec.landmarksSource ?? '', made: [] });
    log(`  landmarks: ${cityLayers.landmarks.map((l) => l.id).join(', ')}`);
  }

  writeFileSync(join(outDir, 'layers.json'), stringify(layers));
  lock.sort((a, b) => (a.id < b.id ? -1 : 1));
  writeFileSync(lockFile, `${JSON.stringify({ format: 'cities-geo-lock/1', city, downloads: lock }, null, 2)}\n`);
  writeFileSync(join(outDir, 'SOURCES.md'), sourcesText(spec, lock, used, notes, { licences: LICENCES, command, paragraphs }));
  const size = readFileSync(join(outDir, 'layers.json')).length;
  log(`wrote ${city}/layers.json (${Math.round(size / 1024)} KB), sources.lock.json (${lock.length} downloads), SOURCES.md`);

  if (values.preview) {
    const { drawPreviews } = await import('./lib/preview.mjs');
    for (const file of await drawPreviews(layers, join(home, 'out', city))) log(`preview ${file}`);
  }
  return 0;
}

/**
 * SOURCES.md of a city: the credit lines for a film's description, the source of each layer, what was
 * drawn by hand, the downloads. `paragraphs` are the user's own, set after the table of credits.
 */
export function sourcesText(spec, lock, used, notes, { licences: LICENCES = licencesWith(), command = 'build.mjs', paragraphs = [] } = {}) {
  const sources = [...new Set([...used.values()].flat().map((u) => u.source))].filter((s) => s !== 'own');
  const order = ['osm', 'awmc', 'copernicus', 'ohm', 'natural-earth', 'srtm'];

  sources.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const lines = [
    `# ${spec.name}: the sources of its map`,
    '',
    `Written by \`${command} ${spec.city}\` from \`cities/${spec.city}.json\`. Do not edit: change the spec and build again.`,
    '',
    '## Credits for the description of a film',
    '',
    'A film that shows these layers carries these lines in its description (those under "Map data" must be there; the last line is a courtesy):',
    '',
    '```',
    'Map data:',
    ...sources.filter((s) => LICENCES[s].required).map((s) => LICENCES[s].credit),
    ...(sources.some((s) => !LICENCES[s].required) ? [sources.filter((s) => !LICENCES[s].required).map((s) => (LICENCES[s].credit.endsWith('.') ? LICENCES[s].credit : `${LICENCES[s].credit}.`)).join(' ')] : []),
    '```',
    '',
    '| Source | Licence | Credit | Terms |',
    '|---|---|---|---|',
    ...sources.map((s) => `| ${LICENCES[s].name} | ${LICENCES[s].licence} | ${LICENCES[s].required ? 'required' : 'not required'}: ${LICENCES[s].credit} | ${LICENCES[s].url} |`),
    '',
    ...paragraphs.flatMap((p) => [p, '']),
    '## Where each layer comes from',
    '',
    '| Layer | Source | How |',
    '|---|---|---|',
    ...[...used.entries()].flatMap(([layer, list]) => list.map((u) => `| \`${layer}\` | ${LICENCES[u.source].name} | ${u.what} |`)),
    '',
  ];
  if (notes.length > 0) {
    lines.push('## What rests on which source, and what was drawn by hand', '');
    for (const n of notes) {
      lines.push(`- **${n.name}** (\`${n.layer}\`)${n.source ? `: ${n.source}` : ''}`);
      for (const m of n.made) lines.push(`  - ${m}`);
    }
    lines.push('');
  }
  lines.push('## The downloads', '', 'The pipeline fetched these; `sources.lock.json` holds the request and the SHA-256 of each. The files themselves are in `cache/`, which is not committed.', '', '| Download | Source | Size | SHA-256 | Data of |', '|---|---|---|---|---|');
  for (const d of lock) lines.push(`| \`${d.id}\` | ${LICENCES[d.source].name} | ${d.bytes} | \`${d.sha256.slice(0, 16)}\` | ${d.dataDate ?? ''} |`);
  lines.push('');
  return lines.join('\n');
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
