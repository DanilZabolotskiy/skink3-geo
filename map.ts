// A city's map layers for a scene: the types of layers.json, its loading, and the fit of a part of
// the map into the stage. The layers are metres on the plane of a frame, x east and y north; a view
// turns them into stage units, y down, cut to what the stage shows and thinned to what it can draw.
//
//   const town = loadLayers(new URL('./valletta/layers.json', import.meta.url));
//   const view = fitView(town.frames.city.views.metro!, { w: 1920, h: 1080 });
//   const water = ringsOnStage(view, town.city.water!.map((f) => f.ring));          // points of closed regions
//   const coast = linesOnStage(view, town.city.relief!.contours[0]!.lines);         // points of open strokes
//   const grow = morphOnStage(view, town.city.epochs![0]!, town.city.epochs![1]!);  // grow.at(t), t from 0 to 1
//   const far = fitView(town.frames.city.views.wide!, { w: 1920, h: 1080 });
//   const ground = town.city.terrain!.bands.map((b) => ({ band: b.band, pieces: ringsInTiles(far, [b.ring]) }));
//
// This file draws nothing and names no colour: what a layer looks like is the scene's.

import { readFileSync } from 'node:fs';
import { area, clipLine, clipRing, crosses, dedupe, signedArea, simplify, type Box, type Point } from './lib/geom.mjs';
import { projection, type LonLat } from './lib/project.mjs';

export type { Box, LonLat, Point };
export type Ring = Point[];
export type Line = Point[];

export interface Frame {
  /** The centre of the plane, [lon, lat]: the point [0, 0]. */
  centre: LonLat;
  projection: 'laea';
  /** What the layers of the frame cover, [x0, y0, x1, y1] in metres. */
  box: Box;
  lonlat: Box;
}

export interface CityFrame extends Frame {
  /** The named views of the city, each a box in metres: the whole of it, a closer one of its middle. */
  views: Record<string, Box>;
}

export interface RegionLayers {
  /** All the land of the frame, the countries as one. */
  land: { id: string; ring: Ring }[];
  /** The country itself: its mainland and islands. */
  country?: { id: string; name: string; rings: Ring[] };
  /** Its land borders, one entry a neighbour. */
  borders?: { id: string; with: string; lines: Line[] }[];
  rivers?: { id: string; name: string; lines: Line[] }[];
  lakes?: { id: string; name: string; ring: Ring }[];
  /** Where the city is in the region's frame. */
  city: { id: string; name: string; at: Point };
}

export interface Hill {
  id: string;
  name: string;
  /** Its highest point in the elevation model, which may be a roof and stand off the middle. */
  summit: Point;
  /** The middle of its foot: where a label or a mark of the hill belongs. */
  centre: Point;
  /** The height of its high ground in metres above the sea (of the smoothed surface: 19 samples in 20 lie below it). */
  height: number;
  areaHa: number;
  /** From its foot up: each ring lies inside the one before it. */
  rings: { height: number; ring: Ring }[];
}

export interface Epoch {
  id: string;
  /** The year: negative is BC. */
  year: number;
  name: string;
  areaHa: number;
  /** The outline of the city, as detailed as its source. */
  ring: Ring;
  /** The same outline as a fixed number of points, the same for every epoch of the city, in step from one epoch to the next: point k of one epoch moves to point k of the next. */
  morph: Ring;
}

/** The terrain of a wide view, for a map with depth: the land, and its ground in bands of height. */
export interface Terrain {
  /** The view it covers, where the spec names one. */
  view?: string;
  /** What it covers, [x0, y0, x1, y1] in metres. */
  box: Box;
  /** The cell of its grid of heights, in metres: a form smaller than a few cells is not in it. */
  cell: number;
  /** The heights the bands part at, in metres above the sea, the lowest first. */
  levels: number[];
  /** The land that stands out of the sea, the largest first, an island a ring of its own. The sea is what the land leaves. */
  land: { id: string; areaHa: number; ring: Ring }[];
  /**
   * The ground by height, in the order to paint it over the land: a ring before those inside it, so the largest first. A ring at
   * `height` holds the ground at least that high; a `pit` holds a hollow below `height` within higher ground. `band` is what to
   * paint either as: 0 is the land below `levels[0]`, k the ground from `levels[k - 1]` up.
   */
  bands: { id: string; band: number; height: number; pit?: true; areaHa: number; ring: Ring }[];
  /** Standing water apart from the sea, painted over the bands. */
  lakes: { id: string; areaHa: number; ring: Ring }[];
  /** Rivers as lines, each cut where it meets the sea. */
  rivers: { id: string; name: string; lengthKm: number; lines: Line[] }[];
}

