// The types of project.mjs, for the TypeScript that uses it (map.ts and the tests).

export type LonLat = [number, number];
export type Point = [number, number];
export type Box = [number, number, number, number];

export interface Projection {
  readonly lon: number;
  readonly lat: number;
  forward(p: readonly number[]): Point;
  inverse(p: readonly number[]): LonLat;
}

export const EARTH_RADIUS: number;
export function projection(centre: { lon: number; lat: number }): Projection;
export function projectBox(proj: Projection, box: Box, steps?: number): Box;
export function unprojectBox(proj: Projection, box: Box, steps?: number): Box;
export function equalEarth(lon?: number): Projection;
