// The types of worldthemes.mjs, for the TypeScript that uses it (the tests).

import type { FeatureCollection } from './globe.mjs';
import type { LonLat, Point } from './project.mjs';
import type { WorldFrameOf } from './world.mjs';

export function riverPicks(text: string): { rank: number | null; names: string[] };
export function buildRivers(collection: FeatureCollection, frame: WorldFrameOf, o: { detail: number; rank?: number | null; names?: readonly string[] }): { id: string; name: string; rank: number; lines: Point[][] }[];
export function buildTowns(collection: FeatureCollection, frame: WorldFrameOf, o: { minPop: number }): { id: string; name: string; country: string; pop: number; capital?: true; at: Point; lonlat: LonLat }[];
export function waterRiskIndicators(fields: readonly { name: string }[]): string[];
export function readWaterRisk(zip: Buffer, o: { indicator: string; frame: WorldFrameOf; table?: string }): FeatureCollection;
export function buildWaterRisk(
  collection: FeatureCollection,
  frame: WorldFrameOf,
  o: { detail: number; minArea: number; indicator: string },
): { indicator: string; classes: { cat: number; label: string; rings: Point[][]; holes: Point[][] }[] };