export interface CityFrameLayers {
  /** Water as whole forms: a river with its banks, a lake, the sea. */
  water?: { id: string; areaHa: number; ring: Ring }[];
  /** Islands, to be drawn over the water. */
  islands?: { id: string; areaHa: number; ring: Ring }[];
  /** Rivers as lines along their middle. */
  rivers?: { id: string; name: string; lengthKm: number; lines: Line[] }[];
  relief?: {
    contours: { id: string; height: number; rings: Ring[]; lines: Line[] }[];
    hills: Hill[];
  };
  walls?: { id: string; name: string; built?: number; lengthKm: number; areaHa: number; ring: Ring }[];
  /** Main streets, the widest class first. `from` and `to` are the years a street stood, where its source dates it. */
  streets?: { id: string; class: string; name?: string; ref?: string; from?: number; to?: number; lengthKm: number; lines: Line[] }[];
  /**
   * The built-up city, the earliest year first (no `year`: today). `ring` is the body that holds the centre, and `areaHa` its area;
   * `pieces` are the other large bodies, which a strait or a valley parts from it (the far shore of a city on a strait), the largest first.
   */
  builtUp?: { id: string; year?: number; areaHa: number; ring: Ring; pieces: Ring[] }[];
  /** The city's outline through time, the earliest first. */
  epochs?: Epoch[];
  landmarks?: { id: string; name: string; built?: number; at: Point; lonlat: LonLat }[];
  /** The country round the city in its own plane: the land, the lakes, the rivers, the ground in bands of height. */
  terrain?: Terrain;
}

/** layers.json as it is written: `region` in the region's frame, `city` in the city's. */
export interface Layers {
  format: 'cities-geo/1';
  /** The city's id: the name of its directory. */
  id: string;
  name: string;
  frames: { region?: Frame; city: CityFrame };
  region?: RegionLayers;
  city: CityFrameLayers;
}

/** The layers of a city, read from its layers.json: a path, or a URL made from `import.meta.url`. */
export function loadLayers(file: string | URL): Layers {
  const layers = JSON.parse(readFileSync(file, 'utf8')) as Layers;
  if (layers.format !== 'cities-geo/1') throw new Error(`loadLayers: ${String(file)} is of format ${String(layers.format)}, not cities-geo/1`);
  return layers;
}

/**
 * What is wrong with the layers of a city, one line a fault; none when they keep to the format:
 * every outline runs counter-clockwise, does not cross itself and lies in its frame; the epochs
 * come in the order of their years with morph rings of one size; every hill has its rings; the bands
 * of a terrain come in the order to paint them, each with the band of its height.
 */
export function faultsOf(l: Layers): string[] {
  const out: string[] = [];
  const ring = (name: string, pts: readonly Point[], box: Box): void => {
    const m = (box[2] - box[0]) * 0.02 + 1;
    if (pts.length < 3) out.push(`${name}: ${pts.length} points`);
    else if (pts.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || p[0] < box[0] - m || p[0] > box[2] + m || p[1] < box[1] - m || p[1] > box[3] + m)) out.push(`${name}: a point outside its frame`);
    else if (signedArea(pts) <= 0) out.push(`${name}: clockwise`);
    else if (crosses(pts, true)) out.push(`${name}: crosses itself`);
  };
  const city = l.frames.city.box;
  if (l.region && l.frames.region) {
    const box = l.frames.region.box;
    for (const f of l.region.land) ring(`region.land.${f.id}`, f.ring, box);
    for (const [k, r] of (l.region.country?.rings ?? []).entries()) ring(`region.country.${k}`, r, box);
    for (const f of l.region.lakes ?? []) ring(`region.lakes.${f.id}`, f.ring, box);
  } else if (l.region || l.frames.region) out.push('region: the layers and the frame come together, or not at all');
  for (const [name, view] of Object.entries(l.frames.city.views)) if (!(view[0] < view[2] && view[1] < view[3])) out.push(`frames.city.views.${name}: an empty box`);
  for (const f of l.city.water ?? []) ring(`city.water.${f.id}`, f.ring, city);
  for (const f of l.city.islands ?? []) ring(`city.islands.${f.id}`, f.ring, city);
  for (const h of l.city.relief?.hills ?? []) {
    if (h.rings.length === 0 || !(h.height > 0)) out.push(`city.relief.hills.${h.id}: no rings or no height`);
    for (const [k, r] of h.rings.entries()) ring(`city.relief.hills.${h.id}.${k}`, r.ring, city);
  }
  for (const w of l.city.walls ?? []) ring(`city.walls.${w.id}`, w.ring, city);
  for (const b of l.city.builtUp ?? []) {
    ring(`city.builtUp.${b.id}`, b.ring, city);
    for (const [k, r] of b.pieces.entries()) ring(`city.builtUp.${b.id}.pieces.${k}`, r, city);
  }
  const epochs = l.city.epochs ?? [];
  for (const e of epochs) {
    ring(`city.epochs.${e.id}.ring`, e.ring, city);
    ring(`city.epochs.${e.id}.morph`, e.morph, city);
  }
  if (epochs.some((e, k) => k > 0 && e.year < epochs[k - 1]!.year)) out.push('city.epochs: not in the order of their years');
  if (new Set(epochs.map((e) => e.morph.length)).size > 1) out.push('city.epochs: morph rings of different sizes');
  const t = l.city.terrain;
  if (t) {
    if (t.levels.some((level, k) => k > 0 && level <= t.levels[k - 1]!)) out.push('city.terrain.levels: not in rising order');
    for (const f of t.land) ring(`city.terrain.land.${f.id}`, f.ring, t.box);
    for (const f of t.lakes) ring(`city.terrain.lakes.${f.id}`, f.ring, t.box);
    for (const [k, b] of t.bands.entries()) {
      ring(`city.terrain.bands.${b.id}`, b.ring, t.box);
      if (t.levels[b.pit ? b.band : b.band - 1] !== b.height) out.push(`city.terrain.bands.${b.id}: its band is not that of its height`);
      if (k > 0 && area(b.ring) > area(t.bands[k - 1]!.ring)) out.push(`city.terrain.bands.${b.id}: larger than the band painted before it`);
    }
  }
  return out;
}

