// The types of route.mjs, for the TypeScript that uses it (map.ts and the tests).

import type { LonLat, Point } from './project.mjs';

export function arcLength(a: readonly number[], b: readonly number[]): number;
export function greatCircle(a: LonLat, b: LonLat, o?: { step?: number }): LonLat[];
export function cutLine(points: readonly (readonly number[])[], from: number, to: number, o?: { share?: boolean }): Point[];
export interface RouteOptions {
  join?: number;
  reach?: number;
  measure?: (a: Point, b: Point) => number;
}
export interface Route {
  points: Point[];
  length: number;
  ends: [Point, Point];
  off: [number, number];
}
export function routeAlong(lines: readonly (readonly (readonly number[])[])[], from: readonly number[], to: readonly number[], o?: RouteOptions): Route;
