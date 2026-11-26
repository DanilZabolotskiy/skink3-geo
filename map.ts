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
//   const lit = gridOnStage(view, town.city.relief!.grid!);                        // a grid of heights for relief shading
//   const h = heightAt(town.city.relief!.grid!, [500, -200]);                     // metres, for placing things
//   const shore = shoresOnStage(view, town.city.water!.map((f) => f.ring));        // the shores, without the cut
//
// A round body for a globe (globe.mjs) is read the same way: `loadGlobe`, in degrees, for a renderer's own sphere.
// A flat map of the world or of the countries of a box (world.mjs) is read with `loadWorld`, in metres on its frame's
// plane, and put on the stage with `worldOnStage`, through the same views (its first-level divisions with it), and its
// water risk with `waterRiskOnStage`. A route along a map's lines (its sea lanes, say) is `routeAlong`, put on the
// stage whole with `lineOnStage` and drawn on in stretches with `cutLine`.
//
// This file draws nothing and names no colour: what a layer looks like is the scene's.

import { readFileSync } from 'node:fs';
import { area, clipLine, clipRing, crosses, dedupe, orient, pointInRing, signedArea, simplify, type Box, type Point } from './lib/geom.mjs';
import { equalEarth, projection, type LonLat } from './lib/project.mjs';
import { sphericalArea, wholeRing } from './lib/globe.mjs';
import { arcLength, cutLine, greatCircle, routeAlong as routeOnPlane, type Route } from './lib/route.mjs';
import { thinTogether, untangle } from './lib/topology.mjs';

export type { Box, LonLat, Point, Route };
export { arcLength, cutLine, greatCircle };
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

/**
 * The ground as a grid of heights, for relief shading: `cols` by `rows` points `cell` metres apart, from the north-west
 * corner of `box` to its south-east corner, so the points lie on its edges. `values` holds their heights in metres, to
 * a tenth, row by row from the north, each row from the west, as an image holds its pixels.
 */
export interface HeightGrid {
  box: Box;
  cell: number;
  cols: number;
  rows: number;
  values: number[];
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
  /** The ground the bands are traced on, as a grid of heights over `box`, where the spec asks for it (`grid`). */
  grid?: HeightGrid;
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
    /** The ground the contours are traced on, as a grid of heights over the relief's box, where the spec asks for it (`grid`). */
    grid?: HeightGrid;
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
  /**
   * Administrative divisions below the country (OpenStreetMap's `admin_level`), cut to their view: the lowest level first,
   * in a level the largest first, the order to paint them in. `ring` is a division's largest part in the view, `pieces` its
   * other parts, `areaKm2` the area of what is in the view, `at` a point inside `ring` for its label, `osm` its relation.
   * Neighbours of a level share their borders point for point. A division's holes are not cut out.
   */
  divisions?: Division[];
  /**
   * The lines to draw the divisions with as strokes, each once and never along the edge of the view: the border of two
   * divisions (`between` their ids, in order), or the outline of all the divisions of a level where no other lies beyond it
   * (`between` empty: a coast, the edge of a country).
   */
  divisionBorders?: { id: string; level: number; between: string[]; lines: Line[] }[];
  /**
   * Named places (OpenStreetMap's `place`: suburbs, quarters, neighbourhoods, towns...), in the order of the kinds asked for:
   * a point each, and the outline of a place mapped as an area, cut to the view. `osm` is the element it comes from.
   */
  places?: { id: string; name: string; kind: string; osm: string; at: Point; lonlat: LonLat; ring?: Ring }[];
  /**
   * Named features that no other layer has a kind for, in the order of the spec: open lines (a channel, a railway, a
   * runway, an open wall, a street picked by name) and areas (a basin, a lake long filled, a building's footprint, an
   * old district), from mapped elements or drawn after a written source, each cut to its view.
   */
  features?: Feature[];
}

/** A feature of `CityFrameLayers.features`: a line or an area, with the years it stood where the spec gives them. */
export type Feature = LineFeature | AreaFeature;

interface FeatureBase {
  id: string;
  name: string;
  /** The year it was built, and the year it was gone by (negative before the common era). */
  built?: number;
  until?: number;
}

export interface LineFeature extends FeatureBase {
  kind: 'line';
  /** The whole line, also where its view cuts it. */
  lengthKm: number;
  /** The line cut to its view: its ways joined end to end, the longest first, each from its end nearer the start. */
  lines: Line[];
  /**
   * Where the spec marks stretches below the ground: the line in stretches, in order from its start, each above or
   * below the ground, from and to so many kilometres along it, cut to the view (a stretch wholly outside it is left out).
   */
  stretches?: { under: boolean; fromKm: number; toKm: number; lines: Line[] }[];
}

export interface AreaFeature extends FeatureBase {
  kind: 'area';
  /** All of it in its view. */
  areaHa: number;
  /** Its largest part in its view; `pieces` are the others, the largest first. An area keeps no holes. */
  ring: Ring;
  pieces: Ring[];
}

