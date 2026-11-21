#!/usr/bin/env node
// A flat map of the world with the outline of every country, from public-domain data: the whole world on the Equal
// Earth projection, or the countries of a box round a place.
//
//   node world.mjs [--map world] [--root <dir>] [--scale 50] [--preview]      the whole world: builds <root>/world/
//   node world.mjs --map <name> --bbox <west,south,east,north> [--centre <lon,lat>] [--scale 10]
//                                                                             the countries of a box: <root>/<name>/
//   --name <Name>       what the map is called (the whole world: "The world")
//   --detail <m>        the thinning, in metres (half a unit of a stage of 1920 by 1080 that the map covers)
//   --min-area <km2>    an island smaller than this is left out; a country keeps its largest piece however small
//   --lakes <rank>      the lakes of Natural Earth's scalerank up to this (0: the largest alone); none without it
//   --offline           from the cache alone: nothing is fetched
//   --update            takes downloads that differ from the lock
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
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { licencesWith, NATURAL_EARTH_VERSION, naturalEarth } from './lib/sources.mjs';
import { buildWorld, worldSources } from './lib/world.mjs';

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
  const used = [...new Set(lock.map((d) => d.source))].map((key) => licences[key]);
  const m = world.made;
  const scale = `Natural Earth ${NATURAL_EARTH_VERSION}, 1:${m.scale}m`;
  const frame = world.frame.projection === 'equal-earth' ? 'the whole world on the Equal Earth projection' : `the box ${m.bbox.join(', ')} on the azimuthal equal-area plane round ${m.centre.join(', ')}`;
  const cut = world.frame.projection === 'equal-earth' ? '' : ', cut to the box';
  return [
    `# ${world.name}: the sources of its layers`,
    '',
    `Written by \`${command}\`. Do not edit: build again with other options.`,
    '',
    '## Credits for the description of a film',
    '',
    'A film that shows these layers may carry this line in its description (a courtesy: the data is in the public domain):',
    '',
    '```',
    ...used.map((l) => l.credit),
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
    },
  });
  const bbox = values.bbox === undefined ? null : numbers(values.bbox, 4, '--bbox');
  if (values.centre !== undefined && !bbox) throw new Error('world: --centre is the middle of a box: give --bbox with it');
  const map = values.map ?? (bbox ? null : 'world');
  if (!map || !/^[a-z][a-z0-9-]*$/.test(map)) throw new Error(`world: --map names the map in lower case, a-z, 0-9 and "-"${bbox ? ' (a box has no default name)' : ''}, got ${JSON.stringify(values.map)}`);
  const scale = values.scale === undefined ? (bbox ? 10 : 50) : number(values.scale, '--scale', 10, 110);
  const made = {
    scale,
    ...(values.detail === undefined ? {} : { detail: number(values.detail, '--detail', 1, 1e6) }),
    ...(values['min-area'] === undefined ? {} : { minArea: number(values['min-area'], '--min-area', 0, 1e8) }),
    lakes: values.lakes === undefined ? null : number(values.lakes, '--lakes', 0, 12),
    ...(bbox ? { bbox, centre: values.centre === undefined ? null : numbers(values.centre, 2, '--centre') } : {}),
  };
  const names = worldSources(scale, made.lakes != null);
  const home = resolve(values.root ?? root);
  const cache = values.cache ?? join(home, 'cache');
  const outDir = join(home, map);
  const lockFile = join(outDir, 'sources.lock.json');
  const oldLock = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) : { downloads: [] };
  const licences = licencesWith();
  const lock = [];
  const log = (line) => console.log(line);
  const ne = async (name) => {
    const got = await naturalEarth({ cache, name, offline: values.offline ?? false, log });
    const request = `natural-earth ${NATURAL_EARTH_VERSION} ${name}.geojson`;
    const was = oldLock.downloads.find((d) => d.id === name && d.request === request);
    if (was && was.sha256 !== got.sha256 && !values.update) {
      throw new Error(`world: the download "${name}" differs from sources.lock.json (${got.sha256.slice(0, 12)} against ${was.sha256.slice(0, 12)}): the source has changed. Run with --update to take it, or restore the cache.`);
    }
    const same = was && was.sha256 === got.sha256;
    lock.push({ id: name, source: 'natural-earth', licence: licences['natural-earth'].licence, request, bytes: got.bytes, sha256: got.sha256, retrieved: same ? was.retrieved : got.fetched, dataDate: NATURAL_EARTH_VERSION });
    return JSON.parse(readFileSync(got.path, 'utf8'));
  };
  log(`world: ${bbox ? `the countries of ${bbox.join(', ')}` : 'the whole world'}, from Natural Earth 1:${scale}m`);
  const built = buildWorld({ countries: await ne(names.countries), lakes: names.lakes ? await ne(names.lakes) : null }, made);
  const { stats, ...layers } = built;
  const world = { format: 'world-geo/1', id: map, name: values.name ?? (bbox ? map : 'The world'), units: UNITS, ...layers };
  const count = (rings) => `${rings.length} (${rings.reduce((n, r) => n + r.length, 0)} points)`;
  log(`  countries ${world.countries.length}, ${count(world.countries.flatMap((c) => c.rings))}; land ${count(world.land.map((l) => l.ring))}; gaps ${world.gaps.length}; boundaries ${world.boundaries.length}; lakes ${world.lakes.length}`);
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
