// Cached downloads of the geo pipeline. What comes from the network is untrusted data: each download
// lies alone in a new directory of its own under the cache (cache/<id>-<key>/data.<ext>, with a
// meta.json beside it), is only ever read as data, and is never run. The cache is not committed; what
// is committed is the lock of a city (sources.lock.json): the request and the SHA-256 of every
// download its layers were built from.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** A generic client name: no project, owner or contact details go out with a request. */
const USER_AGENT = 'city-map-layers/1.0 (Node.js fetch)';

/** The public Overpass instances of OpenStreetMap data, tried in order. */
export const OVERPASS_OSM = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

/** The Overpass instance of OpenHistoricalMap. */
export const OVERPASS_OHM = ['https://overpass-api.openhistoricalmap.org/api/interpreter'];

async function attempt(url, body, timeoutMs) {
  const init = {
    method: body === null ? 'GET' : 'POST',
    headers: { 'user-agent': USER_AGENT, ...(body === null ? {} : { 'content-type': 'application/x-www-form-urlencoded' }) },
    signal: AbortSignal.timeout(timeoutMs),
    ...(body === null ? {} : { body }),
  };
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * One download, from the cache when it is there.
 *   cache    the cache directory
 *   id       a short name of what is fetched (letters, digits, dashes)
 *   urls     the addresses to try in order (mirrors of one service)
 *   body     the POST body, or null for a GET
 *   keyOf    what the cache key is made of besides the body: the URL by default, or a fixed word for
 *            mirrors that answer the same request
 *   check    (buffer) => string | null: why the answer is not usable (an error page), or null
 * Returns { path, sha256, bytes, url, fetched, cached }.
 */
export async function download({ cache, id, urls, body = null, ext = 'bin', keyOf = null, offline = false, check = null, timeoutMs = 240000, log = () => {} }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`download: bad id ${JSON.stringify(id)}`);
  const key = sha256(`${keyOf ?? urls[0]}\n${body ?? ''}`).slice(0, 12);
  const dir = join(cache, `${id}-${key}`);
  const file = join(dir, `data.${ext}`);
  const metaFile = join(dir, 'meta.json');
  if (existsSync(file) && existsSync(metaFile)) {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    return { path: file, sha256: meta.sha256, bytes: meta.bytes, url: meta.url, fetched: meta.fetched, cached: true };
  }
  if (offline) throw new Error(`download: ${id} is not in the cache (${dir}) and the run is offline`);
  let lastError = null;
  for (let turn = 0; turn < 2; turn++) {
    for (const url of urls) {
      try {
        log(`  fetch ${id} from ${new URL(url).host}${turn ? ' (again)' : ''}`);
        const data = await attempt(url, body, timeoutMs);
        const why = check ? check(data) : null;
        if (why) throw new Error(why);
        // A new directory of its own: nothing else is ever written beside a download but its meta.json.
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const digest = sha256(data);
        const fetched = new Date().toISOString().slice(0, 10);
        writeFileSync(`${file}.part`, data);
        renameSync(`${file}.part`, file);
        writeFileSync(metaFile, `${JSON.stringify({ id, url, body, bytes: data.length, sha256: digest, fetched }, null, 2)}\n`);
        return { path: file, sha256: digest, bytes: data.length, url, fetched, cached: false };
      } catch (error) {
        lastError = error;
        log(`  ${id}: ${new URL(url).host}: ${error.message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  throw new Error(`download: ${id}: every address failed (${lastError?.message})`);
}

/** An Overpass answer that is an error page or a timed-out query, as a reason; null when it is data. */
function overpassProblem(data) {
  const head = data.subarray(0, 400).toString('utf8');
  if (!head.trimStart().startsWith('{')) return `not JSON: ${head.slice(0, 80).replace(/\s+/g, ' ')}`;
  const tail = data.subarray(Math.max(0, data.length - 600)).toString('utf8');
  const remark = /"remark"\s*:\s*"([^"]*)"/.exec(tail);
  if (remark && /error|timed out|out of memory/i.test(remark[1])) return `overpass: ${remark[1].slice(0, 120)}`;
  return null;
}

/** The mirror that answered last, kept in the cache (a line of text of our own, beside the downloads), goes first. */
function ranked(urls, cache) {
  const file = join(cache, 'overpass-mirror.txt');
  const last = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  return urls.includes(last) ? [last, ...urls.filter((u) => u !== last)] : urls;
}

/** An Overpass query (Overpass QL, `[out:json]`), cached by the query alone: the mirrors answer alike. */
export async function overpass({ cache, id, query, ohm = false, offline = false, log }) {
  const urls = ohm ? OVERPASS_OHM : ranked(OVERPASS_OSM, cache);
  const got = await download({ cache, id, urls, body: `data=${encodeURIComponent(query)}`, ext: 'json', keyOf: ohm ? 'overpass-ohm' : 'overpass-osm', offline, check: overpassProblem, log });
  if (!ohm && !got.cached) writeFileSync(join(cache, 'overpass-mirror.txt'), `${got.url}
`);
  return got;
}