/** An administrative division of `CityFrameLayers.divisions`. */
export interface Division {
  id: string;
  name: string;
  level: number;
  osm: string;
  areaKm2: number;
  at: Point;
  ring: Ring;
  pieces: Ring[];
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
 * of a terrain come in the order to paint them, each with the band of its height; a grid of heights
 * holds a finite height for each of its points, which lie on the edges of its box; the divisions come
 * in the order of their levels, each with its label point inside it and an id of its own, and their
 * borders name divisions that are there; every place stands in its frame; every feature has an id of its own,
 * lines of two points or more in its frame and stretches in order along it, or rings that keep to the format,
 * and ends no earlier than it is built.
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
  const grid = (name: string, g: HeightGrid | undefined): void => {
    if (!g) return;
    const [x0, y0, x1, y1] = g.box;
    if (!(Number.isInteger(g.cols) && Number.isInteger(g.rows) && g.cols >= 2 && g.rows >= 2 && g.cell > 0)) out.push(`${name}: cols, rows or cell out of range`);
    else if (g.values.length !== g.cols * g.rows) out.push(`${name}: ${g.values.length} heights for ${g.cols} by ${g.rows} points`);
    else if (g.values.some((v) => !Number.isFinite(v))) out.push(`${name}: a height that is not a number`);
    else if (Math.abs(x1 - x0 - (g.cols - 1) * g.cell) > 0.2 || Math.abs(y1 - y0 - (g.rows - 1) * g.cell) > 0.2) out.push(`${name}: its points do not lie on the edges of its box`);
  };
  grid('city.relief.grid', l.city.relief?.grid);
  grid('city.terrain.grid', l.city.terrain?.grid);
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
  const point = (name: string, p: Point, box: Box): void => {
    if (!(Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] >= box[0] && p[0] <= box[2] && p[1] >= box[1] && p[1] <= box[3])) out.push(`${name}: outside its frame`);
  };
  const divisions = l.city.divisions ?? [];
  for (const d of divisions) {
    ring(`city.divisions.${d.id}`, d.ring, city);
    for (const [k, r] of d.pieces.entries()) ring(`city.divisions.${d.id}.pieces.${k}`, r, city);
    if (!pointInRing(d.at, d.ring)) out.push(`city.divisions.${d.id}: its label point lies outside it`);
  }
  if (divisions.some((d, k) => k > 0 && d.level < divisions[k - 1]!.level)) out.push('city.divisions: not in the order of their levels');
  if (new Set(divisions.map((d) => d.id)).size < divisions.length) out.push('city.divisions: an id given twice');
  const ids = new Set(divisions.map((d) => d.id));
  for (const b of l.city.divisionBorders ?? []) if (b.between.some((id) => !ids.has(id))) out.push(`city.divisionBorders.${b.id}: between a division that is not there`);
  for (const p of l.city.places ?? []) {
    point(`city.places.${p.id}`, p.at, city);
    if (p.ring) ring(`city.places.${p.id}.ring`, p.ring, city);
  }
  if (new Set((l.city.places ?? []).map((p) => p.id)).size < (l.city.places ?? []).length) out.push('city.places: an id given twice');
  const features = l.city.features ?? [];
  const open = (name: string, pts: readonly Point[]): void => {
    const m = (city[2] - city[0]) * 0.02 + 1;
    if (pts.length < 2) out.push(`${name}: ${pts.length} point(s)`);
    else if (pts.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || p[0] < city[0] - m || p[0] > city[2] + m || p[1] < city[1] - m || p[1] > city[3] + m)) out.push(`${name}: a point outside its frame`);
  };
  for (const f of features) {
    const name = `city.features.${f.id}`;
    if (f.built !== undefined && f.until !== undefined && f.until < f.built) out.push(`${name}: it ends before it is built`);
    if (f.kind === 'area') {
      ring(name, f.ring, city);
      for (const [k, r] of f.pieces.entries()) ring(`${name}.pieces.${k}`, r, city);
      continue;
    }
    if (f.lines.length === 0) out.push(`${name}: no line`);
    for (const [k, line] of f.lines.entries()) open(`${name}.lines.${k}`, line);
    const stretches = f.stretches ?? [];
    for (const [k, s] of stretches.entries()) {
      for (const [j, line] of s.lines.entries()) open(`${name}.stretches.${k}.lines.${j}`, line);
      if (!(s.toKm > s.fromKm) || (k > 0 && s.fromKm < stretches[k - 1]!.toKm) || s.toKm > f.lengthKm + 0.01) out.push(`${name}.stretches.${k}: not in order along the line`);
    }
  }
  if (new Set(features.map((f) => f.id)).size < features.length) out.push('city.features: an id given twice');
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

/** A polygon of a globe's layer: an outer ring, then its holes, in degrees [lon, lat]. */
export interface GlobePolygon {
  id: string;
  areaKm2: number;
  name?: string;
  rings: LonLat[][];
}

/**
 * globe.json as it is written by globe.mjs: a round body for a globe, in degrees [lon, lat]. Seen from outside, an
 * outer ring runs counter-clockwise round what it holds and a hole clockwise; no ring has a point on a pole or a cut
 * of a flat map. A scene's renderer places the points on its own sphere.
 *
 *   const earth = loadGlobe(new URL('./earth/globe.json', import.meta.url));
 *   const land = earth.layers.land!.flatMap((p) => p.rings);                    // every ring of the land, holes too
 *   const lights = earth.places!.slice(0, 800).map((p) => [...p.at, p.pop]);    // the largest towns, by their people
 *   const maria = loadGlobe(moonFile).layers.maria!.flatMap((p) => p.rings);    // the Moon's dark seas
 */
export interface GlobeLayers {
  format: 'globe-geo/1';
  /** `earth` or `moon`. */
  body: string;
  name: string;
  /** The body's mean radius, in kilometres: the areas are of a sphere of it. */
  radiusKm: number;
  /** What it was built with: the thinning in degrees of arc, the least areas in km², and for the Earth the scale of Natural Earth and the least population kept. */
  made: { tolerance: number; minArea: number; digits: number; scale?: number; lakeArea?: number; iceArea?: number; minPop?: number };
  /**
   * The layers, in the order they are painted, each the largest polygon first. The Earth's: `land`, `lakes` (over the
   * land) and `ice` (over the land and the sea). The Moon's: `maria`, its dark seas of basalt over the highlands.
   */
  layers: Record<string, GlobePolygon[]>;
  /** The Earth's towns by their greatest population, the largest first. */
  places?: { name: string; at: LonLat; pop: number }[];
}

/** A globe's layers, read from globe.json: a path, or a URL made from `import.meta.url`. */
export function loadGlobe(file: string | URL): GlobeLayers {
  const globe = JSON.parse(readFileSync(file, 'utf8')) as GlobeLayers;
  if (globe.format !== 'globe-geo/1') throw new Error(`loadGlobe: ${String(file)} is of format ${String(globe.format)}, not globe-geo/1`);
  return globe;
}

/**
 * What is wrong with a globe's layers, one line a fault; none when they keep to the format: every point is a finite
 * [lon, lat] off the poles, every ring has three points or more and is whole on the sphere, outer rings run
 * counter-clockwise seen from outside and holes clockwise, the polygons come largest first, and the towns largest first.
 */
export function globeFaults(g: GlobeLayers): string[] {
  const out: string[] = [];
  if (!(g.radiusKm > 0)) out.push('radiusKm: not a radius');
  for (const [name, list] of Object.entries(g.layers ?? {})) {
    for (const [k, p] of list.entries()) {
      if (k > 0 && p.areaKm2 > list[k - 1]!.areaKm2) out.push(`${name}.${p.id}: larger than the polygon before it`);
      if (p.rings.length === 0) out.push(`${name}.${p.id}: no rings`);
      for (const [j, r] of p.rings.entries()) {
        const at = `${name}.${p.id}.${j}`;
        if (r.length < 3) out.push(`${at}: ${r.length} points`);
        else if (r.some(([lon, lat]) => !Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || Math.abs(lat) >= 89.99)) out.push(`${at}: a point that is not a place off the poles`);
        else if (wholeRing(r)?.length !== r.length) out.push(`${at}: not whole on the sphere (a repeated place, or a line that turns straight back)`);
        else if (sphericalArea(r) > 0 !== (j === 0)) out.push(`${at}: ${j === 0 ? 'an outer ring that runs clockwise' : 'a hole that runs counter-clockwise'}`);
      }
    }
  }
  for (const [k, p] of (g.places ?? []).entries()) {
    if (!Number.isFinite(p.at[0]) || !Number.isFinite(p.at[1]) || Math.abs(p.at[0]) > 180 || Math.abs(p.at[1]) > 90) out.push(`places.${k}: not a place`);
    if (!(p.pop >= 0)) out.push(`places.${k}: no population`);
    if (k > 0 && p.pop > g.places![k - 1]!.pop) out.push(`places.${k}: larger than the town before it`);
  }
  return out;
}

