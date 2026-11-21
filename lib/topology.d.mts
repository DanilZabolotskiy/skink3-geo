// The types of topology.mjs, for the TypeScript that uses it (the tests).

import type { Point } from './geom.mjs';

export function densify(points: readonly Point[], step?: number, closed?: boolean): Point[];
export function crossings(points: readonly Point[]): [number, number][];

export interface Thinned {
  /** The outer rings of each shape that are kept, counter-clockwise, the largest first. */
  shapes: { rings: Point[][] }[];
  /** The outlines of all the shapes as one, counter-clockwise, the largest first. */
  land: Point[][];
  /** The holes in the land that no shape fills, clockwise. */
  gaps: Point[][];
  /** The border between shapes a and b (a < b): open lines, or a closed ring with its first point repeated at its end. */
  borders: { a: number; b: number; lines: Point[][] }[];
  stats: { arcs: number; shared: number; crossing: number; open: number; mended: number };
}

export function thinTogether(shapes: readonly { rings: readonly { points: readonly Point[]; hole?: boolean }[] }[], o: { tol: number; minArea?: number; digits?: number }): Thinned;
export function untangle(points: readonly Point[]): Point[] | null;
