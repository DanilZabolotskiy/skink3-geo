// The types of blocks.mjs, for the TypeScript that uses it (map.ts and the tests).

import type { Box, Point } from './geom.mjs';

export const BLOCK_CLASSES: string[];
export const BLOCK_WIDTHS: Record<string, number>;

/** A spec's `blocks` (a city spec's key; see the README, "The spec"). */
export interface BlocksSpec {
  view?: string;
  from?: 'osm' | 'ohm';
  classes?: string[];
  widths?: Record<string, number>;
  cell?: number;
  within?: { wall: string } | { points: [number, number][] };
  water?: boolean;
  squares?: boolean;
  minArea?: number;
  detail?: number;
  lines?: { class?: string; points: [number, number][] }[];
  year?: number;
}

export function blockClasses(spec: BlocksSpec): { classes: string[]; widths: Record<string, number> };
export function checkBlocks(spec: BlocksSpec): { classes: string[]; widths: Record<string, number>; cell: number };
export function blockStreets(spec: BlocksSpec, proj: { forward: (p: readonly number[]) => Point }, elements?: readonly unknown[]): { width: number; line: Point[] }[];
export function blockSquares(elements?: readonly unknown[], year?: number | null): { id: string; tags: Record<string, string>; outer: [number, number][][]; inner: [number, number][][] }[];
export function buildBlocks(
  spec: Pick<BlocksSpec, 'cell' | 'minArea' | 'detail'>,
  frame: { box: Box },
  layers?: { streets?: readonly { width: number; line: readonly Point[] }[]; squares?: readonly (readonly Point[])[]; water?: readonly (readonly Point[])[]; within?: readonly Point[] | null },
): { id: string; areaHa: number; ring: Point[] }[];
export function mergeBlocks(rings: readonly (readonly Point[])[], o: { merge: number; cell?: number; detail?: number; minArea?: number }): Point[][];