/** A country of a world map. */
export interface WorldCountry {
  /** Natural Earth's code of the country, in lower case (`fra`): what a scene picks a country by. */
  id: string;
  name: string;
  /** Its ISO 3166-1 alpha-3 code (`FRA`), where it has one of its own. */
  iso?: string;
  continent: string;
  /** Where its name may stand: a point inside its main land, on the plane. */
  label: Point;
  /** Its area on the map, in km² (both projections keep areas true; a box's country is the part inside the box). */
  areaKm2: number;
  /** Its pieces of land, counter-clockwise, the largest first. An enclave is a country of its own, painted after the one round it. */
  rings: Ring[];
}

export interface WorldFrame {
  /**
   * `equal-earth`: the whole world, round the meridian of `centre` (0° by default; the map's edge is the meridian
   * opposite it); `laea`: a box, on the plane of a city's region, round `centre`. A box whose `lonlat` has its west
   * east of its east crosses the 180th meridian.
   */
  projection: 'equal-earth' | 'laea';
  centre: LonLat;
  /** What the map covers, [x0, y0, x1, y1] in metres. */
  box: Box;
  lonlat: Box;
  /** The whole world's alone: the edge of the world on the map, a ring the sea fills. */
  outline?: Ring;
}

/** A sea lane of a world map: links of a global shipping network joined end to end. */
export interface WorldLane {
  id: string;
  /** How busy it is, by tens of the network's routes that used it: 0 none, 1 from 1 to 9, 2 from 10 to 99, and so on; the main routes are 5 and above. */
  rank: number;
  /** The waterway's name, where the network gives one. */
  name?: string;
  /** Its pieces on the map (more than one where the map's edge cuts it). */
  lines: Line[];
}

/** A named place of a world map: given by hand, or a port or an airport of Natural Earth. */
export interface WorldPlace {
  id: string;
  name: string;
  kind: 'place' | 'port' | 'airport';
  /** Where it is on the plane; a box's place may lie beyond its edge. */
  at: Point;
  lonlat: LonLat;
}

/** A named line of a world map: mapped elements of OpenStreetMap, a line drawn through places, or a great circle. */
export interface WorldLine {
  id: string;
  name: string;
  kind: 'mapped' | 'drawn' | 'great';
  /** A line drawn through places after a written source: where it ran is known only roughly. */
  approximate?: true;
  /** What it is drawn after, the sentence its SOURCES.md row carries. */
  source: string;
  /** Its whole length on the Earth, in km, also where the map cuts it. */
  lengthKm: number;
  /** Its pieces on the map, the longest first. */
  lines: Line[];
}

/** The sea above a depth: the regions where the ground lies above it (the land with it), the largest first; `holes` are deeper water inside them, painted over in the sea's colour. */
export interface WorldShallows {
  id: string;
  /** Metres below the sea. */
  depth: number;
  rings: Ring[];
  holes: Ring[];
}

/** A first-level division of a country of a world map (a state, a province), from Natural Earth's 1:10m admin-1. */
export interface WorldDivision {
  /** Its ISO 3166-2 code in lower case (`de-by` for `DE-BY`) where it has one of its own, else Natural Earth's code (`deu-1591`). */
  id: string;
  /** Its name in English, as Natural Earth gives it. */
  name: string;
  /** Its ISO 3166-2 code (`DE-BY`), where Natural Earth gives one. */
  code?: string;
  /** The id of its country, as the map's countries have it (`deu`). */
  country: string;
  /** What its country calls it, in English: `State`, `Province`. */
  kind?: string;
  /** The region it belongs to, where its country groups its divisions so. */
  region?: string;
  /** Where its name may stand: a point inside its main piece, on the plane. */
  label: Point;
  /** Its area on the map, in km² (a box's division is the part inside the box). */
  areaKm2: number;
  /** Its pieces, counter-clockwise, the largest first. One inside another division is a division of its own, painted after it. */
  rings: Ring[];
}

/** A river of a world map: Natural Earth's centerlines of one name, joined where they meet. */
export interface WorldRiver {
  id: string;
  /** Its name in English where Natural Earth gives one, else as it writes it. A river it names otherwise along its course comes once a name. */
  name: string;
  /** Natural Earth's scalerank: 0 for the largest rivers, higher for smaller. */
  rank: number;
  /** Its pieces on the map, cut at its edge; a stretch through a lake runs on through it, to be painted under the lake. */
  lines: Line[];
}

/** A town of a world map: a populated place of Natural Earth, with its people. */
export interface WorldTown {
  id: string;
  name: string;
  /** The id of its country, as the map's countries have it (`fra`). */
  country: string;
  /** Its people: Natural Earth's greatest population for it (`pop_max`, the town with its agglomeration). */
  pop: number;
  /** The capital of a country. */
  capital?: true;
  /** Where it stands on the plane, and in degrees. */
  at: Point;
  lonlat: LonLat;
}

/** A category of an indicator of water risk (WRI's Aqueduct): its pieces as one. */
export interface WorldRiskClass {
  /** Aqueduct's category: -1 (arid and of low water use), 0 (low) to 4 (extremely high); -9999 where there is no data. */
  cat: number;
  /** Aqueduct's label of the category, as `Extremely High (>80%)`. */
  label: string;
  /** Its outlines, counter-clockwise, the largest first. */
  rings: Ring[];
  /** The other categories inside them, counter-clockwise too: what is not of this category. */
  holes: Ring[];
}

/**
 * world.json as it is written by world.mjs: a flat map of the whole world, or of the countries of a box, in metres on
 * the plane of its frame, x east and y north. Every ring runs counter-clockwise, and no ring crosses itself. The
 * countries were thinned together, so two neighbours share their border point for point: painted one after the
 * other, they leave no gap and no overlap, and the land is their outline as one. A box's layers are cut to its edge.
 *
 *   const world = loadWorld(new URL('./world/world.json', import.meta.url));
 *   const view = fitView(world.frame.box, { w: 1920, h: 1080 }, { mode: 'contain' });
 *   const map = worldOnStage(view, world);                       // the sea, land, countries, borders, lakes on the stage
 *   const fr = map.countries.find((c) => c.id === 'fra')!;      // a country by its code: its rings, its label
 *   const paris = view.project(toFrame(world.frame)([2.35, 48.86]));   // a place on the map
 */
