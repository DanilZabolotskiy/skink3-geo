// What a scene takes from a layer besides its outlines: the shores of water cut by the view, and a grid of heights
// for relief shading, fitted to a stage. Nothing is downloaded and no cache is read.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { faultsOf, fitView, gridOnStage, loadLayers, ringsOnStage, shoresOnStage, type HeightGrid, type Layers, type Point } from '../map.ts';

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
