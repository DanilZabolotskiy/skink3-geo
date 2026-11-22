// The sources of the pipeline, with the licence and the credit line of each. Only open data is
// used: what a film shows must be free to publish, with at most a credit in its description.
//
//   Natural Earth          public domain          coasts, countries, borders, large rivers and lakes, main roads
//   OpenStreetMap          ODbL 1.0               rivers and water at a city's scale, streets, built-up land,
//                                                 administrative divisions, named places
//   OpenHistoricalMap      CC0 1.0                walls and other things of the past, as its mappers drew them
//   Copernicus DEM GLO-30  free with attribution  the height of the ground, and its water body mask
//   AWMC geodata           ODbL 1.0               the coast of the ancient world, where a spec asks for it
//   SRTM                   public domain          the height of the ground, from files given by hand
//   GHSL (Copernicus EMS)  free with attribution  the built-up land of 1975 to today
//   LROC mare boundaries   public domain          the Moon's maria, for a globe (NASA PDS)
//
// A source comes into this table only after its terms are read on its own page (`url`). A printed
// map or a book is a source of facts only: where a wall ran, when a quarter was built; never of
// its drawing.

import { download } from './fetch.mjs';

export const LICENCES = {
  'natural-earth': {
    name: 'Natural Earth',
    licence: 'public domain',
    credit: 'Made with Natural Earth.',
    required: false,
    url: 'https://www.naturalearthdata.com/about/terms-of-use/',
  },
  lroc: {
    name: 'LROC Global Mare Boundaries, NASA Planetary Data System',
    licence: 'public domain',
    credit: 'Lunar maria: LROC Global Mare Boundaries (Nelson et al. 2014), NASA/GSFC/Arizona State University.',
    required: false,
    url: 'https://lroc.im-ldi.com/about/terms',
  },
  osm: {
    name: 'OpenStreetMap',
    licence: 'ODbL 1.0',
    credit: '© OpenStreetMap contributors',
    required: true,
    url: 'https://www.openstreetmap.org/copyright',
  },
  ohm: {
    name: 'OpenHistoricalMap',
    licence: 'CC0 1.0',
    credit: 'OpenHistoricalMap contributors',
    required: false,
    url: 'https://www.openhistoricalmap.org/copyright',
  },
  copernicus: {
    name: 'Copernicus DEM GLO-30',
    licence: 'free of charge with attribution (Copernicus DEM licence)',
    // The notice its licence asks for where the data has been adapted, as every layer made from it is.
    credit: 'Elevation and water: produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.',
    required: true,
    url: 'https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM',
  },
  awmc: {
    name: 'Ancient World Mapping Center geodata',
    licence: 'ODbL 1.0',
    credit: 'Ancient coast: Ancient World Mapping Center geodata (github.com/AWMC/geodata), made available under the Open Database License; it contains OpenStreetMap data, © OpenStreetMap contributors.',
    required: true,
    url: 'https://github.com/AWMC/geodata#license',
  },
  srtm: {
    name: 'SRTM (NASA, NGA)',
    licence: 'public domain',
    credit: 'Elevation data: NASA SRTM.',
    required: false,
    url: 'https://www.earthdata.nasa.gov/data/instruments/srtm',
  },
  ghsl: {
    name: 'Global Human Settlement Layer (GHS-BUILT-S R2023A)',
    licence: 'free and open: "reuse of this data is authorised with proper acknowledgment of the source" (European Commission)',
    credit: 'Built-up areas: GHS-BUILT-S R2023A, Global Human Settlement Layer, European Commission, Joint Research Centre.',
    required: true,
    url: 'https://human-settlement.emergency.copernicus.eu/download.php',
  },
  own: {
    name: 'Drawn by hand',
    licence: 'our own',
    credit: '',
    required: false,
    url: '',
  },
};

/**
 * The table with a user's own changes, by key and field: `{ own: { name: 'Drawn for this project' } }`.
 * A key the table lacks is an error: a new source needs its reader here as well as its row.
 */
export function licencesWith(changes = {}) {
  const out = Object.fromEntries(Object.entries(LICENCES).map(([key, row]) => [key, { ...row }]));
  for (const [key, row] of Object.entries(changes ?? {})) {
    if (!out[key]) throw new Error(`sources: no source "${key}" in the table (there are ${Object.keys(out).join(', ')})`);
    Object.assign(out[key], row);
  }
  return out;
}

/** Natural Earth as its own repository publishes it, at a fixed version, as GeoJSON. */
export const NATURAL_EARTH_VERSION = '5.1.2';