export interface WorldLayers {
  format: 'world-geo/1';
  /** The name of its directory: `world`, or a box's own. */
  id: string;
  name: string;
  units: string;
  /** What it was built with: Natural Earth's scale, the thinning in metres, the least island in km², the largest rank of lake kept, a box's degrees and centre, and what more it was asked for. */
  made: {
    scale: number;
    detail: number;
    minArea: number;
    lakes: number | null;
    bbox?: Box;
    centre?: LonLat;
    lanes?: true;
    features?: { file: string; sha256: string };
    heights?: { cell: number; stride: number; shallows?: number[] };
    divisions?: string[];
    rivers?: { rank: number | null; names: string[] };
    towns?: number;
    waterRisk?: string;
  };
  frame: WorldFrame;
  /** All the land, the countries as one, the largest first. */
  land: { id: string; ring: Ring }[];
  /** The water inside the land that no country holds (an inland sea), the largest first: painted over the land. */
  gaps: { id: string; ring: Ring }[];
  /** Every country, the largest first. */
  countries: WorldCountry[];
  /** Each land border once, between two countries (their ids in order), as lines; sorted by id, `a-b`. */
  boundaries: { id: string; between: [string, string]; lines: Line[] }[];
  /** The lakes of the ranks asked for, the largest first: painted over the countries. */
  lakes: { id: string; name: string; ring: Ring }[];
  /** The sea lanes (built with --lanes), the busiest first. */
  lanes?: WorldLane[];
  /** The named places and lines of its features file (built with --features). */
  places?: WorldPlace[];
  lines?: WorldLine[];
  /** The heights of the land and the depths of the sea, in metres, the sea floor below 0 (built with --heights). */
  heights?: HeightGrid;
  /** The shallows, the shallowest first (built with --shallows). */
  shallows?: WorldShallows[];
  /** The first-level divisions of the countries asked for (built with --divisions), country by country as `countries` come, in a country the largest first. */
  divisions?: WorldDivision[];
  /** Each border between two divisions of one country once, `a-b` by their ids in order; a border of two countries is in `boundaries`. */
  divisionBorders?: { id: string; between: [string, string]; lines: Line[] }[];
  /** The rivers asked for (built with --rivers), the largest rank first. */
  rivers?: WorldRiver[];
  /** The towns of at least the people asked for (built with --towns), the largest first. */
  towns?: WorldTown[];
  /** An indicator of WRI's Aqueduct 4.0 by category (built with --water-risk); its credit is required. */
  waterRisk?: { indicator: string; classes: WorldRiskClass[] };
}

/** A world map, read from world.json: a path, or a URL made from `import.meta.url`. */
export function loadWorld(file: string | URL): WorldLayers {
  const world = JSON.parse(readFileSync(file, 'utf8')) as WorldLayers;
  if (world.format !== 'world-geo/1') throw new Error(`loadWorld: ${String(file)} is of format ${String(world.format)}, not world-geo/1`);
  return world;
}

/**
 * What is wrong with a world map, one line a fault; none when it keeps to the format: every point is finite and inside
 * the frame's box, every ring has three points or more, runs counter-clockwise and does not cross itself, the
 * countries and the rings of each layer come largest first, the ids are unique, and every border lies between two
 * countries of the map.
 */
