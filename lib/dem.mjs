// The height of the ground: reading the tiles of a digital elevation model and sampling them.
//   - Copernicus DEM GLO-30: a GeoTIFF of 32-bit floats in tiles, Deflate, with the floating-point
//     predictor; one tile a degree, a sample an arc-second (wider apart in longitude north of 50°).
//   - SRTM: an .hgt file, 16-bit big-endian integers, 3601 or 1201 samples a side.
// Both are read with Node alone (the TIFF by tiff.mjs). A tile is { lon0, lat0, dx, dy, w, h, data }: sample (i, j) stands at
// [lon0 + i dx, lat0 - j dy], row 0 in the north; `data` is a Float32Array with NaN where there is no height.

import { EARTH_RADIUS } from './project.mjs';
import { readRaster } from './tiff.mjs';

/** A GeoTIFF of one band in degrees (a Copernicus DEM tile, or its water mask), as a tile. */
export function readGeoTiff(buf) {
  const r = readRaster(buf);
  return { lon0: r.x0, lat0: r.y0, dx: r.dx, dy: r.dy, w: r.w, h: r.h, data: r.data };
}

/** An SRTM .hgt file as a tile; its name gives its south-west corner (N41E012.hgt). */
export function readHgt(buf, name) {
  const m = /([NS])(\d{2})([EW])(\d{3})/i.exec(name);
  if (!m) throw new Error(`readHgt: no corner in the name ${name}`);
  const lat = (m[1].toUpperCase() === 'S' ? -1 : 1) * Number(m[2]);
  const lon = (m[3].toUpperCase() === 'W' ? -1 : 1) * Number(m[4]);
  const side = Math.round(Math.sqrt(buf.length / 2));
  if (side * side * 2 !== buf.length) throw new Error('readHgt: not a square of 16-bit samples');
  const data = new Float32Array(side * side);
  for (let k = 0; k < data.length; k++) {
    const v = buf.readInt16BE(k * 2);
    data[k] = v === -32768 ? NaN : v;
  }
  return { lon0: lon, lat0: lat + 1, dx: 1 / (side - 1), dy: 1 / (side - 1), w: side, h: side, data };
}

/**
 * The height at [lon, lat] from a set of tiles, between the four samples round it; `sea` (0) where no
 * tile covers the place or the samples have no height.
 */
export function sampler(tiles, sea = 0) {
  return ([lon, lat]) => {
    for (const t of tiles) {
      const fi = (lon - t.lon0) / t.dx;
      const fj = (t.lat0 - lat) / t.dy;
      if (fi < -0.5 || fj < -0.5 || fi > t.w - 0.5 || fj > t.h - 0.5) continue;
      const i = Math.min(t.w - 2, Math.max(0, Math.floor(fi)));
      const j = Math.min(t.h - 2, Math.max(0, Math.floor(fj)));
      const u = Math.min(1, Math.max(0, fi - i));
      const v = Math.min(1, Math.max(0, fj - j));
      const a = t.data[j * t.w + i];
      const b = t.data[j * t.w + i + 1];
      const c = t.data[(j + 1) * t.w + i];
      const d = t.data[(j + 1) * t.w + i + 1];
      const value = (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
      return Number.isNaN(value) ? sea : value;
    }
    return sea;
  };
}

/**
 * A tile with its samples averaged in blocks of `k` by `k`: the resolution lowered for a map of a
 * smaller scale, each new sample the mean of the ground its block covers. A block at the tile's
 * edge may be narrower, and samples with no height are left out of the mean.
 */
export function reduceTile(t, k) {
  if (!Number.isInteger(k) || k < 1) throw new Error(`reduceTile: the factor is a whole number from 1, not ${k}`);
  if (k === 1) return t;
  const w = Math.ceil(t.w / k);
  const h = Math.ceil(t.h / k);
  const data = new Float32Array(w * h);
  for (let J = 0; J < h; J++) {
    const j1 = Math.min(t.h, (J + 1) * k);
    for (let I = 0; I < w; I++) {
      const i1 = Math.min(t.w, (I + 1) * k);
      let sum = 0;
      let n = 0;
      for (let j = J * k; j < j1; j++) {
        for (let i = I * k; i < i1; i++) {
          const v = t.data[j * t.w + i];
          if (Number.isNaN(v)) continue;
          sum += v;
          n++;
        }
      }
      data[J * w + I] = n > 0 ? sum / n : NaN;
    }
  }
  return { lon0: t.lon0 + ((k - 1) / 2) * t.dx, lat0: t.lat0 - ((k - 1) / 2) * t.dy, dx: t.dx * k, dy: t.dy * k, w, h, data };
}

/**
 * How a tile is read for a grid of `cell` metres, by the scale: the `factor` it is reduced by, so
 * that its samples end up about half a cell apart, and how many `samples` a side then make the mean
 * of one cell. A grid as fine as the tile takes it whole, a sample a cell.
 */
export function scaleOf(tile, cell) {
  const sample = (tile.dy * Math.PI * EARTH_RADIUS) / 180;
  const factor = Math.max(1, Math.round(cell / (2 * sample)));
  return { factor, samples: Math.min(4, Math.max(1, Math.round(cell / (factor * sample)))) };
}

/** The classes of the Copernicus water body mask. */
export const WATER_CLASSES = { ocean: 1, lake: 2, river: 3 };

/**
 * A tile of a water mask as the share of water in each sample, 0 or 1, for the classes wanted: a
 * tile that `reduceTile` can average and `sampler` can read between its samples.
 */
export function waterShare(tile, classes = ['ocean', 'lake', 'river']) {
  const want = new Set(classes.map((c) => {
    if (!(c in WATER_CLASSES)) throw new Error(`waterShare: no water class "${c}" (ocean, lake, river)`);
    return WATER_CLASSES[c];
  }));
  return { ...tile, data: Uint8Array.from(tile.data, (v) => (want.has(v) ? 1 : 0)) };
}

/**
 * The share of water at [lon, lat], 0 to 1, from the tiles of a water mask, between the four samples
 * round it: a sample counts as water when its class is one of those wanted. A place no tile covers
 * has none.
 */
export function waterSampler(tiles, classes = ['ocean', 'lake', 'river']) {
  const want = new Set(classes.map((c) => {
    if (!(c in WATER_CLASSES)) throw new Error(`waterSampler: no water class "${c}" (ocean, lake, river)`);
    return WATER_CLASSES[c];
  }));
  const wet = tiles.map((t) => ({ ...t, data: Float32Array.from(t.data, (v) => (want.has(v) ? 1 : 0)) }));
  return sampler(wet, 0);
}

/** A tile of open sea for the degree whose south-west corner is [lon, lat]: the mask has no file where there is no land at all. */
export const seaTile = (lon, lat) => ({ lon0: lon, lat0: lat + 1, dx: 1, dy: 1, w: 2, h: 2, data: Float32Array.of(1, 1, 1, 1) });
