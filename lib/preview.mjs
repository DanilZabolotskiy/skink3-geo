// Plain previews of a city's layers, to check that everything is in its place: the region, each view
// of the city, its terrain, and the morph rings of the epochs. They are not a design: the look of a
// frame is the work of whoever draws it. Drawn with skia-canvas, 1920 × 1080, into out/<city>/ (not
// committed).

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const W = 1920;
const H = 1080;

/** The canvas, loaded only when a preview is drawn: a build without previews needs no package at all. */
const canvasKit = () => import('skia-canvas');

/** The fit of a box of the plane into the picture, whole, with a margin: (point) -> pixel. */
function fit([x0, y0, x1, y1], margin = 30) {
  const k = Math.min((W - 2 * margin) / (x1 - x0), (H - 2 * margin) / (y1 - y0));
  const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
  const to = ([x, y]) => [W / 2 + (x - cx) * k, H / 2 - (y - cy) * k];
  to.k = k;
  return to;
}

function path(ctx, to, points, closed) {
  ctx.beginPath();
  points.forEach((p, i) => {
    const [x, y] = to(p);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  if (closed) ctx.closePath();
}

const fill = (ctx, to, ring, colour) => {
  path(ctx, to, ring, true);
  ctx.fillStyle = colour;
  ctx.fill();
};

const line = (ctx, to, points, colour, width, closed = false, dash = []) => {
  path(ctx, to, points, closed);
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.setLineDash(dash);
  ctx.stroke();
  ctx.setLineDash([]);
};

function label(ctx, [x, y], text, colour = '#1b1b2a', size = 22) {
  ctx.font = `600 ${size}px sans-serif`;
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.strokeText(text, x + 10, y + 7);
  ctx.fillStyle = colour;
  ctx.fillText(text, x + 10, y + 7);
}

const dot = (ctx, [x, y], colour, r = 6) => {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = colour;
  ctx.fill();
};

const EPOCH_COLOURS = ['#b3261e', '#d9622b', '#e3a01c', '#8fae3c', '#3f9e8a', '#3f6fb5', '#7a4fb0', '#b04f93'];

function scaleBar(ctx, to, metres, text) {
  const px = metres * to.k;
  ctx.fillStyle = '#1b1b2a';
  ctx.fillRect(40, H - 46, px, 6);
  label(ctx, [30, H - 66], text, '#1b1b2a', 20);
}

function drawRegion(ctx, layers) {
  const r = layers.region;
  const to = fit(layers.frames.region.box, 10);
  ctx.fillStyle = '#9ec9e8';
  ctx.fillRect(0, 0, W, H);
  for (const f of r.land) fill(ctx, to, f.ring, '#d8d3c4');
  for (const ring of r.country?.rings ?? []) fill(ctx, to, ring, '#e9a64b');
  for (const f of r.lakes ?? []) fill(ctx, to, f.ring, '#6fb1dc');
  for (const f of r.rivers ?? []) for (const l of f.lines) line(ctx, to, l, '#2f7fc0', 2.5);
  for (const b of r.borders ?? []) for (const l of b.lines) line(ctx, to, l, '#7a3b1c', 2, false, [8, 5]);
  dot(ctx, to(r.city.at), '#b3261e', 8);
  label(ctx, to(r.city.at), r.city.name, '#1b1b2a', 28);
  for (const f of r.rivers ?? []) if (f.lines[0]) label(ctx, to(f.lines[0][Math.floor(f.lines[0].length / 2)]), f.name, '#1d5f96', 18);
  scaleBar(ctx, to, 200000, '200 km');
}

function drawCity(ctx, layers, viewName) {
  const c = layers.city;
  const box = layers.frames.city.views[viewName];
  const to = fit(box, 0);
  const wide = box[2] - box[0] > 20000;
  ctx.fillStyle = '#efe9da';
  ctx.fillRect(0, 0, W, H);
  if (!wide) {
    for (const level of c.relief?.contours ?? []) {
      for (const ring of level.rings) line(ctx, to, ring, '#c9bfa6', 1.5, true);
      for (const l of level.lines) line(ctx, to, l, '#c9bfa6', 1.5);
    }
  }
  const epochs = [...(c.epochs ?? [])].sort((a, b) => b.areaHa - a.areaHa);
  const colourOf = (e) => EPOCH_COLOURS[(c.epochs ?? []).findIndex((x) => x.id === e.id) % EPOCH_COLOURS.length];
  for (const e of epochs) {
    path(ctx, to, e.ring, true);
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = colourOf(e);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  if (!wide) {
    for (const hill of c.relief?.hills ?? []) {
      hill.rings.forEach((r, k) => {
        path(ctx, to, r.ring, true);
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = k === 0 ? '#b79a62' : '#9a7b45';
        ctx.fill();
        ctx.globalAlpha = 1;
      });
    }
  }
  fillDivisions(ctx, to, c);
  for (const f of c.water ?? []) fill(ctx, to, f.ring, '#6fb1dc');
  for (const f of c.islands ?? []) fill(ctx, to, f.ring, '#efe9da');
  for (const f of c.rivers ?? []) for (const l of f.lines) line(ctx, to, l, '#1d5f96', 1.2);
  drawStreets(ctx, to, c);
  drawDivisionBorders(ctx, to, c);
  for (const e of epochs) line(ctx, to, e.ring, colourOf(e), 3, true);
  // The built-up city of each year, where no epoch draws it already.
  const built = (c.builtUp ?? []).filter((b) => !(c.epochs ?? []).some((e) => e.ring === b.ring || (e.areaHa === b.areaHa && e.ring.length === b.ring.length)));
  built.forEach((b, k) => line(ctx, to, b.ring, BUILT_COLOURS[k % BUILT_COLOURS.length], 2.5, true));
  // The bodies a strait parts from the city, in the colour of their year.
  (c.builtUp ?? []).forEach((b, k) => {
    const epoch = (c.epochs ?? []).find((e) => e.areaHa === b.areaHa && e.ring.length === b.ring.length);
    for (const piece of b.pieces) line(ctx, to, piece, epoch ? colourOf(epoch) : BUILT_COLOURS[k % BUILT_COLOURS.length], 2, true, [6, 4]);
  });
  for (const w of c.walls ?? []) line(ctx, to, w.ring, '#3a1d12', 2.5, true, [10, 4]);
  drawFeatures(ctx, to, c, box);
  if (!wide) for (const hill of c.relief?.hills ?? []) label(ctx, to(hill.centre), hill.name, '#5b4420', 18);
  for (const l of c.landmarks ?? []) {
    dot(ctx, to(l.at), '#1b1b2a', wide ? 4 : 7);
    if (!wide) label(ctx, to(l.at), l.name, '#1b1b2a', 20);
  }
  drawNames(ctx, to, c, box);
  (c.epochs ?? []).forEach((e, k) => {
    ctx.fillStyle = colourOf(e);
    ctx.fillRect(40, 40 + k * 34, 26, 20);
    label(ctx, [62, 50 + k * 34], `${e.year < 0 ? `${-e.year} BC` : e.year}  ${e.name}  (${e.areaHa} ha)`, '#1b1b2a', 20);
  });
  built.forEach((b, k) => {
    const y = 40 + ((c.epochs ?? []).length + k) * 34;
    ctx.fillStyle = BUILT_COLOURS[k % BUILT_COLOURS.length];
    ctx.fillRect(40, y, 26, 20);
    label(ctx, [62, y + 10], `built-up ${b.year ?? 'today'}  (${b.areaHa} ha)`, '#1b1b2a', 20);
  });
  scaleBar(ctx, to, wide ? 5000 : 1000, wide ? '5 km' : '1 km');
}

const BUILT_COLOURS = ['#8e2f6b', '#c0478f', '#5b3fa3', '#2f6f9e', '#2c8c6e', '#7a7a2a'];

const FEATURE_COLOURS = ['#0b7a75', '#a8461b', '#4b3b9a', '#8a6d00', '#9b2c5c', '#2b6cb0'];

/** The named features: an area filled light and outlined, a line solid, its stretches below the ground dashed; each named where it lies in the view. */
function drawFeatures(ctx, to, c, box) {
  (c.features ?? []).forEach((f, k) => {
    const colour = FEATURE_COLOURS[k % FEATURE_COLOURS.length];
    let at = null;
    if (f.kind === 'area') {
      for (const r of [f.ring, ...f.pieces]) {
        ctx.globalAlpha = 0.25;
        fill(ctx, to, r, colour);
        ctx.globalAlpha = 1;
        line(ctx, to, r, colour, 2, true);
      }
      at = f.ring.reduce((s, p) => [s[0] + p[0] / f.ring.length, s[1] + p[1] / f.ring.length], [0, 0]);
    } else {
      const parts = f.stretches ? f.stretches.flatMap((s) => s.lines.map((l) => ({ l, under: s.under }))) : f.lines.map((l) => ({ l, under: false }));
      for (const { l, under } of parts) line(ctx, to, l, colour, under ? 2 : 3, false, under ? [6, 5] : []);
      const first = f.lines[0];
      at = first[Math.floor(first.length / 2)];
    }
    if (at[0] >= box[0] && at[0] <= box[2] && at[1] >= box[1] && at[1] <= box[3]) label(ctx, to(at), f.name, colour, 18);
  });
}

const DIVISION_TINTS = ['#e3a01c', '#3f9e8a', '#b04f93', '#3f6fb5', '#8fae3c', '#d9622b', '#7a4fb0'];

/** Whether all these points lie in one city view other than `skip`, whose own preview shows them (none count as shown). */
function shownElsewhere(points, views, skip) {
  if (points.length === 0) return true;
  return Object.entries(views).some(([name, b]) => name !== skip && points.every(([x, y]) => x >= b[0] - 1 && x <= b[2] + 1 && y >= b[1] - 1 && y <= b[3] + 1));
}

/** The main streets: the widest class darker. */
function drawStreets(ctx, to, c) {
  for (const s of c.streets ?? []) {
    const major = s.class === 'motorway' || s.class === 'major-highway';
    for (const l of s.lines) line(ctx, to, l, major ? '#5b5b6b' : '#9a98a6', major ? 2 : 1);
  }
}

/** The divisions, each in a light tint of its own, so that two neighbours tell apart. */
function fillDivisions(ctx, to, c) {
  (c.divisions ?? []).forEach((d, k) => {
    ctx.globalAlpha = 0.2;
    for (const r of [d.ring, ...d.pieces]) fill(ctx, to, r, DIVISION_TINTS[k % DIVISION_TINTS.length]);
    ctx.globalAlpha = 1;
  });
}

/** The borders of the divisions, the lowest level the boldest, and their outline dashed. */
function drawDivisionBorders(ctx, to, c) {
  const low = Math.min(...(c.divisions ?? []).map((d) => d.level));
  for (const b of c.divisionBorders ?? []) {
    const width = b.level === low ? 2 : 1;
    for (const l of b.lines) line(ctx, to, l, b.between.length > 0 ? 'rgba(74,32,96,0.85)' : 'rgba(74,32,96,0.6)', b.between.length > 0 ? width : width + 1, false, b.between.length > 0 ? [] : [7, 4]);
  }
}

/** The names of the divisions at their label points, and the places as dots, named where there are not too many to read. */
function drawNames(ctx, to, c, box) {
  const divisions = c.divisions ?? [];
  if (divisions.length <= 90) for (const d of divisions) label(ctx, to(d.at), d.name, '#4a2060', 16);
  const places = (c.places ?? []).filter((p) => p.at[0] >= box[0] && p.at[0] <= box[2] && p.at[1] >= box[1] && p.at[1] <= box[3]);
  for (const p of places) {
    if (p.ring) line(ctx, to, p.ring, 'rgba(176,58,46,0.55)', 1, true, [3, 3]);
    dot(ctx, to(p.at), '#b03a2e', 3.5);
  }
  if (places.length <= 140) for (const p of places) label(ctx, to(p.at), p.name, '#7a2a20', 13);
}

const HILL_COLOURS = ['#c2553d', '#d08a2e', '#b9a23a', '#6f9e4d', '#3f9e8a', '#4a7fb8', '#8a62b0', '#b45c8e', '#7d7d52'];

/** The hills, each in a colour of its own, with the walls and the water round them: are they apart, and where they should be? */
function drawHills(ctx, layers) {
  const c = layers.city;
  const hills = c.relief.hills;
  const pts = hills.flatMap((h) => h.rings[0].ring);
  const pad = 500;
  const box = [Math.min(...pts.map((p) => p[0])) - pad, Math.min(...pts.map((p) => p[1])) - pad, Math.max(...pts.map((p) => p[0])) + pad, Math.max(...pts.map((p) => p[1])) + pad];
  const to = fit(box, 20);
  ctx.fillStyle = '#efe9da';
  ctx.fillRect(0, 0, W, H);
  for (const level of c.relief.contours ?? []) {
    for (const ring of level.rings) line(ctx, to, ring, '#b9ae92', 1.5, true);
    for (const l of level.lines) line(ctx, to, l, '#b9ae92', 1.5);
  }
  for (const f of c.water ?? []) fill(ctx, to, f.ring, '#6fb1dc');
  for (const f of c.islands ?? []) fill(ctx, to, f.ring, '#efe9da');
  hills.forEach((hill, k) => {
    const colour = HILL_COLOURS[k % HILL_COLOURS.length];
    hill.rings.forEach((r, level) => {
      path(ctx, to, r.ring, true);
      ctx.globalAlpha = level === 0 ? 0.38 : 0.5;
      ctx.fillStyle = colour;
      ctx.fill();
      ctx.globalAlpha = 1;
      line(ctx, to, r.ring, colour, 2, true);
    });
  });
  for (const w of c.walls ?? []) line(ctx, to, w.ring, '#3a1d12', 2, true, [10, 4]);
  for (const l of c.landmarks ?? []) {
    dot(ctx, to(l.at), '#1b1b2a', 5);
    label(ctx, to(l.at), l.name, '#44445a', 16);
  }
  hills.forEach((hill) => {
    dot(ctx, to(hill.centre), '#3a2a10', 4);
    label(ctx, to(hill.centre), `${hill.name} ${hill.height} m, ${hill.areaHa} ha`, '#3a2a10', 20);
  });
  label(ctx, [30, 40], `hills: rings at ${hills[0].rings.map((r) => `${r.height} m`).join(' and ')} (the first hill); contours ${(c.relief.contours ?? []).map((l) => `${l.height} m`).join(', ')}`, '#1b1b2a', 20);
  scaleBar(ctx, to, 500, '500 m');
}

/** The colours of the bands of a terrain, from the low land up: `count` of them, taken evenly from a ramp of greens, ochres and browns. */
function bandColours(count) {
  const ramp = [[168, 201, 143], [196, 215, 153], [224, 222, 160], [232, 205, 143], [219, 178, 120], [197, 148, 100], [170, 121, 86], [140, 99, 78], [112, 84, 76]];
  return Array.from({ length: count }, (_, k) => {
    const at = count > 1 ? (k / (count - 1)) * (ramp.length - 1) : 0;
    const i = Math.min(ramp.length - 2, Math.floor(at));
    return `rgb(${ramp[i].map((v, c) => Math.round(v + (ramp[i + 1][c] - v) * (at - i))).join(',')})`;
  });
}

/** The terrain of the wide view: the land, its bands of height each over the one below with a thin shadow, the lakes, the rivers, and the boxes of the closer views. */
function drawTerrain(ctx, layers) {
  const t = layers.city.terrain;
  const to = fit(t.box, 0);
  const colours = bandColours(t.levels.length + 1);
  ctx.fillStyle = '#8fbfe0';
  ctx.fillRect(0, 0, W, H);
  for (const f of t.land) fill(ctx, to, f.ring, colours[0]);
  for (const b of t.bands) {
    if (!b.pit) {
      // The shadow a step of the ground casts to the south-east: what gives the map its depth.
      ctx.save();
      ctx.translate(1.5, 2);
      fill(ctx, to, b.ring, 'rgba(60,40,20,0.22)');
      ctx.restore();
    }
    fill(ctx, to, b.ring, colours[b.band]);
  }
  for (const f of t.lakes) fill(ctx, to, f.ring, '#5fa5d6');
  for (const f of t.rivers) for (const l of f.lines) line(ctx, to, l, '#2b78bd', 3);
  for (const f of t.land) line(ctx, to, f.ring, 'rgba(40,70,100,0.55)', 1, true);
  // The streets, divisions and places that no preview of a city view shows (those built for the terrain's own view).
  const c = layers.city;
  const views = layers.frames.city.views;
  const streets = shownElsewhere((c.streets ?? []).flatMap((s) => s.lines.flat()), views, t.view) ? [] : c.streets;
  const divided = !shownElsewhere((c.divisions ?? []).flatMap((d) => d.ring), views, t.view);
  const places = shownElsewhere((c.places ?? []).map((p) => p.at), views, t.view) ? [] : c.places;
  const over = { streets, divisions: divided ? c.divisions : [], divisionBorders: divided ? c.divisionBorders : [], places };
  drawStreets(ctx, to, over);
  drawDivisionBorders(ctx, to, over);
  drawNames(ctx, to, over, t.box);
  for (const [name, box] of Object.entries(layers.frames.city.views)) {
    if (name === t.view) continue;
    line(ctx, to, [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]], 'rgba(27,27,42,0.7)', 1.5, true, [8, 5]);
    label(ctx, to([box[0], box[3]]), name, '#1b1b2a', 16);
  }
  dot(ctx, to([0, 0]), '#b3261e', 6);
  label(ctx, to([0, 0]), layers.name, '#1b1b2a', 24);
  for (const f of t.rivers) if (f.lines[0]) label(ctx, to(f.lines[0][Math.floor(f.lines[0].length / 3)]), f.name, '#1d5f96', 18);
  colours.forEach((colour, k) => {
    const y = H - 110 - k * 30;
    ctx.fillStyle = colour;
    ctx.fillRect(W - 250, y, 30, 22);
    ctx.strokeStyle = 'rgba(27,27,42,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(W - 250, y, 30, 22);
    label(ctx, [W - 224, y + 10], k === 0 ? `below ${t.levels[0] ?? 0} m` : `from ${t.levels[k - 1]} m`, '#1b1b2a', 18);
  });
  const width = t.box[2] - t.box[0];
  const bar = width > 100000 ? 20000 : width > 40000 ? 10000 : 2000;
  label(ctx, [30, 40], `terrain: cell ${t.cell} m; ${t.bands.length} rings of ${t.levels.length} levels, ${t.lakes.length} lake(s), ${[...t.land, ...t.bands, ...t.lakes].reduce((n, f) => n + f.ring.length, 0)} points`, '#1b1b2a', 20);
  scaleBar(ctx, to, bar, `${bar / 1000} km`);
}

function drawMorph(ctx, layers, whole = false) {
  const epochs = layers.city.epochs ?? [];
  const pts = epochs.flatMap((e) => e.morph);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  // Framed on the epochs but the last, which is far larger: the early steps are the ones to look at.
  const early = whole ? [] : epochs.slice(0, -1).flatMap((e) => e.morph);
  const box = early.length > 0 ? [Math.min(...early.map((p) => p[0])) - 600, Math.min(...early.map((p) => p[1])) - 600, Math.max(...early.map((p) => p[0])) + 600, Math.max(...early.map((p) => p[1])) + 600] : [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const to = fit(box, 40);
  ctx.fillStyle = '#f4f1e8';
  ctx.fillRect(0, 0, W, H);
  epochs.forEach((e, k) => {
    const colour = EPOCH_COLOURS[k % EPOCH_COLOURS.length];
    line(ctx, to, e.morph, colour, 2.5, true);
    if (k > 0) for (let i = 0; i < e.morph.length; i += 4) line(ctx, to, [epochs[k - 1].morph[i], e.morph[i]], 'rgba(40,40,60,0.28)', 1);
    dot(ctx, to(e.morph[0]), colour, 7);
    for (let i = 0; i < e.morph.length; i += 1) dot(ctx, to(e.morph[i]), colour, 1.6);
  });
  label(ctx, [30, 40], `morph rings: ${epochs.map((e) => e.morph.length).join(', ')} points; the large dot is point 0, the grey lines join points of the same index`, '#1b1b2a', 20);
}

/** Draws the previews of a city's layers into `dir`, and returns the files written. */
export async function drawPreviews(layers, dir) {
  const { Canvas } = await canvasKit();
  mkdirSync(dir, { recursive: true });
  const out = [];
  const draw = async (name, fn) => {
    const canvas = new Canvas(W, H);
    fn(canvas.getContext('2d'));
    const file = join(dir, `${name}.png`);
    await canvas.toFile(file);
    out.push(file);
  };
  if (layers.region) await draw('region', (ctx) => drawRegion(ctx, layers));
  // The view a terrain covers is shown by the terrain's own picture: the layers of the city are too small in it to check.
  for (const view of Object.keys(layers.frames.city.views)) if (view !== layers.city.terrain?.view) await draw(`city-${view}`, (ctx) => drawCity(ctx, layers, view));
  if (layers.city.terrain) await draw('terrain', (ctx) => drawTerrain(ctx, layers));
  if ((layers.city.relief?.hills ?? []).length > 0) await draw('hills', (ctx) => drawHills(ctx, layers));
  if ((layers.city.epochs ?? []).length > 1) await draw('epochs-morph', (ctx) => drawMorph(ctx, layers));
  // With the last epoch far larger than the rest, a second picture shows the whole of it.
  if ((layers.city.epochs ?? []).length > 2) await draw('epochs-morph-whole', (ctx) => drawMorph(ctx, layers, true));
  return out;
}

/**
 * A ring of degrees as a line on a map of longitude and latitude: its longitudes unwrapped from one point to
 * the next, so that it never jumps across the map at the 180th meridian; a ring round a pole is closed along
 * the edge of the map at that pole.
 */
function mapRing(ring) {
  const out = [];
  for (const [lon, lat] of ring) {
    if (out.length === 0) out.push([lon, lat]);
    else {
      const prev = out[out.length - 1][0];
      out.push([prev + ((((lon - prev) % 360) + 540) % 360) - 180, lat]);
    }
  }
  const back = out[out.length - 1][0] + ((((ring[0][0] - out[out.length - 1][0]) % 360) + 540) % 360) - 180;
  if (Math.abs(back - out[0][0]) > 180) {
    // Round a pole: on to the first point a turn of the map away, down to the edge at the pole, and back.
    const pole = out.reduce((s, p) => s + p[1], 0) < 0 ? -90 : 90;
    out.push([back, ring[0][1]], [back, pole], [out[0][0], pole]);
  }
  return out;
}

/** The layers of a globe build on a map of longitude and latitude, 1920 × 960: each layer in its own colour, the towns as dots. */
export async function previewGlobe(globe, dir) {
  const { Canvas } = await canvasKit();
  mkdirSync(dir, { recursive: true });
  const canvas = new Canvas(W, W / 2);
  const ctx = canvas.getContext('2d');
  const k = W / 360;
  const moon = globe.body === 'moon';
  ctx.fillStyle = moon ? '#c9c6bf' : '#9ec9e8';
  ctx.fillRect(0, 0, W, W / 2);
  const layer = (list, colour) => {
    ctx.beginPath();
    for (const p of list ?? []) {
      for (const ring of p.rings) {
        const line = mapRing(ring);
        for (const shift of [-360, 0, 360]) {
          line.forEach(([lon, lat], i) => (i === 0 ? ctx.moveTo((lon + shift + 180) * k, (90 - lat) * k) : ctx.lineTo((lon + shift + 180) * k, (90 - lat) * k)));
          ctx.closePath();
        }
      }
    }
    ctx.fillStyle = colour;
    ctx.fill('evenodd');
  };
  const colours = { land: '#d8d3c4', ice: '#f4f7fa', lakes: '#6fb1dc', maria: '#55545a' };
  for (const [name, list] of Object.entries(globe.layers)) layer(list, colours[name] ?? '#7a6f9b');
  for (const p of globe.places ?? []) dot(ctx, [(p.at[0] + 180) * k, (90 - p.at[1]) * k], '#b3261e', Math.max(1, Math.sqrt(p.pop / 1e6) * 1.6));
  const file = join(dir, 'globe.png');
  await canvas.toFile(file);
  return file;
}

/** A world map, 1920 × 1080: the sea inside the edge of the world, the countries in four colours by turns, their borders, the lakes. */
export async function previewWorld(world, dir) {
  const { Canvas } = await canvasKit();
  mkdirSync(dir, { recursive: true });
  const canvas = new Canvas(W, H);
  const ctx = canvas.getContext('2d');
  const to = fit(world.frame.box, 20);
  ctx.fillStyle = world.frame.outline ? '#f4f1ea' : '#9ec9e8';
  ctx.fillRect(0, 0, W, H);
  if (world.frame.outline) fill(ctx, to, world.frame.outline, '#9ec9e8');
  for (const l of world.land) fill(ctx, to, l.ring, '#d8d3c4');
  const colours = ['#e3c9a1', '#c9d9a6', '#e8b8a8', '#c3c0de'];
  world.countries.forEach((c, k) => {
    for (const ring of c.rings) fill(ctx, to, ring, colours[k % colours.length]);
  });
  for (const g of world.gaps) fill(ctx, to, g.ring, '#9ec9e8');
  for (const l of world.lakes) fill(ctx, to, l.ring, '#6fb1dc');
  for (const b of world.boundaries) for (const points of b.lines) line(ctx, to, points, '#5b4b6b', 0.8);
  const file = join(dir, 'world.png');
  await canvas.toFile(file);
  return file;
}