export function worldFaults(w: WorldLayers): string[] {
  const out: string[] = [];
  const [x0, y0, x1, y1] = w.frame.box;
  const inBox = (pts: readonly Point[]): boolean => pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && x >= x0 && x <= x1 && y >= y0 && y <= y1);
  const ring = (at: string, r: Ring): void => {
    if (r.length < 3) out.push(`${at}: ${r.length} points`);
    else if (!inBox(r)) out.push(`${at}: a point outside the frame's box`);
    else if (signedArea(r) <= 0) out.push(`${at}: runs clockwise`);
    else if (crosses(r, true)) out.push(`${at}: crosses itself`);
  };
  const largestFirst = (at: string, list: readonly { id: string; ring: Ring }[]): void => {
    for (const [k, f] of list.entries()) {
      ring(`${at}.${f.id}`, f.ring);
      if (k > 0 && area(f.ring) > area(list[k - 1]!.ring)) out.push(`${at}.${f.id}: larger than the ring before it`);
    }
  };
  if (w.frame.outline) ring('frame.outline', w.frame.outline);
  largestFirst('land', w.land);
  largestFirst('gaps', w.gaps);
  largestFirst('lakes', w.lakes);
  const ids = new Set<string>();
  for (const [k, c] of w.countries.entries()) {
    if (ids.has(c.id)) out.push(`countries.${c.id}: twice`);
    ids.add(c.id);
    if (k > 0 && c.areaKm2 > w.countries[k - 1]!.areaKm2) out.push(`countries.${c.id}: larger than the country before it`);
    if (c.rings.length === 0) out.push(`countries.${c.id}: no rings`);
    for (const [j, r] of c.rings.entries()) {
      ring(`countries.${c.id}.${j}`, r);
      if (j > 0 && area(r) > area(c.rings[j - 1]!)) out.push(`countries.${c.id}.${j}: larger than the ring before it`);
    }
    if (!Number.isFinite(c.label[0]) || !Number.isFinite(c.label[1])) out.push(`countries.${c.id}: no label`);
  }
  const seen = new Set<string>();
  for (const b of w.boundaries) {
    const [p, q] = b.between;
    if (seen.has(b.id)) out.push(`boundaries.${b.id}: twice`);
    seen.add(b.id);
    if (!(p < q) || b.id !== `${p}-${q}`) out.push(`boundaries.${b.id}: not the ids of its countries in order`);
    if (!ids.has(p) || !ids.has(q)) out.push(`boundaries.${b.id}: between countries the map does not hold`);
    for (const [j, l] of b.lines.entries()) {
      if (l.length < 2) out.push(`boundaries.${b.id}.${j}: ${l.length} points`);
      else if (!inBox(l)) out.push(`boundaries.${b.id}.${j}: a point outside the frame's box`);
    }
  }
  const lines = (at: string, list: readonly Line[]): void => {
    if (list.length === 0) out.push(`${at}: no lines`);
    for (const [j, l] of list.entries()) {
      if (l.length < 2) out.push(`${at}.${j}: ${l.length} points`);
      else if (!inBox(l)) out.push(`${at}.${j}: a point outside the frame's box`);
    }
  };
  const unique = (at: string, list: readonly { id: string }[]): void => {
    const seen = new Set<string>();
    for (const f of list) {
      if (seen.has(f.id)) out.push(`${at}.${f.id}: twice`);
      seen.add(f.id);
    }
  };
  if (w.lanes) {
    unique('lanes', w.lanes);
    for (const [k, l] of w.lanes.entries()) {
      if (!(Number.isInteger(l.rank) && l.rank >= 0)) out.push(`lanes.${l.id}: its rank is not a whole number of 0 or more`);
      if (k > 0 && l.rank > w.lanes[k - 1]!.rank) out.push(`lanes.${l.id}: of a higher rank than the lane before it`);
      lines(`lanes.${l.id}`, l.lines);
    }
  }
  if (w.places) {
    unique('places', w.places);
    for (const p of w.places) {
      if (!['place', 'port', 'airport'].includes(p.kind)) out.push(`places.${p.id}: no kind "${p.kind}"`);
      if (!p.at.every(Number.isFinite)) out.push(`places.${p.id}: not a point`);
      if (!(Math.abs(p.lonlat[0]) <= 180 && Math.abs(p.lonlat[1]) <= 90)) out.push(`places.${p.id}: not a place on the Earth`);
    }
  }
  if (w.lines) {
    unique('lines', w.lines);
    for (const l of w.lines) {
      if (!['mapped', 'drawn', 'great'].includes(l.kind)) out.push(`lines.${l.id}: no kind "${l.kind}"`);
      if ((l.approximate === true) !== (l.kind === 'drawn')) out.push(`lines.${l.id}: a line drawn through places, and it alone, is approximate`);
      if (!(l.lengthKm > 0)) out.push(`lines.${l.id}: no length`);
      lines(`lines.${l.id}`, l.lines);
    }
  }
  if (w.heights) {
    const g = w.heights;
    if (!(g.cols >= 2 && g.rows >= 2 && g.values.length === g.cols * g.rows)) out.push(`heights: ${g.values.length} heights, not ${g.cols} by ${g.rows}`);
    else if (!g.values.every(Number.isFinite)) out.push('heights: a height that is not a number');
    if (Math.abs(g.box[2] - g.box[0] - (g.cols - 1) * g.cell) > 1 || Math.abs(g.box[3] - g.box[1] - (g.rows - 1) * g.cell) > 1) out.push('heights: its box is not its points apart by its cell');
  }
  if (w.shallows) {
    unique('shallows', w.shallows);
    for (const [k, sh] of w.shallows.entries()) {
      if (k > 0 && !(sh.depth > w.shallows[k - 1]!.depth)) out.push(`shallows.${sh.id}: not deeper than the shallows before it`);
      for (const [j, r] of sh.rings.entries()) ring(`shallows.${sh.id}.${j}`, r);
      for (const [j, r] of sh.holes.entries()) ring(`shallows.${sh.id}.holes.${j}`, r);
    }
  }
  if (w.divisions) {
    unique('divisions', w.divisions);
    const order = new Map(w.countries.map((c, k) => [c.id, k]));
    for (const [k, d] of w.divisions.entries()) {
      if (!order.has(d.country)) out.push(`divisions.${d.id}: of a country the map does not hold (${d.country})`);
      const before = w.divisions[k - 1];
      if (before && (order.get(before.country) ?? 0) > (order.get(d.country) ?? 0)) out.push(`divisions.${d.id}: its country comes before the country of the division before it`);
      else if (before && before.country === d.country && d.areaKm2 > before.areaKm2) out.push(`divisions.${d.id}: larger than the division before it`);
      if (d.rings.length === 0) out.push(`divisions.${d.id}: no rings`);
      for (const [j, r] of d.rings.entries()) {
        ring(`divisions.${d.id}.${j}`, r);
        if (j > 0 && area(r) > area(d.rings[j - 1]!)) out.push(`divisions.${d.id}.${j}: larger than the ring before it`);
      }
      if (!d.label.every(Number.isFinite)) out.push(`divisions.${d.id}: no label`);
    }
    const ids = new Map(w.divisions.map((d) => [d.id, d.country]));
    for (const b of w.divisionBorders ?? []) {
      const [p, q] = b.between;
      if (!(p < q) || b.id !== `${p}-${q}`) out.push(`divisionBorders.${b.id}: not the ids of its divisions in order`);
      if (!ids.has(p) || !ids.has(q)) out.push(`divisionBorders.${b.id}: between divisions the map does not hold`);
      else if (ids.get(p) !== ids.get(q)) out.push(`divisionBorders.${b.id}: between divisions of two countries, whose border is theirs`);
      lines(`divisionBorders.${b.id}`, b.lines);
    }
  } else if (w.divisionBorders) out.push('divisionBorders: borders of divisions the map does not hold');
  if (w.rivers) {
    unique('rivers', w.rivers);
    for (const [k, r] of w.rivers.entries()) {
      if (!(Number.isInteger(r.rank) && r.rank >= 0)) out.push(`rivers.${r.id}: its rank is not a whole number of 0 or more`);
      if (k > 0 && r.rank < w.rivers[k - 1]!.rank) out.push(`rivers.${r.id}: of a lower rank than the river before it`);
      lines(`rivers.${r.id}`, r.lines);
    }
  }
  if (w.towns) {
    unique('towns', w.towns);
    for (const [k, t] of w.towns.entries()) {
      if (!(Number.isInteger(t.pop) && t.pop >= 0)) out.push(`towns.${t.id}: no people`);
      if (k > 0 && t.pop > w.towns[k - 1]!.pop) out.push(`towns.${t.id}: larger than the town before it`);
      if (!inBox([t.at])) out.push(`towns.${t.id}: outside the frame's box`);
      if (!(Math.abs(t.lonlat[0]) <= 180 && Math.abs(t.lonlat[1]) <= 90)) out.push(`towns.${t.id}: not a place on the Earth`);
    }
  }
  if (w.waterRisk) {
    const seen = new Set<number>();
    for (const c of w.waterRisk.classes) {
      if (seen.has(c.cat)) out.push(`waterRisk.${c.cat}: twice`);
      seen.add(c.cat);
      if (!Number.isInteger(c.cat)) out.push(`waterRisk.${c.cat}: not a category`);
      if (c.rings.length === 0) out.push(`waterRisk.${c.cat}: no rings`);
      for (const [j, r] of c.rings.entries()) ring(`waterRisk.${c.cat}.${j}`, r);
      for (const [j, r] of c.holes.entries()) ring(`waterRisk.${c.cat}.holes.${j}`, r);
    }
  }
  return out;
}

/** From [lon, lat] to the plane of a frame, for a place the layers do not hold: a city's, a region's or a world map's. */
export function toFrame(frame: Frame | WorldFrame): (p: LonLat) => Point {
  if (frame.projection === 'equal-earth') return equalEarth(frame.centre[0]).forward;
  return projection({ lon: frame.centre[0], lat: frame.centre[1] }).forward;
}

/** From the plane of a frame back to [lon, lat]: where on the Earth a point of the map is. */
export function fromFrame(frame: Frame | WorldFrame): (p: readonly number[]) => LonLat {
  if (frame.projection === 'equal-earth') return equalEarth(frame.centre[0]).inverse;
  return projection({ lon: frame.centre[0], lat: frame.centre[1] }).inverse;
}

