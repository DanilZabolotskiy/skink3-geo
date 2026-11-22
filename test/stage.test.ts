// What a scene takes from a layer besides its outlines: the shores of water cut by the view, and a grid of heights
// for relief shading, fitted to a stage. Nothing is downloaded and no cache is read.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blendGrid, divisionsOnStage, faultsOf, fitView, gridOnStage, heightAt, loadLayers, ringsOnStage, shoresOnStage, type Division, type HeightGrid, type Layers, type Point } from '../map.ts';
import { signedArea } from '../lib/geom.mjs';

/** 41 by 31 points 100 m apart over [-2000, -1500, 2000, 1500]: the ground rises 1 m a metre to the north, 0.01 m a metre to the east. */
function slope(): HeightGrid {
  const [cols, rows, cell] = [41, 31, 100];
  const values: number[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) values.push(Math.round((3000 - r * cell + c) * 10) / 10);
  return { box: [-2000, -1500, 2000, 1500], cell, cols, rows, values };
}

/** A view 2000 m by 1000 m round the centre, on a stage of 1920 by 1080: 1.08 units a metre. */
const view = fitView([-1000, -500, 1000, 500], { w: 1920, h: 1080 });

test('gridOnStage: the part of the grid the view holds, its north at the top, as the rect a relief node covers', () => {
  const g = gridOnStage(view, slope());
  // The view with its margin of 120 units reaches 1000 m east and west and 611 m north and south: the points from
  // 1000 m west to 1000 m east, and from 700 m north to 700 m south, the first ones past the margin included.
  assert.deepEqual([g.heights.cols, g.heights.rows], [21, 15]);
  assert.deepEqual(g.at, [0, 0]);
  assert.deepEqual([g.w, g.h], [2160, 1512]);
  assert.equal(g.vertical, view.scale);
  assert.equal(g.heights.values.length, 21 * 15);
  // Its first row is the north, 700 m north of the centre; along a row the ground rises to the east.
  assert.equal(g.heights.values[0], 3000 - 800 + 10);
  assert.ok(g.heights.values[0]! > g.heights.values[14 * 21]!);
  assert.ok(g.heights.values[20]! > g.heights.values[0]!);
  // It covers the stage and its margin.
  assert.ok(g.w / 2 >= 960 + 120 && g.h / 2 >= 540 + 120);
  // A grid the view does not reach is refused.
  assert.throws(() => gridOnStage(fitView([20000, 20000, 22000, 21000], { w: 1920, h: 1080 }), slope()), /outside the view/);
});

test('shoresOnStage: a river cut by the view keeps its two banks and drops the runs along the cut; a lake comes whole', () => {
  const river: Point[] = [[-5000, -200], [5000, -200], [5000, 200], [-5000, 200]];
  const lake: Point[] = [[-100, -100], [100, -100], [100, 100], [-100, 100]];
  const [cut] = ringsOnStage(view, [river]);
  assert.ok(cut!.some((p) => Math.abs(p[0]) > 1000), 'the river is cut past the stage, in the margin');
  const banks = shoresOnStage(view, [river]);
  assert.equal(banks.length, 2);
  for (const bank of banks) {
    // Each bank runs from the cut on one side to the cut on the other, at one height, and never along the cut.
    assert.ok(bank.every((p) => p[1] === bank[0]![1]), JSON.stringify(bank));
    assert.ok(Math.abs(bank[0]![0]) > 1000 && Math.abs(bank[bank.length - 1]![0]) > 1000);
  }
  assert.deepEqual(banks.map((b) => Math.abs(b[0]![1])), [216, 216]);
  const [shore] = shoresOnStage(view, [lake]);
  assert.deepEqual(shore![0], shore![shore!.length - 1]);
  assert.equal(shore!.length, 5);
});

test('faultsOf: a grid of heights with too few heights, one that is not a number, or points off its box is named', () => {
  const town = loadLayers(new URL('../examples/valletta/layers.json', import.meta.url));
  const withGrid = (grid: HeightGrid): Layers => ({ ...town, city: { ...town.city, relief: { contours: [], hills: [], ...town.city.relief, grid } } });
  const good = slope();
  assert.deepEqual(faultsOf(withGrid(good)).filter((f) => f.startsWith('city.relief.grid')), []);
  assert.match(faultsOf(withGrid({ ...good, values: good.values.slice(1) })).join('\n'), /city\.relief\.grid: 1270 heights for 41 by 31 points/);
  assert.match(faultsOf(withGrid({ ...good, values: [Number.NaN, ...good.values.slice(1)] })).join('\n'), /city\.relief\.grid: a height that is not a number/);
  assert.match(faultsOf(withGrid({ ...good, box: [-2000, -1500, 2100, 1500] })).join('\n'), /city\.relief\.grid: its points do not lie on the edges of its box/);
});

test('heightAt: the height between the four nearest points of a grid, null outside it', () => {
  const g = slope();
  assert.equal(heightAt(g, [0, 0]), 3000 - 1500 + 20);
  assert.equal(heightAt(g, [-2000, 1500]), 3000);
  assert.equal(heightAt(g, [-1950, 1500]), 3000.5);
  assert.equal(heightAt(g, [-1950, 1450]), 2950.5);
  assert.equal(heightAt(g, [2001, 0]), null);
  assert.equal(heightAt(g, [0, -1501]), null);
});

