// The types of worldlines.mjs, for the TypeScript that uses it (the tests).

import type { FeatureCollection } from './globe.mjs';
import type { LonLat, Point } from './project.mjs';
import type { WorldFrameOf } from './world.mjs';

export interface WorldPlaceSpec {
  id: string;
  name?: string;
  at?: LonLat;
  port?: string;
  airport?: string;
  near?: LonLat;
}
export interface WorldLineSpec {
  id: string;
  name: string;
  from: { osm: string[] } | { through: (string | LonLat)[] } | { great: [string | LonLat, string | LonLat] };
  step?: number;
  detail?: number;
  source: string;
}
export interface WorldFeaturesSpec {
  places?: WorldPlaceSpec[];
  lines?: WorldLineSpec[];
}
export interface BuiltLane {
  id: string;
  rank: number;
  name?: string;
  lines: Point[][];
}
export interface BuiltPlace {
  id: string;
  name: string;
  kind: 'place' | 'port' | 'airport';
  at: Point;
  lonlat: LonLat;
}
export interface BuiltLine {
  id: string;
  name: string;
  kind: 'mapped' | 'drawn' | 'great';
  approximate?: true;
  source: string;
  lengthKm: number;
  lines: Point[][];
}

export const PLACE_KEYS: string[];
export const LINE_KEYS: string[];
export function laneRank(freq: number): number;
export function linesInFrame(lines: readonly (readonly LonLat[])[], frame: WorldFrameOf, detail: number): Point[][];
export function buildLanes(collection: FeatureCollection, frame: WorldFrameOf, o: { detail: number }): BuiltLane[];
export function checkWorldFeatures(spec: unknown): void;
export function buildWorldFeatures(
  spec: WorldFeaturesSpec,
  frame: WorldFrameOf,
  o: { ports?: FeatureCollection | null; airports?: FeatureCollection | null; mapped?: Record<string, LonLat[][]>; detail: number },
): { places: BuiltPlace[]; lines: BuiltLine[] };