/**
 * The shortest way from one place to another along lines of a map (its sea lanes, a named line, roads), in metres on
 * its plane: both places are snapped to the nearest point of the lines, and the path between is one polyline through
 * the lines' own points, `points`, from the place `from` to the place `to` (lib/route.mjs says how). `join` is how near
 * two points are to be one junction, and how near a line's end is to come to another line to join it (0: only where
 * lines share a point; the lines of one map meet exactly); `reach` the farthest a place may lie from the lines. With
 * `frame`, each stretch is measured on the Earth (`length` in metres along the ground); without it, on the plane.
 * Places the lines do not join are refused.
 *
 *   const lanes = world.lanes!.filter((l) => l.rank >= 3).flatMap((l) => l.lines);
 *   const way = routeAlong(lanes, port.at, other.at, { frame: world.frame });
 *   const path = lineOnStage(view, way.points);              // one polyline; draw it on with cutLine(path, 0, t, { share: true })
 */
export function routeAlong(lines: readonly Line[], from: readonly number[], to: readonly number[], o: { join?: number; reach?: number; frame?: Frame | WorldFrame } = {}): Route {
  const back = o.frame ? fromFrame(o.frame) : null;
  return routeOnPlane(lines, from, to, {
    ...(o.join === undefined ? {} : { join: o.join }),
    ...(o.reach === undefined ? {} : { reach: o.reach }),
    ...(back ? { measure: (a: Point, b: Point) => arcLength(back(a), back(b)) } : {}),
  });
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
 * One line of the plane as one line on the stage, whole: thinned as `linesOnStage` thins, but never cut at the view's
 * edge, so a route that runs off the stage and back stays one polyline, and a share of it (`cutLine(points, 0, t,
 * { share: true })`) is that share of the whole way. A line longer than `max` points (200) is thinned until it fits.
 */
export function lineOnStage(view: View, line: Line, o: Pick<StageOptions, 'detail' | 'max'> = {}): Point[] {
  if (line.length < 2) throw new Error(`lineOnStage: a line is two points or more, got ${line.length}`);
  const flat = dedupe(line.map(view.project), 0.05);
  if (flat.length < 2) return [flat[0]!, [flat[0]![0], flat[0]![1]]];
  const max = o.max ?? 200;
  let tol = o.detail ?? 0.6;
  let out = simplify(flat, tol, false);
  while (out.length > max) out = simplify(flat, (tol *= 1.3), false);
  return out;
}

export interface ShoreOptions extends StageOptions {
  /** How near the edge of the cut a point of an outline lies to count as on it, in stage units (0.5). */
  tolerance?: number;
}

/**
 * The shores of rings on the stage: the outlines `ringsOnStage` gives for the same rings and options, each as open
 * lines that leave out its stretches along the edge it was cut at, so that a line drawn along the shore never runs
 * along the cut. A line keeps the point where it meets the cut at each end; a ring that the cut does not touch comes
 * as one line, closed by its first point repeated. Each is the `points` of an open `stroke`.
 */
export function shoresOnStage(view: View, rings: readonly Ring[], o: ShoreOptions = {}): Point[][] {
  const tol = o.tolerance ?? 0.5;
  const box = grown(view, o.margin ?? 120);
  const [x0, y0] = view.project([box[0], box[3]]);
  const [x1, y1] = view.project([box[2], box[1]]);
  // The edges of the cut a point lies on, one bit an edge: a stretch between two points on one edge runs along the cut.
  const on = (p: Point): number => (Math.abs(p[0] - x0) <= tol ? 1 : 0) | (Math.abs(p[0] - x1) <= tol ? 2 : 0) | (Math.abs(p[1] - y0) <= tol ? 4 : 0) | (Math.abs(p[1] - y1) <= tol ? 8 : 0);
  const out: Point[][] = [];
  for (const pts of ringsOnStage(view, rings, o)) {
    const n = pts.length;
    const edges = pts.map(on);
    const cut = pts.map((_, i) => (edges[i]! & edges[(i + 1) % n]!) !== 0);
    if (!cut.includes(true)) {
      out.push([...pts, pts[0]!]);
      continue;
    }
    // From the end of a stretch along the cut round to it again: each run of stretches off the cut is a line.
    const start = cut.findIndex((_, i) => cut[(i - 1 + n) % n]);
    let line: Point[] = [pts[start]!];
    for (let j = 0; j < n; j++) {
      const i = (start + j) % n;
      const next = pts[(i + 1) % n]!;
      if (cut[i]) {
        if (line.length > 1) out.push(line);
        line = [next];
      } else line.push(next);
    }
  }
  return out;
}

/** A grid of heights on the stage, as the engine's `relief` takes it. */
export interface GridOnStage {
  /** The middle of the rect the grid covers on the stage, and its size: the first point at its top left, the last at its bottom right. */
  at: Point;
  w: number;
  h: number;
  /** The heights in metres, row by row from the top of the rect, each row from its left. */
  heights: { cols: number; rows: number; values: number[] };
  /** Stage units to a metre of height: the slopes drawn true. A scene multiplies it to steepen them. */
  vertical: number;
}

/**
 * The part of a grid of heights that a view shows, with its margin (120 units), on the stage: the rect it covers, its
 * heights from the top row of the rect, and the `vertical` scale that draws its slopes true. It is what the engine's
 * `relief` node takes: `relief({ id, ...gridOnStage(view, grid), dark, bright, tints })`. With `floor`, a height
 * below it is that height: a world map's heights with `floor: 0` light the land alone, the sea flat at its level.
 */
export function gridOnStage(view: View, grid: HeightGrid, o: { margin?: number; floor?: number } = {}): GridOnStage {
  const box = grown(view, o.margin ?? 120);
  const { cell, cols, rows } = grid;
  const [gx0, , , gy1] = grid.box;
  // The points the view holds, and one more on each side, so the rect covers it.
  const c0 = Math.max(0, Math.floor((box[0] - gx0) / cell));
  const c1 = Math.min(cols - 1, Math.ceil((box[2] - gx0) / cell));
  const r0 = Math.max(0, Math.floor((gy1 - box[3]) / cell));
  const r1 = Math.min(rows - 1, Math.ceil((gy1 - box[1]) / cell));
  if (c1 - c0 < 1 || r1 - r0 < 1) throw new Error('gridOnStage: the grid lies outside the view');
  const values: number[] = [];
  const floor = o.floor;
  if (floor !== undefined && !Number.isFinite(floor)) throw new Error(`gridOnStage: "floor" is a height in metres, got ${floor}`);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) values.push(floor === undefined ? grid.values[r * cols + c]! : Math.max(floor, grid.values[r * cols + c]!));
  const west = gx0 + c0 * cell;
  const north = gy1 - r0 * cell;
  const [w, h] = [(c1 - c0) * cell, (r1 - r0) * cell];
  return {
    at: view.project([west + w / 2, north - h / 2]),
    w: tenth(w * view.scale),
    h: tenth(h * view.scale),
    heights: { cols: c1 - c0 + 1, rows: r1 - r0 + 1, values },
    vertical: view.scale,
  };
}

/**
 * The height of the ground at a place (metres, x east and y north, as the layers hold places), read off a grid of
 * heights between its four nearest points; null outside the grid. It places things by the ground (woods over a
 * height, a road over a pass) where a scene needs a number; the ground itself is drawn by a renderer from
 * `gridOnStage`.
 */