/** From [lon, lat] to the plane of a frame, for a place the layers do not hold. */
export function toFrame(frame: Frame): (p: LonLat) => Point {
  return projection({ lon: frame.centre[0], lat: frame.centre[1] }).forward;
}

export interface View {
  /** The part of the plane the stage shows, in metres. */
  readonly box: Box;
  /** Stage units a metre. */
  readonly scale: number;
  /** From the plane to the stage: x right, y down. */
  readonly project: (p: readonly number[]) => Point;
}

/**
 * The view that shows the box of the plane on a stage of `w` × `h` units centred on `at` ([0, 0]):
 * `cover` (the default) fills the stage, cropping the box's longer side; `contain` shows the whole box.
 * `zoom` enlarges it about its middle, and `shift` moves the middle of the view, in metres.
 */
export function fitView(box: Box, stage: { w: number; h: number; at?: Point }, o: { mode?: 'cover' | 'contain'; zoom?: number; shift?: Point } = {}): View {
  const [x0, y0, x1, y1] = box;
  const fit = o.mode === 'contain' ? Math.min : Math.max;
  const scale = fit(stage.w / (x1 - x0), stage.h / (y1 - y0)) * (o.zoom ?? 1);
  const cx = (x0 + x1) / 2 + (o.shift?.[0] ?? 0);
  const cy = (y0 + y1) / 2 + (o.shift?.[1] ?? 0);
  const [ax, ay] = stage.at ?? [0, 0];
  const [hw, hh] = [stage.w / 2 / scale, stage.h / 2 / scale];
  return {
    box: [cx - hw, cy - hh, cx + hw, cy + hh],
    scale,
    project: (p) => [tenth(ax + (p[0]! - cx) * scale), tenth(ay - (p[1]! - cy) * scale)],
  };
}

/** A stage coordinate to a tenth of a unit, and never -0: a point a hair left of the middle is at 0, as one a hair right of it is. */
const tenth = (v: number): number => Math.round(v * 10) / 10 + 0;

export interface StageOptions {
  /** The least bend drawn, in stage units (0.6): a shallower one is drawn straight. */
  detail?: number;
  /** The most points an outline may have (200: a renderer's limit for one region). */
  max?: number;
  /** Rings smaller than this on the stage, in square units, are left out (30). */
  minArea?: number;
  /** How far past the stage's edge the map is kept, in stage units (120): room for a camera's drift and push. */
  margin?: number;
}

function grown(view: View, margin: number): Box {
  const m = margin / view.scale;
  return [view.box[0] - m, view.box[1] - m, view.box[2] + m, view.box[3] + m];
}

/** An outline thinned to at most `max` points without crossing itself; null if it cannot be. */
function thin(points: Point[], detail: number, max: number, closed: boolean): Point[] | null {
  for (let t = detail; t >= detail / 64; t /= 2) {
    let tol = t;
    let out = simplify(points, tol, closed);
    while (out.length > max) out = simplify(points, (tol *= 1.3), closed);
    if (!crosses(out, closed)) return out;
  }
  return null;
}

/**
 * Rings of the plane as outlines on the stage: cut to the view (with its margin) into whole rings,
 * thinned to `detail` and to `max` points, none crossing itself. Each is the `points` of a closed
 * `region` or `stroke`.
 */
