// The types of gdb.mjs, for the TypeScript that uses it (the tests).

import type { FeatureCollection } from './globe.mjs';

export interface GdbField {
  name: string;
  type: number;
  nullable: boolean;
  wkt?: string;
  x0?: number;
  y0?: number;
  scale?: number;
  z?: boolean;
  m?: boolean;
}

export function readGdbFields(table: Buffer): { geometry: 'point' | 'multipoint' | 'polyline' | 'polygon' | 'multipatch' | null; fields: GdbField[] };
export function readGdbOffsets(tablx: Buffer): number[];
export function readGdbPolygon(blob: Buffer, field: { x0: number; y0: number; scale: number }): { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown } | null;
export function readGdbTable(table: Buffer, tablx: Buffer, o?: { want?: ((properties: Record<string, unknown>) => boolean) | null }): FeatureCollection;
export function readGdbCatalog(table: Buffer, tablx: Buffer): { name: string; file: string }[];
