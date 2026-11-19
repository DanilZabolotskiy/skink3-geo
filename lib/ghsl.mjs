// The built-up land of a city through the last half century: the Global Human Settlement Layer of
// the European Commission's Joint Research Centre (a part of the Copernicus Emergency Management
// Service). GHS-BUILT-S R2023A gives, for every 100 m cell of the world and every fifth year from
// 1975 to 2030, the square metres built on (0 to 10000), from Landsat and Sentinel-2 images; the
// years after 2020 are a projection. Its tiles are 1000 km squares of the Mollweide projection,
// each a ZIP with one BigTIFF.

import { download } from './fetch.mjs';

export const GHSL_RELEASE = 'R2023A';
export const GHSL_YEARS = [1975, 1980, 1985, 1990, 1995, 2000, 2005, 2010, 2015, 2020, 2025, 2030];

const R = 6378137;
const TILE = 1000000;
const [LEFT, TOP] = [-18041000, 9000000];

/** From [lon, lat] to the Mollweide plane of the layer, in metres (the sphere of the WGS 84 major axis). */
export function mollweide([lon, lat]) {
  const phi = (lat * Math.PI) / 180;
  const target = Math.PI * Math.sin(phi);
  let t = phi;
  // Newton's steps on 2t + sin 2t = pi sin(phi); a fixed count, so the result is the same everywhere.
  for (let k = 0; k < 12; k++) {
    const slope = 2 + 2 * Math.cos(2 * t);
    if (Math.abs(slope) < 1e-12) break;
    t -= (2 * t + Math.sin(2 * t) - target) / slope;
  }
  return [((2 * Math.SQRT2) / Math.PI) * R * ((lon * Math.PI) / 180) * Math.cos(t), Math.SQRT2 * R * Math.sin(t)];
}

/** The box of the Mollweide plane that holds a lon/lat box: [xmin, ymin, xmax, ymax]. */
export function mollweideBox([w, s, e, n]) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (let k = 0; k <= 16; k++) {
    const [lon, lat] = [w + ((e - w) * k) / 16, s + ((n - s) * k) / 16];
    for (const p of [mollweide([lon, s]), mollweide([lon, n]), mollweide([w, lat]), mollweide([e, lat])]) {
      box[0] = Math.min(box[0], p[0]);
      box[1] = Math.min(box[1], p[1]);
      box[2] = Math.max(box[2], p[0]);
      box[3] = Math.max(box[3], p[1]);
    }
  }
  return box;
}

/** The tiles a lon/lat box reaches: [{ row, col }], rows from the north and columns from the west, both from 1. */
export function ghslTilesOf(lonlat) {
  const [x0, y0, x1, y1] = mollweideBox(lonlat);
  const out = [];
  for (let row = Math.floor((TOP - y1) / TILE) + 1; row <= Math.floor((TOP - y0) / TILE) + 1; row++) {
    for (let col = Math.floor((x0 - LEFT) / TILE) + 1; col <= Math.floor((x1 - LEFT) / TILE) + 1; col++) out.push({ row, col });
  }
  return out;
}

export function ghslUrl(year, row, col) {
  if (!GHSL_YEARS.includes(year)) throw new Error(`ghsl: no layer of ${year} (it has ${GHSL_YEARS.join(', ')})`);
  const name = `GHS_BUILT_S_E${year}_GLOBE_${GHSL_RELEASE}_54009_100`;
  return `https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_BUILT_S_GLOBE_${GHSL_RELEASE}/${name}/V1-0/tiles/${name}_V1_0_R${row}_C${col}.zip`;
}

/** One tile of one year, from the cache or the Commission's server; null where the layer has no tile (open sea). */
export async function ghslTile({ cache, year, row, col, offline, log }) {
  try {
    return await download({
      cache,
      id: `ghsl-built-s-${year}-r${row}-c${col}`,
      urls: [ghslUrl(year, row, col)],
      ext: 'zip',
      offline,
      log,
      timeoutMs: 600000,
      check: (data) => (data.length > 22 && data.readUInt32LE(0) === 0x04034b50 ? null : 'not a ZIP archive'),
    });
  } catch (error) {
    if (/HTTP 40[34]/.test(error.message)) return null;
    throw error;
  }
}

/**
 * The share of the ground built on at [lon, lat], 0 to 1, from the rasters of the tiles read
 * (readRaster windows in the Mollweide plane): between the four samples round the place, a sample
 * with no value counting as open ground.
 */
export function builtShare(rasters) {
  return (lonlat) => {
    const [x, y] = mollweide(lonlat);
    for (const r of rasters) {
      const [fi, fj] = [(x - r.x0) / r.dx, (r.y0 - y) / r.dy];
      if (fi < -0.5 || fj < -0.5 || fi > r.w - 0.5 || fj > r.h - 0.5) continue;
      const [i, j] = [Math.max(0, Math.min(r.w - 2, Math.floor(fi))), Math.max(0, Math.min(r.h - 2, Math.floor(fj)))];
      const [u, v] = [Math.max(0, Math.min(1, fi - i)), Math.max(0, Math.min(1, fj - j))];
      const at = (a, b) => {
        const value = r.data[b * r.w + a];
        return Number.isNaN(value) ? 0 : value;
      };
      return ((at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - v) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * v) / 10000;
    }
    return 0;
  };
}
