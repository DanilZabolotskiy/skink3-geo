// The types of seafloor.mjs, for the TypeScript that uses it (the tests).

import type { DegreeGrid } from './worldheights.mjs';
import type { LonLat, Point } from './project.mjs';
import type { WorldFrameOf } from './world.mjs';

export interface ClassGrid {
  x0: number;
  y0: number;
  cell: number;
  cols: number;
  rows: number;
  box: [number, number, number, number];
  /** Row 0 the southernmost; -1: no class. */
  classes: Int32Array;
}
export interface Band {
  id: string;
  from: number;
  to: number | null;
}
export interface SedimentGroup {
  id: string;
  codes: number[];
  names: string[];
}
export interface GlobeBandPolygon {
  id: string;
  areaKm2: number;
  from: number;
  to: number | null;
  rings: LonLat[][];
}

export const SEDIMENT_KINDS: readonly { code: number; id: string; name: string }[];
export function degreeGridOf(bytes: Uint8Array, varName?: string): DegreeGrid;
export function nearestAt(grid: DegreeGrid, lon: number, lat: number): number;
export function bandsOf(kind: string, levels: readonly number[]): Band[];
export function bandIndex(levels: readonly number[], v: number): number;
export function sedimentGroups(text: string): SedimentGroup[];
export function planeClasses(frame: WorldFrameOf, cell: number, classify: (lon: number, lat: number) => number, levels?: readonly number[] | null): ClassGrid;
export function sphereClasses(cell: number, classify: (lon: number, lat: number) => number, levels?: readonly number[] | null): ClassGrid;
export function cellOutlines(grid: ClassGrid): Map<number, { points: Point[]; hole: boolean }[]>;
export function thinClasses(grid: ClassGrid, o: { tol: number; minArea?: number; digits?: number; groupOf?: (c: number) => number }): Map<number, { land: Point[][]; gaps: Point[][] }>;
export function worldAreas(grid: ClassGrid, o: { tol: number; minArea?: number }): Map<number, { rings: Point[][]; holes: Point[][] }>;
export function globeAreas(grid: ClassGrid, o: { tol: number; minArea?: number; digits?: number; radiusKm?: number }): Map<number, { areaKm2: number; rings: LonLat[][] }[]>;
export function globeBands(grid: ClassGrid, bands: readonly Band[], o: { tol: number; minArea?: number; digits?: number; radiusKm?: number }): Record<string, GlobeBandPolygon[]>;
export function seafloorCell(frame: WorldFrameOf): number;
export function buildWorldAge(ages: DegreeGrid, frame: WorldFrameOf, o: { levels: readonly number[]; cell: number; tol: number; minArea?: number }): (Band & { rings: Point[][]; holes: Point[][] })[];
export function buildWorldSediments(kinds: DegreeGrid, frame: WorldFrameOf, o: { groups: readonly SedimentGroup[]; cell: number; tol: number; minArea?: number }): (SedimentGroup & { rings: Point[][]; holes: Point[][] })[];
export function buildGlobeBands(
  kind: string,
  value: (lon: number, lat: number) => number,
  o: { levels: readonly number[]; cell: number; tolerance: number; minArea?: number; digits?: number; radiusKm?: number },
): Record<string, GlobeBandPolygon[]>;
