// The types of netcdf.mjs, for the TypeScript that uses it (the tests).

export interface NetcdfVariable {
  name: string;
  dims: string[];
  shape: number[];
  attrs: Record<string, string | number[]>;
  type: 'byte' | 'char' | 'short' | 'int' | 'float' | 'double';
  typeId: number;
  begin: number;
  size: number;
}
export interface NetcdfHeader {
  records: number;
  dims: { name: string; size: number }[];
  attrs: Record<string, string | number[]>;
  vars: NetcdfVariable[];
}
export function readNetcdfHeader(bytes: Uint8Array): NetcdfHeader;
export function readNetcdfVariable(bytes: Uint8Array, varName: string): { values: Float64Array; shape: number[]; dims: string[]; attrs: Record<string, string | number[]> };
