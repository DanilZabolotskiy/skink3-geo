// The types of world.mjs, for the TypeScript that uses it (the tests).

import type { FeatureCollection } from './globe.mjs';
import type { Box, LonLat, Point, Projection } from './project.mjs';

export interface WorldMade {
  scale: 10 | 50 | 110;
  detail?: number;
  minArea?: number;
  lakes?: number | null;
  bbox?: Box | null;
  centre?: LonLat | null;
}

export function worldSources(scale: number, lakes?: boolean): { countries: string; lakes?: string };
export function worldFrame(o?: { bbox?: Box | null; centre?: LonLat | null }): {
  proj: Projection;
  frame: { projection: 'equal-earth' | 'laea'; centre: LonLat; box: Box; lonlat: Box };
  outline: Point[] | null;
};
export function buildWorld(
  data: { countries: FeatureCollection; lakes?: FeatureCollection | null },
  made: WorldMade,
): {
  made: { scale: number; detail: number; minArea: number; lakes: number | null; bbox?: Box; centre?: LonLat };
  frame: { projection: 'equal-earth' | 'laea'; centre: LonLat; box: Box; lonlat: Box; outline?: Point[] };
  land: { id: string; ring: Point[] }[];
  gaps: { id: string; ring: Point[] }[];
  countries: { id: string; name: string; iso?: string; continent: string; label: Point; areaKm2: number; rings: Point[][] }[];
  boundaries: { id: string; between: [string, string]; lines: Point[][] }[];
  lakes: { id: string; name: string; ring: Point[] }[];
  stats: { arcs: number; shared: number; crossing: number; open: number; mended: number };
};
