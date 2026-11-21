// The types of world.mjs, for the TypeScript that uses it (the tests).

export function worldText(world: object): string;
export function worldSourcesText(
  world: { name: string; frame: { projection: string }; made: { scale: number; detail: number; minArea: number; lakes: number | null; bbox?: number[]; centre?: number[] }; stats: { mended: number } },
  lock: readonly { id: string; source: string; bytes: number; sha256: string; dataDate?: string }[],
  o?: { command?: string },
): string;
export function runWorld(argv: readonly string[], o?: { root?: string; command?: string }): Promise<number>;