export function naturalEarth({ cache, name, offline, log }) {
  if (!/^ne_(10|50|110)m_[a-z0-9_]+$/.test(name)) throw new Error(`naturalEarth: bad name ${name}`);
  return download({
    cache,
    id: name.replace(/_/g, '-'),
    urls: [`https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v${NATURAL_EARTH_VERSION}/geojson/${name}.geojson`],
    ext: 'geojson',
    offline,
    log,
    check: (data) => (data.subarray(0, 200).toString('utf8').includes('FeatureCollection') ? null : 'not a GeoJSON feature collection'),
  });
}

/**
 * The geodata of the Ancient World Mapping Center as its repository publishes it, at a fixed commit:
 * a GeoJSON file named by its path there (its open water by sea, for one, with the coast as the
 * Center reconstructs it for antiquity).
 */
export const AWMC_COMMIT = '7ecf8bccea2efe1e1e9df2daf6001942de73fb87';

/** The short name of a file of that repository, for its download: the file's own name, in small letters and dashes. */
export const awmcName = (file) => file.split('/').pop().replace(/\.geojson$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function awmc({ cache, file, offline, log }) {
  if (!/^[A-Za-z0-9_ ./-]+\.geojson$/.test(file) || file.split('/').some((part) => part === '' || part.startsWith('.'))) throw new Error(`awmc: bad file ${JSON.stringify(file)}`);
  return download({
    cache,
    id: `awmc-${awmcName(file)}`,
    urls: [`https://raw.githubusercontent.com/AWMC/geodata/${AWMC_COMMIT}/${file.split('/').map(encodeURIComponent).join('/')}`],
    ext: 'geojson',
    offline,
    log,
    check: (data) => (data.subarray(0, 400).toString('utf8').includes('FeatureCollection') ? null : 'not a GeoJSON feature collection'),
  });
}

/** The name of the one-degree tile whose south-west corner is [lon, lat], as Copernicus names it. */

export function copernicusName(lon, lat) {
  const ns = `${lat < 0 ? 'S' : 'N'}${String(Math.abs(lat)).padStart(2, '0')}`;
  const ew = `${lon < 0 ? 'W' : 'E'}${String(Math.abs(lon)).padStart(3, '0')}`;
  return `Copernicus_DSM_COG_10_${ns}_00_${ew}_00_DEM`;
}

/** A tile of the Copernicus DEM GLO-30, from its public bucket; null where it has none (open sea). */
export async function copernicusTile({ cache, lon, lat, offline, log }) {
  const name = copernicusName(lon, lat);
  try {
    return await download({
      cache,
      id: `dem-glo30-${name.slice(22, 25)}${name.slice(29, 33)}`.toLowerCase(),
      urls: [`https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`],
      ext: 'tif',
      offline,
      log,
      check: (data) => (data.length > 8 && (data.readUInt16LE(0) === 0x4949 || data.readUInt16LE(0) === 0x4d4d) ? null : 'not a TIFF'),
    });
  } catch (error) {
    if (/HTTP 40[34]/.test(error.message)) return null;
    throw error;
  }
}

/**
 * The water body mask that comes with a tile of the Copernicus DEM (0 land, 1 ocean, 2 lake, 3 river),
 * a sample an arc-second like the heights; null where the DEM has no tile.
 */
export async function copernicusWaterMask({ cache, lon, lat, offline, log }) {
  const name = copernicusName(lon, lat);
  try {
    return await download({
      cache,
      id: `wbm-glo30-${name.slice(22, 25)}${name.slice(29, 33)}`.toLowerCase(),
      urls: [`https://copernicus-dem-30m.s3.amazonaws.com/${name}/AUXFILES/${name.replace(/_DEM$/, '_WBM')}.tif`],
      ext: 'tif',
      offline,
      log,
      check: (data) => (data.length > 8 && (data.readUInt16LE(0) === 0x4949 || data.readUInt16LE(0) === 0x4d4d) ? null : 'not a TIFF'),
    });
  } catch (error) {
    if (/HTTP 40[34]/.test(error.message)) return null;
    throw error;
  }
}

/** The one-degree tiles that cover a lon/lat box, as their south-west corners. */
export function tilesOf([lon0, lat0, lon1, lat1]) {
  const out = [];
  for (let lat = Math.floor(lat0); lat <= Math.floor(lat1 - 1e-9); lat++) for (let lon = Math.floor(lon0); lon <= Math.floor(lon1 - 1e-9); lon++) out.push([lon, lat]);
  return out;
}
