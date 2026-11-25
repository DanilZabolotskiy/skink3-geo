// The types of worldheights.mjs, for the TypeScript that uses it (the tests).

import type { Box, LonLat, Point } from './project.mjs';
import type { WorldFrameOf } from './world.mjs';

export interface DegreeGrid {
  cols: number;
  rows: number;
  west: number;
  south: number;
  cell: number;
  values: Float32Array;
}
export interface PlaneHeights {
  box: Box;
  cell: number;
  cols: number;
  rows: number;
  values: number[];
}
export interface BuiltShallows {
  id: string;
  depth: number;
  rings: Point[][];
  holes: Point[][];
}

export function readEsriAscii(text: string): DegreeGrid;
export function degreesAt(grid: DegreeGrid, p: LonLat): number;
export function heightsPlan(frame: WorldFrameOf, cell?: number | null): { cell: number; stride: number; boxes: Box[] };
export function joinGrids(west: DegreeGrid, east: DegreeGrid): DegreeGrid;
export function buildHeights(
  degrees: DegreeGrid,
  frame: WorldFrameOf,
  o: { cell: number; detail: number; minArea?: number; shallows?: readonly number[] },
): { heights: PlaneHeights; shallows: BuiltShallows[] };
