// The types of globe.mjs, for the TypeScript that uses it (the tests).

export function globeText(globe: object): string;
export function globeSourcesText(globe: { name: string; body: string; made: Record<string, number> }, lock: readonly { id: string; source: string; bytes: number; sha256: string; dataDate?: string }[], o?: { command?: string }): string;
export function runGlobe(argv: readonly string[], o?: { root?: string; command?: string }): Promise<number>;
