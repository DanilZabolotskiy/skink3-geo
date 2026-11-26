#!/usr/bin/env node
// A flat map of the world with the outline of every country, from public-domain data: the whole world on the Equal
// Earth projection, or the countries of a box round a place.
//
//   node world.mjs [--map world] [--root <dir>] [--scale 50] [--preview]      the whole world: builds <root>/world/
//   node world.mjs --map <name> --centre=<lon>                                 the whole world round another meridian
//   node world.mjs --map <name> --bbox <west,south,east,north> [--centre <lon,lat>] [--scale 10]
//                                                                             the countries of a box: <root>/<name>/
//   --name <Name>       what the map is called (the whole world: "The world")
//   --detail <m>        the thinning, in metres (half a unit of a stage of 1920 by 1080 that the map covers)
//   --min-area <km2>    an island smaller than this is left out; a country keeps its largest piece however small
//   --lakes <rank>      the lakes of Natural Earth's scalerank up to this (0: the largest alone); none without it
//   --lanes             the sea lanes of a global shipping network (Oak Ridge National Laboratory's)
//   --features <file>   named places and lines, a JSON file (lib/worldlines.mjs, checkWorldFeatures, says what it holds)
//   --heights           the heights of the land and the depths of the sea as a grid (ETOPO1, NOAA)
//   --heights-cell <m>  the metres between the points of that grid (the box's longer side cut into 600)
//   --shallows <m,...>  the sea above these depths as regions (--shallows 50,200)
//   --divisions <ids>   the first-level divisions (states, provinces) of these countries, by the countries' ids
//                       (--divisions deu,aus), or of every country of the map (all): Natural Earth's 1:10m admin-1,
//                       thinned with the countries; at --scale 10 alone
//   --rivers <list>     the rivers of Natural Earth's centerlines: a rank, those of its scalerank and below (--rivers 4),
//                       and names (--rivers Danube,Rhine), or both
//   --towns <people>    the towns of Natural Earth's populated places with at least that many people, as points
//   --water-risk <ind>  an indicator of WRI's Aqueduct 4.0 by category, as regions (--water-risk bws: baseline water
//                       stress); its credit is required
//   --seafloor-age <my> the age of the ocean floor in bands between these ages, millions of years (--seafloor-age
//                       20,40,60,80,100,140): EarthByte's age grid (Seton et al. 2020); its credit is required
//   --sediments <list>  the sediments of the sea floor by kind: all, or groups (--sediments carbonate=5+9+13,other=rest):
//                       EarthByte's seafloor lithology (Dutkiewicz et al. 2015); its credit is required
//   --seafloor-cell <m> the cells the sea floor is traced on, in metres (the box's longer side cut into 1600)
//   --offline           from the cache alone: nothing is fetched
//   --update            takes downloads that differ from the lock
//
// A box whose west is east of its east crosses the 180th meridian (--bbox 160,-30,-170,10). A negative value of an
// option is given with "=" (--centre=-150), so that it is not read as an option.
//
// It writes, into <root>/<map>/ (lib/world.mjs says how the layers are made):
//   world.json          the map, in metres on the plane of its frame (README.md, "A world map")
//   sources.lock.json   every download: its request, size and SHA-256
//   SOURCES.md          the credit a film's description carries, and what each layer is made of
// The output is a pure function of the options, which world.json records, and the downloads: the same lock gives
// the same bytes. A download that differs from the lock stops the build, unless --update is given.
//
// A project calls `runWorld(argv, { root, command })` from a script of its own, so that its maps and cache stay
// with it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { overpass, sha256 } from './lib/fetch.mjs';
import { elementLines } from './lib/layers.mjs';
import { overpassDate, readOverpass } from './lib/osm.mjs';
import { AQUEDUCT, aqueduct, creditOf, etopo, etopoRequest, licencesWith, NATURAL_EARTH_VERSION, naturalEarth, SEAFLOOR_AGE, SEAFLOOR_LITHOLOGY, seafloorAge, seafloorLithology, SHIPPING_LANES_COMMIT, shippingLanes } from './lib/sources.mjs';
import { buildWorldAge, buildWorldSediments, degreeGridOf, seafloorCell, sedimentGroups } from './lib/seafloor.mjs';
import { buildWorld, worldSources } from './lib/world.mjs';
import { buildRivers, buildTowns, buildWaterRisk, readWaterRisk, riverPicks } from './lib/worldthemes.mjs';
import { buildHeights, heightsPlan, joinGrids, readEsriAscii } from './lib/worldheights.mjs';
import { buildLanes, buildWorldFeatures, checkWorldFeatures } from './lib/worldlines.mjs';