test('blendGrid: a fine grid takes the heights of a coarse one on its edges and keeps its own inside the margin', () => {
  // A fine grid of 21 by 21 points 10 m apart over [-100, -100, 100, 100] with bumps, in a coarse ground of 500 m.
  const fine: HeightGrid = { box: [-100, -100, 100, 100], cell: 10, cols: 21, rows: 21, values: Array.from({ length: 441 }, (_, k) => 500 + ((k * 7) % 13)) };
  const coarse: HeightGrid = { box: [-1000, -1000, 1000, 1000], cell: 500, cols: 5, rows: 5, values: Array.from({ length: 25 }, () => 500) };
  const b = blendGrid(fine, coarse, { margin: 50 });
  assert.deepEqual([b.box, b.cell, b.cols, b.rows], [fine.box, 10, 21, 21]);
  for (let i = 0; i < 21; i++) {
    for (const k of [i, 20 * 21 + i, i * 21, i * 21 + 20]) assert.equal(b.values[k], 500);
  }
  // Five cells in, at the margin and past it, the fine grid is its own.
  for (let r = 5; r <= 15; r++) for (let c = 5; c <= 15; c++) assert.equal(b.values[r * 21 + c], fine.values[r * 21 + c]);
  // Between, its bumps grow from nothing at the edge to the whole of them at the margin.
  const bump = (g: HeightGrid, c: number): number => Math.abs(g.values[10 * 21 + c]! - 500);
  assert.ok(bump(b, 1) <= bump(fine, 1) && bump(b, 4) <= bump(fine, 4));
  // Where the coarse grid has no height the fine one keeps its own; a margin of 0 is refused.
  const far: HeightGrid = { ...coarse, box: [5000, 5000, 7000, 7000] };
  assert.deepEqual(blendGrid(fine, far, { margin: 50 }).values, fine.values);
  assert.throws(() => blendGrid(fine, coarse, { margin: 0 }), /margin/);
});

/** Two divisions of a level side by side, their border a fine wiggle, and a finer one inside the west one. */
function divisions(): Division[] {
  const border: Point[] = Array.from({ length: 41 }, (_, k) => [Math.round(Math.sin(k) * 30 * 10) / 10, -2000 + k * 100]);
  const west: Point[] = [[-3000, -2000], ...border, [-3000, 2000]].reverse() as Point[];
  const east: Point[] = [[3000, -2000], [3000, 2000], ...[...border].reverse()];
  return [
    { id: 'west', name: 'West', level: 8, osm: 'relation/1', areaKm2: 12, at: [-1500, 0], ring: west.reverse(), pieces: [] },
    { id: 'east', name: 'East', level: 8, osm: 'relation/2', areaKm2: 12, at: [1500, 0], ring: east, pieces: [] },
    { id: 'quarter', name: 'Quarter', level: 9, osm: 'relation/3', areaKm2: 0.25, at: [-1000, 0], ring: [[-1250, -250], [-750, -250], [-750, 250], [-1250, 250]], pieces: [] },
  ];
}

test('divisionsOnStage: neighbours thinned together on the stage keep one border, level by level, each with its label', () => {
  const d = divisions();
  for (const x of d) assert.ok(signedArea(x.ring) > 0, x.id);
  const map = divisionsOnStage(view, d, { detail: 3 });
  assert.deepEqual(map.divisions.map((x) => [x.id, x.level]), [['west', 8], ['east', 8], ['quarter', 9]]);
  assert.deepEqual(map.borders.map((b) => [b.id, b.level, b.between]), [['east-west', 8, ['east', 'west']]]);
  // The thinned border is the same points in both divisions and in its line.
  const near = (rings: Point[][]): string[] => rings.flat().filter((p) => Math.abs(p[0]) < 40 && Math.abs(p[1]) < 600).map((p) => p.join(',')).sort();
  const line = map.borders[0]!.lines.flat().filter((p) => Math.abs(p[1]) < 600).map((p) => p.join(',')).sort();
  assert.deepEqual(near(map.divisions[0]!.rings), near(map.divisions[1]!.rings));
  assert.deepEqual(near(map.divisions[0]!.rings), [...new Set(line)].sort());
  assert.deepEqual(map.divisions[2]!.label, view.project([-1000, 0]));
});

test('faultsOf: divisions out of order, a label outside, an id twice, a border of a division not there, and a place off its frame are named', () => {
  const town = loadLayers(new URL('../examples/valletta/layers.json', import.meta.url));
  const d = divisions();
  const ok: Layers = { ...town, city: { ...town.city, divisions: d, divisionBorders: [{ id: 'east-west', level: 8, between: ['east', 'west'], lines: [[[0, -2000], [0, 2000]]] }], places: [{ id: 'docks', name: 'Docks', kind: 'quarter', osm: 'node/1', at: [100, 100], lonlat: [14.5, 35.9] }] } };
  const mine = (l: Layers): string[] => faultsOf(l).filter((f) => /division|places/.test(f));
  assert.deepEqual(mine(ok), []);
  const bad: Layers = {
    ...ok,
    city: {
      ...ok.city,
      divisions: [d[2]!, { ...d[0]!, at: [5000, 0] }, { ...d[1]!, id: 'quarter', ring: [...d[1]!.ring].reverse() }],
      divisionBorders: [{ id: 'east-west', level: 8, between: ['east', 'west'], lines: [] }],
      places: [{ ...ok.city.places![0]!, at: [1e9, 0] }],
    },
  };
  const said = mine(bad).join('\n');
  for (const fault of ['city.divisions: not in the order of their levels', 'city.divisions.west: its label point lies outside it', 'city.divisions.quarter: clockwise', 'city.divisions: an id given twice', 'city.divisionBorders.east-west: between a division that is not there', 'city.places.docks: outside its frame']) assert.ok(said.includes(fault), fault);
});