export function heightAt(grid: HeightGrid, p: readonly number[]): number | null {
  const { box, cell, cols, rows, values } = grid;
  const u = (p[0]! - box[0]) / cell;
  const v = (box[3] - p[1]!) / cell;
  if (!(u >= 0 && v >= 0 && u <= cols - 1 && v <= rows - 1)) return null;
  const c0 = Math.min(cols - 2, Math.floor(u));
  const r0 = Math.min(rows - 2, Math.floor(v));
  const [fu, fv] = [u - c0, v - r0];
  const at = (c: number, r: number): number => values[r * cols + c]!;
  const top = at(c0, r0) * (1 - fu) + at(c0 + 1, r0) * fu;
  const bottom = at(c0, r0 + 1) * (1 - fu) + at(c0 + 1, r0 + 1) * fu;
  return top * (1 - fv) + bottom * fv;
}

/**
 * A fine grid of heights eased into a coarse one at its edges: within `margin` metres of the edge of its box each
 * height of `fine` turns, along a smooth curve, toward the height of `coarse` at that place, and on the edge itself
 * it is that height. Two reliefs drawn from them, the fine one over the coarse one, meet without a seam: their
 * ground is one at the edge, and the fine one adds its detail inside. Where `coarse` has no height, `fine` keeps its
 * own. The grid it gives has the box, cell and points of `fine`.
 */
export function blendGrid(fine: HeightGrid, coarse: HeightGrid, o: { margin: number }): HeightGrid {
  const margin = o.margin;
  if (!(Number.isFinite(margin) && margin > 0)) throw new Error('blendGrid: "margin" is the metres over which the fine grid turns into the coarse one, above 0');
  const { box, cell, cols, rows } = fine;
  const values = fine.values.slice();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = box[0] + c * cell;
      const y = box[3] - r * cell;
      const edge = Math.min(x - box[0], box[2] - x, y - box[1], box[3] - y);
      if (edge >= margin) continue;
      const under = heightAt(coarse, [x, y]);
      if (under === null) continue;
      const t = Math.max(0, edge) / margin;
      const keep = t * t * (3 - 2 * t);
      const k = r * cols + c;
      values[k] = Math.round((under + (values[k]! - under) * keep) * 10) / 10 + 0;
    }
  }
  return { ...fine, values };
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

export interface WorldStageOptions {
  /** The least bend drawn, in stage units (0.3): the countries are thinned together to it, so neighbours keep one border. */
  detail?: number;
  /** Islands and lakes smaller than this on the stage, in square units, are left out (2); a country keeps its largest piece while it covers anything on the stage. */
  minArea?: number;
  /** How far past the stage's edge the map is kept, in stage units (120): room for a camera's drift and push. */
  margin?: number;
}

/** A world map on the stage, as `worldOnStage` gives it: every outline in stage units, cut to the view and its margin. */
export interface WorldOnStage {
  /** The edge of the world, the sea's outline: a whole world's alone. */
  sea: Point[][];
  /** The land, the countries as one, the largest first. */
  land: Point[][];
  /** The water inside the land that no country holds. */
  gaps: Point[][];
  /** The countries the view holds, in the map's order (the largest first): an enclave after the country round it. */
  countries: { id: string; name: string; label: Point; rings: Point[][] }[];
  /** Each land border once, every one the view holds, an enclave's too. */
  borders: { id: string; between: [string, string]; lines: Point[][] }[];
  lakes: { id: string; name: string; rings: Point[][] }[];
  /** A map with divisions alone: those the view holds, in the map's order, each sharing its outer edge with its country point for point. */
  divisions?: { id: string; name: string; code?: string; country: string; label: Point; rings: Point[][] }[];
  /** A map with divisions alone: each border between two divisions of one country once, every one the view holds. */
  divisionBorders?: { id: string; between: [string, string]; lines: Point[][] }[];
}

/**
 * A world map on the stage: its countries, land, borders, lakes and the sea, cut to the view (with its margin) and
 * thinned together on the stage, as the map itself was thinned: a border is the same points in both its countries,
 * so neighbours painted one after the other leave no seam, a border stroke lies exactly on their edges, and no
 * outline crosses itself, even where a narrow spit of land comes closer than the stage's tenths (there a point is
 * taken out of that outline alone). Each outline is the `points` of a flat `region` (up to 4000 points) or of a
 * `stroke`. A country the view does not hold, or too small to cover anything on the stage, is left out.
 */
