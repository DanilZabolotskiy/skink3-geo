#!/usr/bin/env node
// A round body for a globe: the polygons of its surface in degrees, from public-domain data.
//
//   node globe.mjs --body earth [--root <dir>] [--scale 50|110] [--preview]   builds <root>/earth/
//   node globe.mjs --body moon [--root <dir>] [--preview]                     builds <root>/moon/
//   --offline        from the cache alone: nothing is fetched
//   --update         takes downloads that differ from the lock
//   --tolerance <deg> --min-area <km2>                                          the thinning, and what is too small to keep
//   --lake-area <km2> --ice-area <km2> --min-pop <n>                            the same for the Earth's lakes, ice and towns
//   --seafloor-age <my,...>  the Earth's ocean floor in bands of age between these ages, millions of years
//                            (--seafloor-age 20,40,60,80,100,140): EarthByte's age grid; its credit is required
//   --depths <m,...>         the Earth's sea in bands of depth between these depths, metres (--depths 200,2000,4000,6000):
//                            ETOPO1
//   --seafloor-cell <deg>    the cells the sea floor is traced on, degrees that divide 90 (0.5); a polygon of it smaller
//                            than two cells at the equator, or than --min-area, is left out
//
// It writes, into <root>/<body>/ (lib/globe.mjs says how the layers are made):
//   globe.json          the layers, in degrees [lon, lat] (README.md, "A globe")
//   sources.lock.json   every download: its request, size and SHA-256
//   SOURCES.md          the credit a film's description carries, and what each layer is made of
// The output is a pure function of the options, which globe.json records, and the downloads: the same
// lock gives the same bytes. A download that differs from the lock stops the build, unless --update is given.
//
// A project calls `runGlobe(argv, { root, command })` from a script of its own, so that its layers and
// cache stay with it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { download } from './lib/fetch.mjs';
import { BODIES, buildEarth, buildMoon, earthSources, GLOBE_DEFAULTS, MOON_MARIA } from './lib/globe.mjs';
import { readShapefile } from './lib/shapefile.mjs';
import { buildGlobeBands, degreeGridOf, nearestAt } from './lib/seafloor.mjs';
import { etopo, etopoRequest, licencesWith, NATURAL_EARTH_VERSION, naturalEarth, SEAFLOOR_AGE, seafloorAge } from './lib/sources.mjs';
import { readEsriAscii } from './lib/worldheights.mjs';
import { unzip } from './lib/zip.mjs';

/** globe.json as it is written: an entry of a layer on a line of its own. */
export function globeText(globe) {
  const list = (key, entries, pad) =>
    entries.length === 0 ? `${pad}${JSON.stringify(key)}: []` : `${pad}${JSON.stringify(key)}: [\n${entries.map((e) => `${pad}  ${JSON.stringify(e)}`).join(',\n')}\n${pad}]`;
  const parts = Object.entries(globe).map(([k, v]) => {
    if (k === 'layers') return `  "layers": {\n${Object.entries(v).map(([name, entries]) => list(name, entries, '    ')).join(',\n')}\n  }`;
    if (Array.isArray(v)) return list(k, v, '  ');
    return `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`;
  });
  return `{\n${parts.join(',\n')}\n}\n`;
}

/** The rows of SOURCES.md that say what each layer of a body is made of. */
function layerRows(globe, licences = licencesWith()) {
  const m = globe.made;
  if (globe.body === 'moon') {
    return [`| \`maria\` | LROC Global Mare Boundaries (Nelson et al. 2014), digitised from LROC WAC mosaics, IAU Moon 2000 | thinned on the sphere to ${m.tolerance}° of arc; maria and islands in them under ${m.minArea} km² left out |`];
  }
  const bands = (kind) => Object.keys(globe.layers).filter((k) => k.startsWith(`${kind}-`));
  const traced = (o) => `each cell of ${o.cell}° taking the band of the mean of 16 points across it, traced along the cells in four lunes of 90° of longitude (a band is parted at -90°, 0°, 90° and 180°), thinned together to ${Math.max(m.tolerance, 2 * o.cell)}° of arc; polygons under ${o.minArea} km² left out`;
  return [
    ...(m.depths ? [`| ${bands('depth').map((k) => `\`${k}\``).join(', ')} | ${licences.etopo.name} | the depth of the sea in bands (${m.depths.levels.join(', ')} m), a sample every ${m.depths.stride} arc-minutes, ${traced(m.depths)} |`] : []),
    ...(m.seafloorAge ? [`| ${bands('age').map((k) => `\`${k}\``).join(', ')} | ${licences['earthbyte-age'].name} | the age of the crust in bands (${m.seafloorAge.levels.join(', ')} million years), ${traced(m.seafloorAge)} |`] : []),
    `| \`land\` | Natural Earth ${NATURAL_EARTH_VERSION}, 1:${m.scale}m land | made whole on the sphere (the cut along the south pole and down the 180th meridian taken out), thinned to ${m.tolerance}° of arc, polygons under ${m.minArea} km² left out |`,
    `| \`lakes\` | Natural Earth ${NATURAL_EARTH_VERSION}, 1:${m.scale}m lakes | as the land; lakes under ${m.lakeArea} km² left out |`,
    `| \`ice\` | Natural Earth ${NATURAL_EARTH_VERSION}, 1:${m.scale}m glaciated areas and 1:50m Antarctic ice shelves | as the land; ice under ${m.iceArea} km² left out |`,
    `| \`places\` | Natural Earth ${NATURAL_EARTH_VERSION}, 1:10m populated places | the towns of at least ${m.minPop} people (their greatest population), the largest first |`,
  ];
}

