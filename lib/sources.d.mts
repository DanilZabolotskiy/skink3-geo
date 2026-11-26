// The types of sources.mjs, for the TypeScript that uses it (the tests).

import type { Box } from './project.mjs';

export interface Licence {
  name: string;
  licence: string;
  credit: string;
  required: boolean;
  url: string;
}
export interface Download {
  path: string;
  sha256: string;
  bytes: number;
  url: string;
  fetched: string;
  cached: boolean;
}
type Fetch = { cache: string; offline?: boolean; log?: (line: string) => void };

export const LICENCES: Record<string, Licence>;
export function licencesWith(changes?: Record<string, Partial<Licence>>): Record<string, Licence>;
export const NATURAL_EARTH_VERSION: string;
export function naturalEarth(o: Fetch & { name: string }): Promise<Download>;
export const AWMC_COMMIT: string;
export function awmcName(file: string): string;
export function awmc(o: Fetch & { file: string }): Promise<Download>;
export function copernicusName(lon: number, lat: number): string;
export function copernicusTile(o: Fetch & { lon: number; lat: number }): Promise<Download | null>;
export function copernicusWaterMask(o: Fetch & { lon: number; lat: number }): Promise<Download | null>;
export function tilesOf(box: Box): [number, number][];
export const SHIPPING_LANES_COMMIT: string;
export function shippingLanes(o: Fetch): Promise<Download>;
export function etopoRequest(box: Box, stride: number): { query: string; url: string };
export function etopo(o: Fetch & { box: Box; stride: number; part?: number }): Promise<Download>;
export function creditOf(row: Licence, key: string, lock?: readonly { source: string; retrieved?: string }[]): string;
export const AQUEDUCT: { id: string; url: string; request: string; dataDate: string; table: string };
export function aqueduct(o: Fetch): Promise<Download>;