export function worldOnStage(view: View, world: WorldLayers, o: WorldStageOptions = {}): WorldOnStage {
  const detail = o.detail ?? 0.3;
  const minArea = o.minArea ?? 2;
  if (!(detail > 0)) throw new Error(`worldOnStage: detail must be above 0, got ${detail}`);
  const box = grown(view, o.margin ?? 120);
  // The view's own map from the plane to the stage, without its rounding: the topology rounds once, at the end.
  const [cx, cy] = [(view.box[0] + view.box[2]) / 2, (view.box[1] + view.box[3]) / 2];
  const [ax, ay] = view.project([cx, cy]);
  const raw = (p: readonly number[]): Point => [ax + (p[0]! - cx) * view.scale, ay - (p[1]! - cy) * view.scale];
  const cut = (ring: Ring): Point[][] => clipRing(ring, box).map((piece) => piece.map(raw));
  // An enclave is a hole in the country round it: so their border is found, and the land does not count it twice. The
  // same holds for a division inside another division.
  const enclaves = (list: readonly { label: Point; areaKm2: number; rings: Ring[] }[]): Ring[][] => {
    const holes = list.map((): Ring[] => []);
    for (const c of list) {
      if (c.rings.length !== 1 || !pointInRing(c.label, c.rings[0]!)) continue;
      const round = list.findIndex((d) => d !== c && d.areaKm2 > c.areaKm2 && d.rings.some((r) => pointInRing(c.label, r)));
      if (round >= 0) holes[round]!.push(c.rings[0]!);
    }
    return holes;
  };
  const shapesOf = (list: readonly { label: Point; areaKm2: number; rings: Ring[] }[], level: 0 | 1): { rings: { points: Point[]; hole?: true }[]; level?: 1 }[] => {
    const holes = enclaves(list);
    return list.map((c, k) => ({
      rings: [...c.rings.flatMap((r) => cut(r).map((points) => ({ points }))), ...holes[k]!.flatMap((r) => cut(r).map((points) => ({ points, hole: true as const })))],
      ...(level === 1 ? { level: 1 as const } : {}),
    }));
  };
  // The divisions lie over their countries, thinned with them: a division keeps its outer edge with its country.
  const divisions = world.divisions ?? [];
  const t = thinTogether([...shapesOf(world.countries, 0), ...(world.divisions ? shapesOf(divisions, 1) : [])], { tol: detail, minArea, digits: 1 });
  // On a small stage a few outlines still touch themselves in the stage's tenths: points are taken out of those alone.
  const whole = (rings: Point[][]): Point[][] => rings.map((r) => (crosses(r, true) ? untangle(r) : r)).filter((r): r is Point[] => r !== null && r.length >= 3 && area(r) > 0);
  const countries = world.countries
    .map((c, k) => ({ id: c.id, name: c.name, label: view.project(c.label), rings: whole(t.shapes[k]!.rings) }))
    .filter((c) => c.rings.length > 0);
  const borders = t.borders
    .map((b) => {
      const [p, q] = [world.countries[b.a]!.id, world.countries[b.b]!.id].sort() as [string, string];
      return { id: `${p}-${q}`, between: [p, q] as [string, string], lines: b.lines };
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const water = thinTogether(world.lakes.map((l) => ({ rings: cut(l.ring).map((points) => ({ points })) })), { tol: detail, digits: 1 });
  const lakes = world.lakes.map((l, k) => ({ id: l.id, name: l.name, rings: whole(water.shapes[k]!.rings).filter((r) => area(r) >= minArea) })).filter((l) => l.rings.length > 0);
  const sea = world.frame.outline ? cut(world.frame.outline).map((r) => dedupe(simplify(r, detail, true).map(([x, y]) => [tenth(x), tenth(y)] as Point), 0, true)) : [];
  const out: WorldOnStage = { sea, land: whole(t.land).filter((r) => area(r) >= minArea), gaps: whole(t.gaps.map((r) => orient(r, true))).filter((r) => area(r) >= minArea), countries, borders, lakes };
  if (!world.divisions) return out;
  const n = world.countries.length;
  out.divisions = divisions
    .map((d, j) => ({ id: d.id, name: d.name, ...(d.code ? { code: d.code } : {}), country: d.country, label: view.project(d.label), rings: whole(t.shapes[n + j]!.rings) }))
    .filter((d) => d.rings.length > 0);
  out.divisionBorders = (t.inner?.borders ?? [])
    .filter((b) => divisions[b.a - n]!.country === divisions[b.b - n]!.country)
    .map((b) => {
      const [p, q] = [divisions[b.a - n]!.id, divisions[b.b - n]!.id].sort() as [string, string];
      return { id: `${p}-${q}`, between: [p, q] as [string, string], lines: b.lines };
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return out;
}

/** A category of water risk on the stage, as `waterRiskOnStage` gives it. */
export interface RiskClassOnStage {
  cat: number;
  label: string;
  /** Its outlines on the stage, the largest first. */
  rings: Point[][];
  /** The other categories inside them, wound against `rings`: a fill by winding of the two lists together cuts them out. */
  holes: Point[][];
}

/**
 * A world map's water risk (built with --water-risk) on the stage: its categories cut to the view and its margin and
 * thinned together again, so two categories share their border point for point. Each category is `rings` less its
 * `holes`: painted as one shape that fills by winding (`fillRings({ rings: [...c.rings, ...c.holes] })` of the
 * engine), its holes cut out; or every ring of every category painted as a flat region, the largest first, so the
 * categories inside a hole are painted over it. Categories smaller than `minArea` on the stage are left out.
 */
export function waterRiskOnStage(view: View, world: WorldLayers, o: WorldStageOptions = {}): RiskClassOnStage[] {
  if (!world.waterRisk) throw new Error('waterRiskOnStage: the map has no water risk (build it with --water-risk)');
  const detail = o.detail ?? 0.3;
  const minArea = o.minArea ?? 2;
  if (!(detail > 0)) throw new Error(`waterRiskOnStage: detail must be above 0, got ${detail}`);
  const box = grown(view, o.margin ?? 120);
  const [cx, cy] = [(view.box[0] + view.box[2]) / 2, (view.box[1] + view.box[3]) / 2];
  const [ax, ay] = view.project([cx, cy]);
  const raw = (p: readonly number[]): Point => [ax + (p[0]! - cx) * view.scale, ay - (p[1]! - cy) * view.scale];
  const cut = (ring: Ring): Point[][] => clipRing(ring, box).map((piece) => piece.map(raw));
  const classes = world.waterRisk.classes;
  const t = thinTogether(
    classes.map((c, k) => ({ rings: [...c.rings.flatMap((r) => cut(r).map((points) => ({ points }))), ...c.holes.flatMap((r) => cut(r).map((points) => ({ points, hole: true })))], group: k })),
    { tol: detail, minArea, digits: 1 },
  );
  const whole = (rings: Point[][]): Point[][] => rings.map((r) => (crosses(r, true) ? untangle(r) : r)).filter((r): r is Point[] => r !== null && r.length >= 3 && area(r) >= minArea);
  return (t.groups ?? [])
    .map((g) => {
      const c = classes[g.key as number]!;
      const rings = whole(g.land);
      // On the stage y runs down: the rings are wound one way, the holes, as the topology gives them, the other.
      return { cat: c.cat, label: c.label, rings, holes: whole(g.gaps) };
    })
    .filter((c) => c.rings.length > 0);
}

export interface DivisionsOnStage {
  /** The divisions the view holds, in the layer's order (the lowest level first, in a level the largest first): `label` is `at` on the stage. */
  divisions: { id: string; name: string; level: number; label: Point; rings: Point[][] }[];
  /** Each border between two divisions of a level once, every one the view holds. */
  borders: { id: string; level: number; between: [string, string]; lines: Point[][] }[];
}

/**
 * A city's divisions on the stage as a world map's countries are (`worldOnStage`, with its options): cut to the view and
 * its margin and thinned together again, level by level, so two neighbours keep one border on the stage too, and areas
 * shaded along the divisions meet with no hairline between them. A division inside another of its level borders it.
 */
export function divisionsOnStage(view: View, divisions: readonly Division[], o: WorldStageOptions = {}): DivisionsOnStage {
  const out: DivisionsOnStage = { divisions: [], borders: [] };
  for (const level of [...new Set(divisions.map((d) => d.level))]) {
    const countries = divisions.filter((d) => d.level === level).map((d) => ({ id: d.id, name: d.name, continent: '', label: d.at, areaKm2: d.areaKm2, rings: [d.ring, ...d.pieces] }));
    const frame: WorldFrame = { projection: 'laea', centre: [0, 0], box: view.box, lonlat: view.box };
    const map = worldOnStage(view, { format: 'world-geo/1', id: 'divisions', name: '', units: '', made: { scale: 0, detail: 0, minArea: 0, lakes: null }, frame, land: [], gaps: [], countries, boundaries: [], lakes: [] }, o);
    out.divisions.push(...map.countries.map((c) => ({ id: c.id, name: c.name, level, label: c.label, rings: c.rings })));
    out.borders.push(...map.borders.map((b) => ({ id: b.id, level, between: b.between, lines: b.lines })));
  }
  return out;
}