const UNITS = 'metres on the plane of the frame: x east, y north of its centre';

/** world.json as it is written: an entry of a layer on a line of its own. */
export function worldText(world) {
  const parts = Object.entries(world).map(([k, v]) => {
    if (Array.isArray(v)) return v.length === 0 ? `  ${JSON.stringify(k)}: []` : `  ${JSON.stringify(k)}: [\n${v.map((e) => `    ${JSON.stringify(e)}`).join(',\n')}\n  ]`;
    return `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`;
  });
  return `{\n${parts.join(',\n')}\n}\n`;
}

/** SOURCES.md of a world build. */
export function worldSourcesText(world, lock, { command = 'world.mjs', licences = licencesWith() } = {}) {
  const used = [...new Set(lock.map((d) => d.source))].map((key) => ({ ...licences[key], credit: creditOf(licences[key], key, lock) }));
  const m = world.made;
  const scale = `Natural Earth ${NATURAL_EARTH_VERSION}, 1:${m.scale}m`;
  const frame = world.frame.projection === 'equal-earth' ? `the whole world on the Equal Earth projection${m.centre ? `, centred on the meridian ${m.centre[0]}°` : ''}` : `the box ${m.bbox.join(', ')} on the azimuthal equal-area plane round ${m.centre.join(', ')}`;
  const cut = world.frame.projection === 'equal-earth' ? '' : ', cut to the box';
  return [
    `# ${world.name}: the sources of its layers`,
    '',
    `Written by \`${command}\`. Do not edit: build again with other options.`,
    '',
    '## Credits for the description of a film',
    '',
    used.some((l) => l.required)
      ? 'A film that shows these layers carries these lines in its description (where a licence requires its credit, that line is not left out):'
      : 'A film that shows these layers may carry this line in its description (a courtesy: the data is in the public domain):',
    '',
    '```',
    ...used.map((l) => l.credit).filter((c) => c !== ''),
    '```',
    '',
    '| Source | Licence | Credit | Terms |',
    '|---|---|---|---|',
    ...used.map((l) => `| ${l.name} | ${l.licence} | ${l.required ? 'required' : 'not required'}: ${l.credit} | ${l.url} |`),
    '',
    '## What each layer is made of',
    '',
    `The map shows ${frame}, in metres.`,
    '',
    '| Layer | Source | How |',
    '|---|---|---|',
    `| \`countries\` | ${scale} admin-0 countries | thinned together to ${m.detail} m, so neighbours keep one border${cut}; islands under ${m.minArea} km² left out, but every country keeps its largest piece${world.stats.mended > 0 ? `; ${world.stats.mended} point(s) where the data crossed itself taken out` : ''} |`,
    `| \`land\`, \`gaps\` | the same countries as one | the coast: the edges of the countries that no neighbour shares; the gaps are the water inside the land that no country holds |`,
    `| \`boundaries\` | the same countries | the edges two countries share, each border once |`,
    ...(m.lakes == null ? [] : [`| \`lakes\` | ${scale} lakes | the lakes of rank ${m.lakes} and below, thinned to ${m.detail} m${cut}; lakes under ${m.minArea} km² left out |`]),
    ...(world.lanes ? [`| \`lanes\` | ${licences['ornl-lanes'].name} | the links of the network joined into one lane where two of the same frequency and name meet end to end and no third meets them, thinned to ${m.detail} m${cut}; ${world.lanes.length} lanes |`] : []),
    ...(world.places ?? []).map((p) => `| \`places\`: \`${p.id}\` | ${p.kind === 'place' ? 'given by hand' : `Natural Earth ${NATURAL_EARTH_VERSION}, 1:10m ${p.kind}s`} | ${p.name}, at ${p.lonlat.map((v) => Math.round(v * 1e4) / 1e4).join(', ')} |`),
    ...(world.lines ?? []).map((l) => `| \`lines\`: \`${l.id}\` | ${l.kind === 'mapped' ? 'OpenStreetMap' : l.kind === 'great' ? 'the great circle between two places' : 'drawn through places by hand'} | ${l.name}${l.approximate ? ' (approximate)' : ''}, ${l.lengthKm} km: ${l.source} |`),
    ...(world.heights ? [`| \`heights\` | ${licences.etopo.name} | a sample every ${m.heights.stride} arc-minutes, read between samples onto a point every ${m.heights.cell} m of the plane; metres above the sea (the sea floor below 0) |`] : []),
    ...(world.shallows ?? []).map((sh) => `| \`shallows\`: \`${sh.id}\` | ${licences.etopo.name} | the ground above ${sh.depth} m below the sea, the contour of the heights there, thinned to ${m.detail} m |`),
    ...(world.divisions ? [`| \`divisions\`, \`divisionBorders\` | Natural Earth ${NATURAL_EARTH_VERSION}, 1:10m admin-1 states and provinces | the first-level divisions of ${m.divisions.join(', ')}, thinned together with the countries, so a division keeps one border with its neighbour and its outer edge with its country${cut}; ${world.divisions.length} divisions |`] : []),
    ...(world.rivers ? [`| \`rivers\` | Natural Earth ${NATURAL_EARTH_VERSION}, 1:${m.scale}m rivers and lake centerlines | ${[m.rivers.rank === null ? '' : `the rivers of rank ${m.rivers.rank} and below`, m.rivers.names.length > 0 ? `by name: ${m.rivers.names.join(', ')}` : ''].filter((t) => t).join('; ')}; the pieces of a river joined, thinned to ${m.detail} m${cut}; ${world.rivers.length} rivers |`] : []),
    ...(world.towns ? [`| \`towns\` | Natural Earth ${NATURAL_EARTH_VERSION}, 1:10m populated places | the towns of at least ${m.towns} people (their greatest population), the largest first; ${world.towns.length} towns |`] : []),
    ...(world.waterRisk ? [`| \`waterRisk\` | ${licences.aqueduct.name} | the indicator \`${world.waterRisk.indicator}\` by category: its pieces thinned together to ${m.detail} m and each category's made one${cut}; ${world.waterRisk.classes.map((c) => `${c.cat} ${c.label}`).join('; ')} |`] : []),
    ...(world.seafloorAge ? [`| \`seafloorAge\` | ${licences['earthbyte-age'].name} | the age of the crust in bands (${m.seafloor.ageLevels.join(', ')} million years), each cell of ${m.seafloor.cell} m taking the band of the mean of 16 points across it, traced along the cells and thinned together to ${m.seafloor.tol} m; ${world.seafloorAge.map((b) => b.id).join(', ')} |`] : []),
    ...(world.sediments ? [`| \`sediments\` | ${licences['earthbyte-lithology'].name} | the kinds of sediment, grouped (${world.sediments.map((g) => `${g.id}: ${g.codes.join('+')}`).join('; ')}), each cell of ${m.seafloor.cell} m taking the group most of its points have, traced along the cells and thinned together to ${m.seafloor.tol} m |`] : []),
    '',
    '## The downloads',
    '',
    'The build fetched these; `sources.lock.json` holds the request and the SHA-256 of each. The files themselves are in `cache/`, which is not committed.',
    '',
    '| Download | Source | Size | SHA-256 | Data of |',
    '|---|---|---|---|---|',
    ...lock.map((d) => `| \`${d.id}\` | ${licences[d.source].name} | ${d.bytes} | \`${d.sha256.slice(0, 16)}\` | ${d.dataDate ?? ''} |`),
    '',
  ].join('\n');
}

