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
  divisions?: string[];
}

export interface WorldFrameOf {
  projection: 'equal-earth' | 'laea';
  centre: LonLat;
  box: Box;
  lonlat: Box;
  outline?: Point[];
}

export function worldSources(scale: number, lakes?: boolean, divisions?: boolean): { countries: string; lakes?: string; divisions?: string };
export function worldFrame(o?: { bbox?: Box | null; centre?: LonLat | null }): {
  proj: Projection;
  frame: { projection: 'equal-earth' | 'laea'; centre: LonLat; box: Box; lonlat: Box };
  outline: Point[] | null;
};
export function frameOptions(frame: WorldFrameOf): { bbox?: Box; centre?: LonLat };
export function frameCut(frame: WorldFrameOf): {
  forward: (p: readonly number[]) => Point;
  rings: (ring: readonly LonLat[]) => LonLat[][];
  lines: (line: readonly LonLat[]) => LonLat[][];
  seam?: number;
};
export function stitchSeam(rings: readonly LonLat[][], seam: number, tol?: number): LonLat[][];
export function nearFrame(frame: WorldFrameOf, margin: number): (box: Box) => boolean;
export function featureRings(frame: WorldFrameOf, near?: ((box: Box) => boolean) | null): (geometry: object | null) => { points: Point[]; hole: boolean }[];
export function buildWorld(
  data: { countries: FeatureCollection; lakes?: FeatureCollection | null; divisions?: FeatureCollection | null },
  made: WorldMade,
): {
  made: { scale: number; detail: number; minArea: number; lakes: number | null; bbox?: Box; centre?: LonLat; divisions?: string[] };
  frame: { projection: 'equal-earth' | 'laea'; centre: LonLat; box: Box; lonlat: Box; outline?: Point[] };
  land: { id: string; ring: Point[] }[];
  gaps: { id: string; ring: Point[] }[];
  countries: { id: string; name: string; iso?: string; continent: string; label: Point; areaKm2: number; rings: Point[][] }[];
  boundaries: { id: string; between: [string, string]; lines: Point[][] }[];
  lakes: { id: string; name: string; ring: Point[] }[];
  divisions?: { id: string; name: string; code?: string; country: string; kind?: string; region?: string; label: Point; areaKm2: number; rings: Point[][] }[];
  divisionBorders?: { id: string; between: [string, string]; lines: Point[][] }[];
  stats: { arcs: number; shared: number; crossing: number; open: number; mended: number };
};
