// The types of lib/globe.mjs, for the TypeScript that uses it (map.ts and the tests).

import type { LonLat } from './project.mjs';

export interface GlobePolygon {
  areaKm2: number;
  name?: string;
  /** The outer ring first, counter-clockwise seen from outside; then its holes, clockwise. */
  rings: LonLat[][];
}

export interface EarthOptions {
  scale?: 50 | 110;
  tolerance?: number;
  minArea?: number;
  lakeArea?: number;
  iceArea?: number;
  minPop?: number;
  digits?: number;
}

export interface MoonOptions {
  tolerance?: number;
  minArea?: number;
  digits?: number;
}

export interface FeatureCollection {
  features?: { geometry: { type: string; coordinates: unknown } | null; properties?: Record<string, unknown> | null }[];
}

export type Place = { name: string; at: LonLat; pop: number };

export const EARTH_KM: number;
export const BODIES: Readonly<Record<'earth' | 'moon', Readonly<{ name: string; radiusKm: number }>>>;
export const GLOBE_DEFAULTS: Readonly<{ earth: Readonly<Required<EarthOptions>>; moon: Readonly<Required<MoonOptions>> }>;
export const MOON_MARIA: Readonly<{ id: string; url: string; request: string; dataDate: string }>;
export function unit(p: readonly number[]): [number, number, number];
export function samePlace(a: readonly number[], b: readonly number[]): boolean;
export function sphericalArea(ring: readonly (readonly number[])[]): number;
export function areaKm2(ring: readonly (readonly number[])[], radiusKm?: number): number;
export function orientOnSphere<T extends readonly number[]>(ring: readonly T[], ccw?: boolean): T[];
export function wholeRing<T extends readonly number[]>(ring: readonly T[]): T[] | null;
export function simplifyOnSphere<T extends readonly number[]>(ring: readonly T[], tol: number): T[] | null;
export function polygonsOf(fc: FeatureCollection): { rings: LonLat[][]; properties: Record<string, unknown> }[];
export function globePolygons(
  fc: FeatureCollection,
  o: { tolerance: number; minArea: number; digits?: number; name?: ((properties: Record<string, unknown>) => string) | null; radiusKm?: number },
): GlobePolygon[];
export function buildEarth(
  collections: { land: FeatureCollection; lakes?: FeatureCollection | null; ice?: FeatureCollection[]; places?: FeatureCollection | null },
  options?: EarthOptions,
): { layers: { land: (GlobePolygon & { id: string })[]; lakes?: (GlobePolygon & { id: string })[]; ice?: (GlobePolygon & { id: string })[] }; places?: Place[] };
export function buildMoon(collections: { maria: FeatureCollection }, options?: MoonOptions): { layers: { maria: (GlobePolygon & { id: string })[] } };
export function earthSources(scale: number): { land: string; lakes: string; ice: string[]; places: string };