const number = (text, name, min, max) => {
  const v = Number(text);
  if (!Number.isFinite(v) || v < min || v > max) throw new Error(`world: ${name} must be a number from ${min} to ${max}, got ${JSON.stringify(text)}`);
  return v;
};
const numbers = (text, n, name) => {
  const list = String(text).split(',').map((v) => Number(v));
  if (list.length !== n || list.some((v) => !Number.isFinite(v))) throw new Error(`world: ${name} takes ${n} numbers separated by commas, got ${JSON.stringify(text)}`);
  return list;
};

/** Builds a world map from argv; returns the exit code. */
export async function runWorld(argv, { root = process.cwd(), command = 'world.mjs' } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      map: { type: 'string' }, name: { type: 'string' }, root: { type: 'string' }, cache: { type: 'string' }, offline: { type: 'boolean' }, update: { type: 'boolean' }, preview: { type: 'boolean' },
      scale: { type: 'string' }, bbox: { type: 'string' }, centre: { type: 'string' }, detail: { type: 'string' }, 'min-area': { type: 'string' }, lakes: { type: 'string' },
      lanes: { type: 'boolean' }, features: { type: 'string' }, heights: { type: 'boolean' }, 'heights-cell': { type: 'string' }, shallows: { type: 'string' },
      divisions: { type: 'string' }, rivers: { type: 'string' }, towns: { type: 'string' }, 'water-risk': { type: 'string' },
      'seafloor-age': { type: 'string' }, sediments: { type: 'string' }, 'seafloor-cell': { type: 'string' },
    },
  });
  const bbox = values.bbox === undefined ? null : numbers(values.bbox, 4, '--bbox');
  // The whole world takes the meridian it is centred on; a box, the middle of its plane.
  let centre = null;
  if (values.centre !== undefined) {
    const list = String(values.centre).split(',').map((v) => Number(v));
    if (!bbox && !(list.length === 1 || (list.length === 2 && list[1] === 0))) throw new Error('world: the whole world is centred on a meridian, --centre <lon>; a centre with a latitude is the middle of a box: give --bbox with it');
    centre = bbox ? numbers(values.centre, 2, '--centre') : [number(list[0], '--centre', -180, 180), 0];
  }
  const map = values.map ?? (bbox ? null : 'world');
  if (!map || !/^[a-z][a-z0-9-]*$/.test(map)) throw new Error(`world: --map names the map in lower case, a-z, 0-9 and "-"${bbox ? ' (a box has no default name)' : ''}, got ${JSON.stringify(values.map)}`);
  const scale = values.scale === undefined ? (bbox ? 10 : 50) : number(values.scale, '--scale', 10, 110);
  const made = {
    scale,
    ...(values.detail === undefined ? {} : { detail: number(values.detail, '--detail', 1, 1e6) }),
    ...(values['min-area'] === undefined ? {} : { minArea: number(values['min-area'], '--min-area', 0, 1e8) }),
    lakes: values.lakes === undefined ? null : number(values.lakes, '--lakes', 0, 12),
    ...(bbox ? { bbox, centre } : centre ? { centre } : {}),
  };
  // The first-level divisions of the countries named by their ids, or of all.
  if (values.divisions !== undefined) {
    const ids = String(values.divisions).split(',').map((v) => v.trim()).filter((v) => v !== '');
    if (ids.length === 0 || !ids.every((id) => id === 'all' || /^[a-z][a-z0-9]{2}$/.test(id))) throw new Error(`world: --divisions takes the ids of countries as the map has them (deu, fra), separated by commas, or all; got ${JSON.stringify(values.divisions)}`);
    if (ids.includes('all') && ids.length > 1) throw new Error('world: --divisions all takes every country of the map; name no others with it');
    made.divisions = ids;
  }
  const names = worldSources(scale, made.lakes != null, made.divisions !== undefined);
  const rivers = values.rivers === undefined ? null : riverPicks(values.rivers);
  const towns = values.towns === undefined ? null : number(values.towns, '--towns', 0, 1e9);
  const waterRisk = values['water-risk'] === undefined ? null : String(values['water-risk']);
  if (waterRisk !== null && !/^[a-z][a-z0-9_]*$/.test(waterRisk)) throw new Error(`world: --water-risk names an indicator of Aqueduct in small letters (bws), got ${JSON.stringify(waterRisk)}`);
  // The sea floor: the age of the crust in bands, the sediments by kind.
  const ageLevels = values['seafloor-age'] === undefined ? null : String(values['seafloor-age']).split(',').map((v) => number(v, '--seafloor-age', 1, 4000));
  if (ageLevels && ageLevels.some((v, k) => k > 0 && v <= ageLevels[k - 1])) throw new Error('world: the ages of --seafloor-age run from the youngest up, each once');
  const sediments = values.sediments === undefined ? null : sedimentGroups(values.sediments);
  if (values['seafloor-cell'] !== undefined && !ageLevels && !sediments) throw new Error('world: --seafloor-cell is the cell of the sea floor: give --seafloor-age or --sediments with it');
  const home = resolve(values.root ?? root);
  // What the map holds beyond its countries: each asked for by an option of its own, none by default.
  let features = null;
  if (values.features !== undefined) {
    const file = resolve(values.features);
    const text = readFileSync(file, 'utf8');
    features = JSON.parse(text);
    checkWorldFeatures(features);
    made.features = { file: basename(file), sha256: sha256(text) };
  }
  const shallows = values.shallows === undefined ? [] : String(values.shallows).split(',').map((v) => number(v, '--shallows', 1, 11000));
  if (values['heights-cell'] !== undefined && !values.heights && shallows.length === 0) throw new Error('world: --heights-cell is the cell of the heights: give --heights or --shallows with it');
  if (shallows.some((v, k) => k > 0 && v <= shallows[k - 1])) throw new Error('world: the depths of --shallows run from the shallowest down, each once');
  if (values.lanes) made.lanes = true;
  const cache = values.cache ?? join(home, 'cache');
  const outDir = join(home, map);
  const lockFile = join(outDir, 'sources.lock.json');
  const oldLock = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) : { downloads: [] };
  const licences = licencesWith();
  const lock = [];
  const log = (line) => console.log(line);
  /** Notes a download in the lock and holds it to the lock that was; gives its path. */
  const note = (id, source, request, got, dataDate) => {
    const was = oldLock.downloads.find((d) => d.id === id && d.request === request);
    if (was && was.sha256 !== got.sha256 && !values.update) {
      throw new Error(`world: the download "${id}" differs from sources.lock.json (${got.sha256.slice(0, 12)} against ${was.sha256.slice(0, 12)}): the source has changed. Run with --update to take it, or restore the cache.`);
    }
    const same = was && was.sha256 === got.sha256;
    lock.push({ id, source, licence: licences[source].licence, request, bytes: got.bytes, sha256: got.sha256, retrieved: same ? was.retrieved : got.fetched, ...(dataDate ? { dataDate: same && was.dataDate ? was.dataDate : dataDate } : {}) });
    return got.path;
  };
  const ne = async (name) => {
    const got = await naturalEarth({ cache, name, offline: values.offline ?? false, log });
    return JSON.parse(readFileSync(note(name, 'natural-earth', `natural-earth ${NATURAL_EARTH_VERSION} ${name}.geojson`, got, NATURAL_EARTH_VERSION), 'utf8'));
  };
  log(`world: ${bbox ? `the countries of ${bbox.join(', ')}` : 'the whole world'}, from Natural Earth 1:${scale}m`);
  const built = buildWorld({ countries: await ne(names.countries), lakes: names.lakes ? await ne(names.lakes) : null, divisions: names.divisions ? await ne(names.divisions) : null }, made);
  const { stats, ...layers } = built;
  const extra = {};
  if (values.lanes) {
    const got = await shippingLanes({ cache, offline: values.offline ?? false, log });
    const path = note('ornl-shipping-lanes', 'ornl-lanes', `geoiq/gc_data ${SHIPPING_LANES_COMMIT} datasets/25.geojson`, got, '2000');
    extra.lanes = buildLanes(JSON.parse(readFileSync(path, 'utf8')), layers.frame, { detail: layers.made.detail });
  }
  if (features) {
    const places = features.places ?? [];
    const ports = places.some((p) => p.port) ? await ne('ne_10m_ports') : null;
    const airports = places.some((p) => p.airport) ? await ne('ne_10m_airports') : null;
    const mapped = {};
    const ids = [...new Set((features.lines ?? []).flatMap((l) => l.from.osm ?? []))];
    if (ids.length > 0) {
      const query = `[out:json][timeout:120];\n(\n${ids.map((id) => `  ${id.replace('/', '(')});`).join('\n')}\n);\nout geom;\n`;
      const got = await overpass({ cache, id: `${map}-osm-lines`, query, offline: values.offline ?? false, log });
      const answer = readOverpass(note(`${map}-osm-lines`, 'osm', query, got, overpassDate(got.path)));
      for (const l of features.lines ?? []) {
        if (!l.from.osm) continue;
        const { lines, missing } = elementLines(answer, l.from.osm);
        if (missing.length > 0) throw new Error(`line ${l.id}: OpenStreetMap has no ${missing.join(', ')}`);
        mapped[l.id] = lines;
      }
    }
    const built2 = buildWorldFeatures(features, layers.frame, { ports, airports, mapped, detail: layers.made.detail });
    extra.places = built2.places;
    extra.lines = built2.lines;
  }
  if (values.heights || shallows.length > 0) {
    const plan = heightsPlan(layers.frame, values['heights-cell'] === undefined ? null : number(values['heights-cell'], '--heights-cell', 100, 1e6));
    const parts = [];
    for (const [k, box] of plan.boxes.entries()) {
      const got = await etopo({ cache, box, stride: plan.stride, part: k + 1, offline: values.offline ?? false, log });
      parts.push(readEsriAscii(readFileSync(note(`etopo1-${plan.stride}m${k > 0 ? `-${k + 1}` : ''}`, 'etopo', etopoRequest(box, plan.stride).url, got, 'ETOPO1 (2009)'), 'utf8')));
    }
    const degrees = parts.length === 2 ? joinGrids(parts[0], parts[1]) : parts[0];
    const h = buildHeights(degrees, layers.frame, { cell: plan.cell, detail: layers.made.detail, minArea: layers.made.minArea * 1e6, shallows });
    made.heights = { cell: plan.cell, stride: plan.stride, ...(shallows.length > 0 ? { shallows } : {}) };
    if (values.heights) extra.heights = h.heights;
    if (shallows.length > 0) extra.shallows = h.shallows;
  }
  if (rivers) {
    made.rivers = rivers;
    extra.rivers = buildRivers(await ne(`ne_${scale}m_rivers_lake_centerlines`), layers.frame, { detail: layers.made.detail, ...rivers });
  }
  if (towns !== null) {
    made.towns = towns;
    extra.towns = buildTowns(await ne('ne_10m_populated_places_simple'), layers.frame, { minPop: towns });
  }
  if (waterRisk !== null) {
    const got = await aqueduct({ cache, offline: values.offline ?? false, log });
    const path = note(AQUEDUCT.id, 'aqueduct', AQUEDUCT.request, got, AQUEDUCT.dataDate);
    log(`  water risk: reading the table ${AQUEDUCT.table} of the archive`);
    const rows = readWaterRisk(readFileSync(path), { indicator: waterRisk, frame: layers.frame, table: AQUEDUCT.table });
    made.waterRisk = waterRisk;
    extra.waterRisk = buildWaterRisk(rows, layers.frame, { detail: layers.made.detail, minArea: layers.made.minArea * 1e6, indicator: waterRisk });
  }
  if (ageLevels || sediments) {
    const cell = values['seafloor-cell'] === undefined ? seafloorCell(layers.frame) : number(values['seafloor-cell'], '--seafloor-cell', 100, 1e6);
    // The cells' stairs are thinned away at one and a half cells.
    const tol = Math.max(layers.made.detail, Math.round(1.5 * cell));
    const minArea = layers.made.minArea * 1e6;
    made.seafloor = { cell, tol, ...(ageLevels ? { ageLevels } : {}), ...(sediments ? { sediments: String(values.sediments) } : {}) };
    if (ageLevels) {
      const got = await seafloorAge({ cache, offline: values.offline ?? false, log });
      log('  sea floor: the age of the crust, in bands');
      extra.seafloorAge = buildWorldAge(degreeGridOf(readFileSync(note(SEAFLOOR_AGE.id, 'earthbyte-age', SEAFLOOR_AGE.request, got, SEAFLOOR_AGE.dataDate))), layers.frame, { levels: ageLevels, cell, tol, minArea });
    }
    if (sediments) {
      const got = await seafloorLithology({ cache, offline: values.offline ?? false, log });
      log('  sea floor: the sediments, by kind');
      extra.sediments = buildWorldSediments(degreeGridOf(readFileSync(note(SEAFLOOR_LITHOLOGY.id, 'earthbyte-lithology', SEAFLOOR_LITHOLOGY.request, got, SEAFLOOR_LITHOLOGY.dataDate))), layers.frame, { groups: sediments, cell, tol, minArea });
    }
  }
  for (const key of ['lanes', 'features', 'heights', 'rivers', 'towns', 'waterRisk', 'seafloor']) if (made[key] !== undefined) layers.made[key] = made[key];
  const world = { format: 'world-geo/1', id: map, name: values.name ?? (bbox ? map : 'The world'), units: UNITS, ...layers, ...extra };
  const count = (rings) => `${rings.length} (${rings.reduce((n, r) => n + r.length, 0)} points)`;
  log(`  countries ${world.countries.length}, ${count(world.countries.flatMap((c) => c.rings))}; land ${count(world.land.map((l) => l.ring))}; gaps ${world.gaps.length}; boundaries ${world.boundaries.length}; lakes ${world.lakes.length}`);
  if (world.lanes) log(`  lanes ${world.lanes.length}, ${count(world.lanes.flatMap((l) => l.lines))}`);
  if (world.places || world.lines) log(`  places ${world.places.length}; lines ${world.lines.map((l) => `${l.id} ${l.lengthKm} km`).join(', ') || 0}`);
  if (world.heights) log(`  heights ${world.heights.cols} by ${world.heights.rows}, a point every ${world.heights.cell} m`);
  if (world.shallows) log(`  shallows ${world.shallows.map((sh) => `${sh.depth} m: ${sh.rings.length} rings`).join('; ')}`);
  if (world.divisions) log(`  divisions ${world.divisions.length}, ${count(world.divisions.flatMap((d) => d.rings))}; their borders ${world.divisionBorders.length}`);
  if (world.rivers) log(`  rivers ${world.rivers.length}: ${world.rivers.slice(0, 12).map((r) => r.name).join(', ')}${world.rivers.length > 12 ? ', ...' : ''}`);
  if (world.towns) log(`  towns ${world.towns.length}`);
  if (world.waterRisk) log(`  water risk (${world.waterRisk.indicator}): ${world.waterRisk.classes.map((c) => `${c.cat} ${count(c.rings)}`).join('; ')}`);
  if (world.seafloorAge) log(`  age of the sea floor: ${world.seafloorAge.map((b) => `${b.id} ${count(b.rings)}`).join('; ')}`);
  if (world.sediments) log(`  sediments: ${world.sediments.map((g) => `${g.id} ${count(g.rings)}`).join('; ')}`);
  if (stats.crossing > 0 || stats.open > 0) log(`  note: ${stats.crossing} ring(s) still cross themselves, ${stats.open} stretch(es) of coast do not close: the data has a fault there`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'world.json'), worldText(world));
  writeFileSync(lockFile, `${JSON.stringify({ format: 'world-geo-lock/1', downloads: lock }, null, 2)}\n`);
  writeFileSync(join(outDir, 'SOURCES.md'), worldSourcesText({ ...world, stats }, lock, { command, licences }));
  log(`wrote ${join(outDir, 'world.json')}`);
  if (values.preview) {
    const { previewWorld } = await import('./lib/preview.mjs');
    const file = await previewWorld(world, join(home, 'out', map));
    log(`preview ${file}`);
  }
  return 0;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runWorld(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
