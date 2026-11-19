// Plain previews of a city's layers, to check that everything is in its place: the region, each view
// of the city, and the morph rings of the epochs. They are not a design: the look of a frame is the
// work of whoever draws it. Drawn with skia-canvas, 1920 × 1080, into out/<city>/ (not committed).

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
  for (const f of c.water ?? []) fill(ctx, to, f.ring, '#6fb1dc');
  for (const f of c.islands ?? []) fill(ctx, to, f.ring, '#efe9da');
  for (const f of c.rivers ?? []) for (const l of f.lines) line(ctx, to, l, '#1d5f96', 1.2);
  for (const s of c.streets ?? []) for (const l of s.lines) line(ctx, to, l, s.class === 'motorway' ? '#5b5b6b' : '#9a98a6', s.class === 'motorway' ? 2 : 1);
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
  if (!wide) for (const hill of c.relief?.hills ?? []) label(ctx, to(hill.centre), hill.name, '#5b4420', 18);
  for (const l of c.landmarks ?? []) {
    dot(ctx, to(l.at), '#1b1b2a', wide ? 4 : 7);
    if (!wide) label(ctx, to(l.at), l.name, '#1b1b2a', 20);
  }
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
  for (const view of Object.keys(layers.frames.city.views)) await draw(`city-${view}`, (ctx) => drawCity(ctx, layers, view));
  if ((layers.city.relief?.hills ?? []).length > 0) await draw('hills', (ctx) => drawHills(ctx, layers));
  if ((layers.city.epochs ?? []).length > 1) await draw('epochs-morph', (ctx) => drawMorph(ctx, layers));
  // With the last epoch far larger than the rest, a second picture shows the whole of it.
  if ((layers.city.epochs ?? []).length > 2) await draw('epochs-morph-whole', (ctx) => drawMorph(ctx, layers, true));
  return out;
}
