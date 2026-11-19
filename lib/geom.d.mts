// The types of geom.mjs, for the TypeScript that uses it (map.ts and the tests).

export type Point = [number, number];
export type Box = [number, number, number, number];

export function dist(a: readonly number[], b: readonly number[]): number;
export function signedArea(ring: readonly Point[]): number;
export function area(ring: readonly Point[]): number;
export function orient(ring: readonly Point[], ccw?: boolean): Point[];
export function lengthOf(points: readonly Point[], closed?: boolean): number;
export function boxOf(points: readonly Point[]): Box;
export function boxesMeet(a: Box, b: Box): boolean;
export function centroid(ring: readonly Point[]): Point;
export function pointInRing(p: readonly number[], ring: readonly Point[]): boolean;
export function dedupe(points: readonly Point[], eps?: number, closed?: boolean): Point[];
export function roundPoints(points: readonly Point[], digits?: number, closed?: boolean): Point[];
export function simplify(points: readonly Point[], tol: number, closed?: boolean): Point[];
export function crosses(points: readonly Point[], closed?: boolean): boolean;
export function simplifySafe(points: readonly Point[], tol: number, closed?: boolean): Point[] | null;
export function chaikin(points: readonly Point[], times?: number, closed?: boolean, reach?: number): Point[];
export function soften(points: readonly Point[], tol: number, times?: number, closed?: boolean, reach?: number): Point[] | null;
export function resample(points: readonly Point[], n: number, closed?: boolean): Point[];
export function alignTo(ring: readonly Point[], ref: readonly Point[]): Point[];
export function morphRings(rings: readonly (readonly Point[])[], n: number): Point[][];
export function clipLine(points: readonly Point[], box: Box): Point[][];
export function closeChains(chains: readonly (readonly Point[])[], box: Box): Point[][];
export function clipRing(ring: readonly Point[], box: Box): Point[][];
