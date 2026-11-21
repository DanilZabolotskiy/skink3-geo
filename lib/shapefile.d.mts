// The types of lib/shapefile.mjs.

import type { FeatureCollection } from './globe.mjs';

export function readDbf(buf: Buffer): (Record<string, string | number | boolean | null> | null)[];
export function readShp(buf: Buffer): ({ type: 'Polygon' | 'MultiPolygon'; coordinates: unknown } | null)[];
export function readShapefile(shp: Buffer, dbf?: Buffer | null): Required<FeatureCollection>;