/** SOURCES.md of a globe build. */
export function globeSourcesText(globe, lock, { command = 'globe.mjs', licences = licencesWith() } = {}) {
  const used = [...new Set(lock.map((d) => d.source))].map((key) => licences[key]);
  const required = used.some((l) => l.required);
  return [
    `# ${globe.name}: the sources of its layers`,
    '',
    `Written by \`${command}\`. Do not edit: build again with other options.`,
    '',
    '## Credits for the description of a film',
    '',
    required
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
    '| Layer | Source | How |',
    '|---|---|---|',
    ...layerRows(globe, licences),
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
  if (!Number.isFinite(v) || v < min || v > max) throw new Error(`globe: ${name} must be a number from ${min} to ${max}, got ${JSON.stringify(text)}`);
  return v;
};

const UNITS = 'degrees [longitude east, latitude north]; seen from outside, outer rings run counter-clockwise and holes clockwise';

/** The command line of the globe build; returns its exit code. */
export async function runGlobe(argv, { root = process.cwd(), command = 'globe.mjs' } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      body: { type: 'string' }, root: { type: 'string' }, cache: { type: 'string' }, offline: { type: 'boolean' }, update: { type: 'boolean' }, preview: { type: 'boolean' },
      scale: { type: 'string' }, tolerance: { type: 'string' }, 'min-area': { type: 'string' }, 'lake-area': { type: 'string' }, 'ice-area': { type: 'string' }, 'min-pop': { type: 'string' },
      'seafloor-age': { type: 'string' }, depths: { type: 'string' }, 'seafloor-cell': { type: 'string' },
    },
  });
  const body = values.body ?? 'earth';
  if (!Object.hasOwn(BODIES, body)) throw new Error(`globe: --body is one of ${Object.keys(BODIES).join(', ')}, got ${JSON.stringify(body)}`);
  if (body === 'moon') {
    for (const k of ['scale', 'lake-area', 'ice-area', 'min-pop', 'seafloor-age', 'depths', 'seafloor-cell']) if (values[k] !== undefined) throw new Error(`globe: --${k} is an option of the Earth; the Moon has its maria alone`);
  }
  const D = GLOBE_DEFAULTS[body];
  const opt = (key, name, min, max) => (values[name] === undefined ? D[key] : number(values[name], `--${name}`, min, max));
  const made =
    body === 'earth'
      ? { scale: opt('scale', 'scale', 50, 110), tolerance: opt('tolerance', 'tolerance', 0, 5), minArea: opt('minArea', 'min-area', 0, 1e7), lakeArea: opt('lakeArea', 'lake-area', 0, 1e7), iceArea: opt('iceArea', 'ice-area', 0, 1e7), minPop: opt('minPop', 'min-pop', 0, 1e9), digits: D.digits }
      : { tolerance: opt('tolerance', 'tolerance', 0, 5), minArea: opt('minArea', 'min-area', 0, 1e7), digits: D.digits };
  // The sea floor of the Earth: bands of age of the crust, bands of depth of the sea.
  const levelsOf = (name, max) => {
    if (values[name] === undefined) return null;
    const list = String(values[name]).split(',').map((v) => number(v, `--${name}`, 1, max));
    if (list.some((v, k) => k > 0 && v <= list[k - 1])) throw new Error(`globe: the values of --${name} run up, each once`);
    return list;
  };
  const ageLevels = levelsOf('seafloor-age', 4000);
  const depthLevels = levelsOf('depths', 11000);
  if (values['seafloor-cell'] !== undefined && !ageLevels && !depthLevels) throw new Error('globe: --seafloor-cell is the cell of the sea floor: give --seafloor-age or --depths with it');
  const cell = values['seafloor-cell'] === undefined ? 0.5 : number(values['seafloor-cell'], '--seafloor-cell', 0.05, 5);
  if (Math.abs(90 / cell - Math.round(90 / cell)) > 1e-9) throw new Error(`globe: --seafloor-cell is degrees that divide 90 (0.25, 0.5, 1), got ${cell}`);
  const names = body === 'earth' ? earthSources(made.scale) : null;
  const home = resolve(values.root ?? root);
  const cache = values.cache ?? join(home, 'cache');
  const outDir = join(home, body);
  const lockFile = join(outDir, 'sources.lock.json');
  const oldLock = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) : { downloads: [] };
  const licences = licencesWith();
  const lock = [];
  const log = (line) => console.log(line);
  const offline = values.offline ?? false;
  // A download checked against the lock, and written into the new one.
  const locked = (got, { id, source, request, dataDate }) => {
    const was = oldLock.downloads.find((d) => d.id === id && d.request === request);
    if (was && was.sha256 !== got.sha256 && !values.update) {
      throw new Error(`globe: the download "${id}" differs from sources.lock.json (${got.sha256.slice(0, 12)} against ${was.sha256.slice(0, 12)}): the source has changed. Run with --update to take it, or restore the cache.`);
    }
    const same = was && was.sha256 === got.sha256;
    lock.push({ id, source, licence: licences[source].licence, request, bytes: got.bytes, sha256: got.sha256, retrieved: same ? was.retrieved : got.fetched, dataDate });
    return got.path;
  };
  const ne = async (name) => {
    const got = await naturalEarth({ cache, name, offline, log });
    const file = locked(got, { id: name, source: 'natural-earth', request: `natural-earth ${NATURAL_EARTH_VERSION} ${name}.geojson`, dataDate: NATURAL_EARTH_VERSION });
    return JSON.parse(readFileSync(file, 'utf8'));
  };
  let built;
  if (body === 'earth') {
    log('globe: the Earth, from Natural Earth');
    built = buildEarth({ land: await ne(names.land), lakes: await ne(names.lakes), ice: [await ne(names.ice[0]), await ne(names.ice[1])], places: await ne(names.places) }, made);
  } else {
    log('globe: the Moon, from the mare boundaries of LROC');
    const m = MOON_MARIA;
    const got = await download({ cache, id: m.id, urls: [m.url], ext: 'zip', offline, log, check: (d) => (d[0] === 0x50 && d[1] === 0x4b ? null : 'not a ZIP archive') });
    const zip = readFileSync(locked(got, { id: m.id, source: 'lroc', request: m.request, dataDate: m.dataDate }));
    built = buildMoon({ maria: readShapefile(unzip(zip, /\.shp$/i), unzip(zip, /\.dbf$/i)) }, made);
  }
  if (depthLevels || ageLevels) {
    // Painted first, under the land: the bands of depth, then the bands of age.
    const floor = {};
    // A polygon of the sea floor smaller than two cells at the equator is a speck of the cells, left out.
    const floorArea = Math.max(made.minArea, Math.round(2 * cell * cell * ((Math.PI / 180) * BODIES[body].radiusKm) ** 2));
    const bandOptions = { cell, tolerance: made.tolerance, minArea: floorArea, digits: made.digits, radiusKm: BODIES[body].radiusKm };
    if (depthLevels) {
      const stride = Math.max(1, Math.min(60, Math.round((cell * 60) / 2)));
      const box = [-180, -90, 180, 90];
      const got = await etopo({ cache, box, stride, offline, log });
      const heights = readEsriAscii(readFileSync(locked(got, { id: `etopo1-${stride}m`, source: 'etopo', request: etopoRequest(box, stride).url, dataDate: 'ETOPO1 (2009)' }), 'utf8'));
      log('  sea floor: the depth of the sea, in bands');
      Object.assign(floor, buildGlobeBands('depth', (lon, lat) => -nearestAt(heights, lon, lat), { ...bandOptions, levels: depthLevels }));
      made.depths = { levels: depthLevels, cell, stride, minArea: floorArea };
    }
    if (ageLevels) {
      const got = await seafloorAge({ cache, offline, log });
      const ages = degreeGridOf(readFileSync(locked(got, { id: SEAFLOOR_AGE.id, source: 'earthbyte-age', request: SEAFLOOR_AGE.request, dataDate: SEAFLOOR_AGE.dataDate })));
      log('  sea floor: the age of the crust, in bands');
      Object.assign(floor, buildGlobeBands('age', (lon, lat) => nearestAt(ages, lon, lat), { ...bandOptions, levels: ageLevels }));
      made.seafloorAge = { levels: ageLevels, cell, minArea: floorArea };
    }
    built.layers = { ...floor, ...built.layers };
  }
  const globe = { format: 'globe-geo/1', body, name: BODIES[body].name, radiusKm: BODIES[body].radiusKm, units: UNITS, made, ...built };
  const count = (list) => `${list.length} (${list.reduce((n, p) => n + p.rings.reduce((k, r) => k + r.length, 0), 0)} points)`;
  log(`  ${Object.entries(globe.layers).map(([k, list]) => `${k} ${count(list)}`).join(', ')}${globe.places ? `, places ${globe.places.length}` : ''}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'globe.json'), globeText(globe));
  writeFileSync(lockFile, `${JSON.stringify({ format: 'globe-geo-lock/1', downloads: lock }, null, 2)}\n`);
  writeFileSync(join(outDir, 'SOURCES.md'), globeSourcesText(globe, lock, { command, licences }));
  log(`wrote ${join(outDir, 'globe.json')}`);
  if (values.preview) {
    const { previewGlobe } = await import('./lib/preview.mjs');
    const file = await previewGlobe(globe, join(home, 'out', body));
    log(`preview ${file}`);
  }
  return 0;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runGlobe(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