export function ringsOnStage(view: View, rings: readonly Ring[], o: StageOptions = {}): Point[][] {
  const box = grown(view, o.margin ?? 120);
  const out: Point[][] = [];
  for (const ring of rings) {
    for (const piece of clipRing(ring, box)) {
      const pts = thin(dedupe(piece.map(view.project), 0.05, true), o.detail ?? 0.6, o.max ?? 200, true);
      if (pts && pts.length >= 3 && area(pts) >= (o.minArea ?? 30)) out.push(pts);
    }
  }
  return out;
}

export interface TileOptions extends StageOptions {
  /** The side of a tile, in stage units (480). */
  tile?: number;
  /** How far a tile reaches into its neighbours, in stage units (2), so that fills of one colour leave no seam. */
  overlap?: number;
}

/**
 * Rings of the plane as outlines on the stage, for forms too rich for one outline (the bands of a
 * terrain, the land of a coast): the stage is cut into tiles, each ring into the pieces that lie in
 * each tile, and a piece that still holds more than `max` points at `detail` is cut in four again.
 * So the points limit holds for a piece, and the form keeps its detail. The pieces of a ring come
 * together, in the order of the rings, so the order to paint them in holds. They overlap a little:
 * they are for fills of one colour, and a stroke along them would show the tiles.
 */
export function ringsInTiles(view: View, rings: readonly Ring[], o: TileOptions = {}): Point[][] {
  const box = grown(view, o.margin ?? 120);
  const side = (o.tile ?? 480) / view.scale;
  const lap = (o.overlap ?? 2) / view.scale;
  const detail = o.detail ?? 0.6;
  const max = o.max ?? 200;
  const out: Point[][] = [];
  const emit = (ring: Ring, tile: Box, depth: number): void => {
    for (const piece of clipRing(ring, [tile[0] - lap, tile[1] - lap, tile[2] + lap, tile[3] + lap])) {
      const flat = dedupe(piece.map(view.project), 0.05, true);
      if (flat.length < 3 || area(flat) < 2) continue;
      const pts = depth < 5 && simplify(flat, detail, true).length > max ? null : thin(flat, detail, max, true);
      if (pts) {
        if (pts.length >= 3) out.push(pts);
        continue;
      }
      if (depth >= 5) continue;
      const [mx, my] = [(tile[0] + tile[2]) / 2, (tile[1] + tile[3]) / 2];
      for (const quarter of [[tile[0], tile[1], mx, my], [mx, tile[1], tile[2], my], [tile[0], my, mx, tile[3]], [mx, my, tile[2], tile[3]]] as Box[]) emit(piece, quarter, depth + 1);
    }
  };
  for (const ring of rings) {
    if (area(ring) * view.scale * view.scale < (o.minArea ?? 30)) continue;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of ring) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
    for (let ty = box[1]; ty < box[3]; ty += side) {
      for (let tx = box[0]; tx < box[2]; tx += side) {
        const tile: Box = [tx, ty, Math.min(box[2], tx + side), Math.min(box[3], ty + side)];
        if (x1 < tile[0] - lap || x0 > tile[2] + lap || y1 < tile[1] - lap || y0 > tile[3] + lap) continue;
        emit(ring, tile, 0);
      }
    }
  }
  return out;
}

/** Lines of the plane as lines on the stage: cut to the view (with its margin), thinned the same way. Each is the `points` of an open `stroke`. */

export function linesOnStage(view: View, lines: readonly Line[], o: StageOptions = {}): Point[][] {
  const box = grown(view, o.margin ?? 120);
  const out: Point[][] = [];
  for (const line of lines) {
    for (const piece of clipLine(line, box)) {
      const pts = thin(dedupe(piece.map(view.project), 0.05), o.detail ?? 0.6, o.max ?? 200, false);
      if (pts && pts.length >= 2) out.push(pts);
    }
  }
  return out;
}

/**
 * The morph rings of two epochs on the stage, point for point: `at(t)` is the outline between them,
 * t from 0 (the first) to 1 (the second). Both keep every point, so a scene can also key the two
 * outlines itself.
 */
export function morphOnStage(view: View, from: Epoch, to: Epoch): { from: Point[]; to: Point[]; at: (t: number) => Point[] } {
  const a = from.morph.map(view.project);
  const b = to.morph.map(view.project);
  if (a.length !== b.length) throw new Error(`morphOnStage: ${from.id} has ${a.length} points, ${to.id} has ${b.length}`);
  return { from: a, to: b, at: (t) => a.map((p, k) => [tenth(p[0] + (b[k]![0] - p[0]) * t), tenth(p[1] + (b[k]![1] - p[1]) * t)]) };
}
