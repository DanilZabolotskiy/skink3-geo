# skink3-geo

Real geographic data turned into the simplified vector layers a city's map is drawn from: the country round it, the terrain of its surroundings in bands of height, the sea and the rivers in their true width, the relief, walls, main streets or a country's main roads, the administrative divisions and the named quarters of a city, named features no other layer has a kind for (a channel, a railway, a basin long filled, the footprint of a building, an old district: open lines and areas from mapped elements or drawn after a written source, with their years and their stretches below the ground), the built-up land, and the city's outline through time, ready to grow from one epoch into the next; a round body for a globe, the Earth or the Moon, in degrees; and a flat map of the whole world, or of the countries round a place, with the outline of every country. One spec a city, one command, and the same bytes every time, with the credit of every source written out.

It is made for animated maps (the scenes of [skink3-engine](https://github.com/DanilZabolotskiy/skink3-engine) among them), but it draws nothing and depends on no renderer: its output is one JSON file of points in metres (in degrees, for a globe).

```
build.mjs, lib/             the pipeline: plain Node, no package needed to build
globe.mjs                   a round body for a globe, the Earth or the Moon, in degrees ("A globe")
world.mjs                   a flat map of the world or of a box, every country with its borders ("A world map")
map.ts                      for a scene: the types of the layers, loading, the fit into a stage
test/                       the tests
examples/                   a root of cities, with one small city built: Valletta
  cities/<city>.json        the spec: the frames, the layers wanted, the epochs and their sources
  <city>/layers.json        the layers: the only file a scene reads
  <city>/SOURCES.md         where each layer comes from, what was drawn by hand, the credit lines
  <city>/sources.lock.json  every download: its request, its SHA-256, its size, its date
  earth/, moon/             the Earth at 1:110m and the Moon, for a globe, each with its SOURCES.md and its lock
  world/, slovenia/         the whole world at 1:50m, and the countries round Slovenia at 1:10m, for flat maps
  cache/, out/              not in git: the raw downloads, and the previews
```

```
npm ci                                                  # the pinned packages (the canvas of the previews, the type checker)
node build.mjs valletta --root examples --preview       # build; download what the cache lacks; draw the previews
node build.mjs valletta --root examples --offline       # build from the cache alone
node build.mjs valletta --root examples --update        # take a source that has changed since the lock
npm run check                                           # the type check and the tests
```

`--root` is the directory that holds `cities/` (the working directory when it is not given). The previews, 1920 x 1080, go to `out/<city>/`: `region.png`, `city-<view>.png`, `terrain.png`, `hills.png`, `epochs-morph.png`, `epochs-morph-whole.png` (the view a terrain covers is shown by `terrain.png` alone, with the streets, divisions and places built for that view). They check that every layer is in its place. They are not a design.

## A new city

One command takes a city, its box and the years wanted, and gives its layers:

```
node build.mjs valletta --root examples --new --name Valletta --country MLT \
  --bbox 14.31,35.79,14.59,35.99 --centre 14.5146,35.8989 --years 1975,2020 \
  --wide 14.01,35.77,14.76,36.11 --preview
```

`--new` writes `cities/<city>.json` once (it never overwrites a spec) and builds it. `--bbox` is west,south,east,north in degrees; `--centre` (the middle of the box by default) is the `[0, 0]` of the city's plane; `--country` is the ISO A3 code of the country to mark in the region; `--years` are years of the built-up layer (every fifth from 1975 to 2030; after 2020 a projection). `--wide`, which may be left out, is a second box that holds the first: the country the city stands in, as a view of its own with its terrain. What the command gives rests on sources that cover the whole world, so it builds for any city: the region, the sea, lakes and wide rivers, contour lines every 50 m, the terrain of the wide box, and the built-up city of each year as an epoch. The example is exactly that, untouched.

What a history needs beyond that is added to the spec by hand ("The spec" below): a closer view, the rivers by name, the hills, the walls, the main streets, the epochs before 1975 with a source for each, the landmarks, the coast of another age. Then the same command without `--new` builds it again.

## In a project of its own

A project keeps its cities with itself (its specs, its layers, its cache) and calls the pipeline from a script of a few lines:

```js
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'skink3-geo/build.mjs';

process.exitCode = await run(process.argv.slice(2), {
  root: dirname(fileURLToPath(import.meta.url)),   // holds cities/, receives <city>/, cache/ and out/
  command: 'maps/build.mjs',                       // how the build is called there: the usage line, the head of SOURCES.md
  sources: { own: { name: 'Drawn for this project' } },   // changes to the table of sources, by key and field
  notes: ['A paragraph of the project\'s own terms, set after the credits in SOURCES.md.'],
});
```

The layers are a function of the spec, the downloads and this code, so a project pins the commit of this repository it builds with.

## The layers: format `cities-geo/1`

Every coordinate is **metres on a plane**, x east and y north of the centre of its frame (a Lambert azimuthal equal-area projection on the sphere, centred on the frame: true to scale at a city, within a few parts in a thousand over a country). A ring is a closed outline, a list of `[x, y]` without the first point repeated, counter-clockwise, which never crosses itself. A line is an open list of points.

There are two frames, each with its own centre, so the points of one are not those of the other:

| Frame | Holds | Detail |
|---|---|---|
| `frames.region` | `region.*`: the country and the land and sea round it | points to 1 m; bends smaller than 1/2200 of the box's height are smoothed away (about 550 m in a box of 1200 km) |
| `frames.city` | `city.*`: the city | points to 0.1 m, bends under a few metres smoothed away |

A frame gives its `centre` (`[lon, lat]`), its `box` in metres (`[x0, y0, x1, y1]`) and the same in degrees (`lonlat`). The city frame also gives `views`, the named boxes of the spec in metres: the whole of the city, and, where a spec adds them, a closer view of its middle and a wide view of the country round it. The frame's own box holds them all.

| Layer | What it is |
|---|---|
| `region.land[]` | `{ id, ring }`: all the land in the box, cut to the box. The sea is what the land leaves |
| `region.country` | `{ id, name, rings[] }`: the country, its islands too |
| `region.borders[]` | `{ id, with, lines[] }`: its land borders, one entry a neighbour |
| `region.rivers[]`, `region.lakes[]` | `{ id, name, lines[] }` and `{ id, name, ring }` |
| `region.city` | `{ id, name, at }`: the city in the region's frame |
| `city.water[]` | `{ id, areaHa, ring }`: water as whole forms, the largest first: a river with its two banks, a lake, the sea |
| `city.islands[]` | `{ id, areaHa, ring }`: islands, drawn over the water |
| `city.rivers[]` | `{ id, name, lengthKm, lines[] }`: a river as a line down its middle, for a far view or a flow |
| `city.relief.contours[]` | `{ id, height, rings[], lines[] }`: contour lines at the heights the spec chose. A line is a contour the box cuts |
| `city.relief.grid` | `{ box, cell, cols, rows, values }`, where the spec asks for it: the ground the contours are traced on, as a grid of heights for relief shading. See "The grid of heights" |
| `city.relief.hills[]` | `{ id, name, summit, centre, height, areaHa, rings[] }`: each hill a soft form of its own. `rings` go from its foot up, `{ height, ring }`, each inside the one before. `centre` is where its mark or label belongs |
| `city.walls[]` | `{ id, name, built, lengthKm, areaHa, ring }`: a wall as its whole closed circuit |
| `city.streets[]` | `{ id, class, name?, ref?, from?, to?, lengthKm, lines[] }`: main streets, the widest class first; `from` and `to` are the years a street stood, where the source dates it. From Natural Earth, a country's main roads, `class` its road type (`major-highway`, `secondary-highway`...) and `ref` its road number where it has one |
| `city.divisions[]` | `{ id, name, level, osm, areaKm2, at, ring, pieces[] }`: administrative divisions below the country, OpenStreetMap's boundaries of the `admin_level`s asked for, cut to their view, in the order to paint them: the lowest level first, in a level the largest first. The divisions of a level are thinned together, so two neighbours share their border point for point. `ring` is its largest part in the view, `pieces` the others; `at` is where its name may stand (the label point the source maps for it, else a point inside `ring`); `areaKm2` is what lies in the view. Holes are not kept: an enclave of the same level is a division of its own, painted after the one round it |
| `city.divisionBorders[]` | `{ id, level, between, lines[] }`: the lines to stroke the divisions with, each once and never along the edge of the view: the border of two divisions of a level (`between` their ids in order, `id` `a-b`), or `outline-<level>` (`between` empty), where no division of that level lies beyond (the edge of the country, or of the names asked for) |
| `city.places[]` | `{ id, name, kind, osm, at, lonlat, ring? }`: named places, OpenStreetMap's `place` of the kinds asked for (suburbs, quarters, neighbourhoods by default) whose point lies in the view, in the order of the kinds, then by name. `at` is the place's own point, or the label point or a point inside the area where it is mapped as one; such a place also brings `ring`, the largest part of that area in the view. A place mapped both as a point and as an area round it comes once |
| `city.builtUp[]` | `{ id, year?, areaHa, ring, pieces[] }`: the built-up city of a year, the earliest first. `ring` is the body that holds the centre; `pieces` are the other large bodies, which a strait or a valley parts from it |
| `city.epochs[]` | `{ id, year, name, areaHa, ring, morph }`: the city's outline through time, the earliest first; a year BC is negative |
| `city.landmarks[]` | `{ id, name, built?, at, lonlat }` |
| `city.terrain` | `{ view?, box, cell, levels[], land[], bands[], lakes[], rivers[], grid? }`: the country round the city, for a map with depth, in the city's own plane with points to 1 m. See "The terrain" |
| `city.features[]` | a line `{ id, name, kind: 'line', built?, until?, lengthKm, lines[], stretches? }` or an area `{ id, name, kind: 'area', built?, until?, areaHa, ring, pieces[] }`, in the order of the spec, each cut to its view. See "The features" |

**The terrain.** A wide view (a coast, a plain, the hills round it) is too large for the city's fine layers and too close for the region's, so it has a layer of its own, made from the elevation model at the scale of the view: the tiles are read in blocks, each cell of the grid is the mean height of the ground it covers, and the grid is smoothed, so that a form is soft and nothing is a speck.

- `land[]`, `{ id, areaHa, ring }`: the land that stands out of the sea, the largest first, an island a ring of its own. The sea is what the land leaves.
- `bands[]`, `{ id, band, height, pit?, areaHa, ring }`: the ground by height, **in the order to paint it** over the land, a ring before those inside it. A ring at `height` holds the ground at least that high, and `band` is its place among the `levels`: band 0 is the land below `levels[0]`, band *k* the ground from `levels[k - 1]` up. A ring with `pit` holds a hollow below `height` within higher ground (a crater, a closed valley) and is painted as the band it goes down into. One colour a band, painted in the order given, makes the map; a small shift of each band, or a shadow under it, makes it a relief.
- `lakes[]`, `{ id, areaHa, ring }`: standing water apart from the sea, painted over the bands.
- `rivers[]`, `{ id, name, lengthKm, lines[] }`: the rivers the spec names, each cut where it meets the sea. A river lies in its valley, because the bands round it are the same ground.
- `cell` is the size of the grid in metres: a form smaller than a few cells is not in the layer. No band comes nearer the sea than about a cell, so a cliff keeps a rim of the land below it and the bands always lie on the land.

The heights are those of today. The coast is today's too, unless the spec takes it from a map of another age; then the land and the heights are of two dates, and the city's `SOURCES.md` says so.

**The grid of heights.** A relief or a terrain whose spec asks for it (`grid`) also holds the ground it was traced from, smoothed as its lines are or as the spec says (`grid: { smooth }`), as a grid of heights for a renderer that lights the ground itself (relief shading), which reads as one rolling surface where bands read as steps. `cols` by `rows` points lie `cell` metres apart, from the north-west corner of `box` to its south-east corner, so the points lie on its edges; `values` holds their heights in metres, to a tenth, row by row from the north, each row from the west, as an image holds its pixels. A terrain's grid is held to the first of its `levels` along the sea, as its bands are. It is large (a value a point): a scene takes the part its view shows with `gridOnStage`, and a spec that covers a wide box asks for a coarser `cell`.

**The morph.** Every epoch of a city has a second outline, `morph`, of the same number of points (160) set at equal steps along it, counter-clockwise and turned so that point *k* of one epoch lies nearest to point *k* of the next. A scene that draws the two as one region with the same point count grows the city from one epoch into the next with no further work. An outline with far more detail than 160 points can hold (a city of today, with its inlets and arms) is calmed first, so its `morph` follows its body and its `ring` keeps the detail.

**The features.** A thing of the map that no other layer has a kind for comes as a feature: an open line (a water channel, a railway, a runway, an open wall, a street picked by name) or an area (a harbour basin, a lake long filled, the footprint of a building, an old district).

- A line's ways are joined end to end where their ends meet; the points drawn by hand are one more way. Each line begins at its end nearer the spec's `start` (the first point given, by default), and the longest comes first. `lines` are cut to the view; `lengthKm` is the whole of it, also where the view cuts it.
- `stretches`, where the spec marks stretches below the ground (`under`, in kilometres from the start): the line in order from its start, each `{ under, fromKm, toKm, lines }` cut to the view, one running into the next. A scene draws a stretch below the ground dashed or faint, and the line whole for a light that runs along it.
- An area's ways close into rings (a relation's inner ways are left out: an area keeps no holes); the points drawn by hand are a ring more. `ring` is its largest part in the view, `pieces` the others, the largest first; `areaHa` is all of it in the view.
- `built` and `until` are the years the spec gives (a year BC is negative). The dates of the elements in OpenHistoricalMap are not read, nor are their tunnel tags: the spec says what it means.

Heights come from a surface model, so they include buildings and trees, and are smoothed: a hill's `height` is good to a few metres and is not a figure to put on screen.

## In a scene

`map.ts` reads the layers and fits them into a stage. It draws nothing and names no colour.

```ts
import { blendGrid, divisionsOnStage, fitView, gridOnStage, heightAt, linesOnStage, loadLayers, morphOnStage, ringsInTiles, ringsOnStage, shoresOnStage } from 'skink3-geo';

const town = loadLayers(new URL('./valletta/layers.json', import.meta.url));
const view = fitView(town.frames.city.views.metro!, { w: 1920, h: 1080 });       // the stage's [0, 0] is its middle
const water = ringsOnStage(view, town.city.water!.map((f) => f.ring));           // the points of closed regions
const heights = linesOnStage(view, town.city.relief!.contours[0]!.lines);        // the points of open strokes
const grow = morphOnStage(view, town.city.epochs![0]!, town.city.epochs![1]!);   // grow.at(t), t from 0 to 1

const far = fitView(town.frames.city.views.wide!, { w: 1920, h: 1080 });
const ground = town.city.terrain!.bands.map((b) => ({ band: b.band, pieces: ringsInTiles(far, [b.ring]) }));

const lit = gridOnStage(view, town.city.relief!.grid!);                          // { at, w, h, heights, vertical }
const banks = shoresOnStage(view, town.city.water!.map((f) => f.ring));          // the shores, open, without the cut
const h = heightAt(town.city.relief!.grid!, [500, -200]);                        // metres, for placing things
const core = blendGrid(town.city.relief!.grid!, town.city.terrain!.grid!, { margin: 400 });  // no seam in the terrain

const parts = divisionsOnStage(view, town.city.divisions!);                      // { divisions, borders }: one border for two neighbours
const names = town.city.places!.map((p) => ({ name: p.name, at: view.project(p.at) }));   // a named quarter on the stage

const channel = town.city.features!.find((f) => f.id === 'channel');             // a line, or an area: check `kind`
if (channel?.kind === 'line') for (const s of channel.stretches ?? []) linesOnStage(view, s.lines);   // dashed where s.under
```

- `fitView(box, { w, h, at? }, { mode?, zoom?, shift? })` shows a box of the plane on the stage: `cover` (the default) fills the stage, `contain` shows the whole box; `zoom` and `shift` (metres) frame a part of it. The view turns y down.
- `ringsOnStage` and `linesOnStage` cut the layer to the view with a margin (120 units, room for a camera's push), drop what is too small to see, and thin each outline to at most 200 points without letting it cross itself.
- `ringsInTiles` is for forms too rich for one outline of 200 points, the land and the bands of a terrain: it cuts the stage into tiles and each ring into the pieces that lie in each, so that every piece keeps to the limit and the form keeps its detail. The pieces of a ring come together and overlap by a hair, for fills of one colour: a stroke along them would show the tiles.
- `shoresOnStage` gives the outlines `ringsOnStage` gives for the same rings and options as open lines, without their stretches along the edge they were cut at: a shore line drawn along them never runs along the edge of the map. A ring the cut does not touch comes as one closed line.
- `gridOnStage(view, grid, { margin? })` takes the part of a grid of heights that the view shows (with its margin, 120 units), as the rect it covers on the stage (`at` its middle, `w` by `h`, the first point at the top left), its heights row by row from the top, and `vertical`, the stage units to a metre of height that draw its slopes true. It is what a relief node of skink3-engine takes: `relief({ id, ...lit, vertical: lit.vertical * 3, dark, bright, tints })`.
- `heightAt(grid, [x, y])` reads the height of the ground at a place of the frame (metres) off a grid of heights, between its four nearest points; null outside the grid.
- `blendGrid(fine, coarse, { margin })` eases a fine grid into a coarse one: within `margin` metres of its edge its heights turn along a smooth curve to those of the coarse grid, which they are on the edge itself. A relief of a city's core drawn from it over a relief of its country meets it without a seam.
- `divisionsOnStage(view, divisions, { detail?, minArea?, margin? })` fits a city's divisions to the stage as `worldOnStage` fits countries (its options, its defaults): cut to the view and its margin and thinned together again, level by level, so that two neighbours keep one border on the stage too and their fills meet with no hairline; a division inside another of its level borders it. `divisions` come in the layer's order, each with its `label` on the stage; `borders`, `{ id, level, between, lines }`, are the lines between two of them. `ringsOnStage` on each division alone thins each outline apart, and neighbours can part by a hairline. The layer's `divisionBorders` hold the same borders and the outer outline in metres, for `linesOnStage`.
- A feature goes on the stage as any line or ring does: `linesOnStage` for a line's `lines` or the `lines` of each of its `stretches`, `ringsOnStage` for an area's `ring` and `pieces`.
- `toFrame(frame)` projects a `[lon, lat]` the layers do not hold.
- `faultsOf(layers)` lists what is wrong with a city's layers (an outline that runs clockwise, crosses itself or leaves its frame; epochs out of step; the bands of a terrain out of their order): a project's test holds each of its cities to an empty list.

The layers hold no colour, no label text and nothing of a frame's design. A name in them (`name`) is data.

## A globe

`globe.mjs` builds a round body for a globe: the polygons of its surface in degrees, from public-domain data. The Earth has its land, its large lakes, its ice and its towns, from Natural Earth; the Moon has its maria, the dark seas of basalt, from the mare boundaries of the Lunar Reconnaissance Orbiter Camera. A globe turns, so nothing is projected: a scene's renderer places each point on its own sphere.

```
node globe.mjs --body earth --root examples --scale 110 --preview   # builds examples/earth/; the preview goes to out/earth/globe.png
node globe.mjs --body moon --root examples --preview                # builds examples/moon/
node globe.mjs --body earth --offline                               # from the cache alone; --update takes a changed source
```

- `--tolerance` thins the outlines to that many degrees of arc (the Earth 0.08, the Moon 0.15) and `--min-area` leaves out polygons and holes smaller than that many km² (300 for both). For the Earth, `--scale` is that of Natural Earth, 50 (the default: coasts fine enough for a globe as large as the frame) or 110 (the committed example), and `--lake-area`, `--ice-area` and `--min-pop` leave out the smaller lakes, ice and towns (4000 km², 300 km² and 200 000 people). `globe.json` records them in `made`.
- **Made whole on the sphere.** A flat map cuts a body where the sphere has no edge: Natural Earth closes Antarctica along the south pole and down the 180th meridian, and parts a few islands at that meridian. The build takes the pole and the slit out, so that Antarctica is one ring round the pole, and keeps the parted pieces, whose shared edge lies on one meridian, for a renderer that fills a layer at once.
- **Thinned on the sphere.** Each ring is thinned on the plane of an azimuthal projection round its own middle, where a degree of arc is a degree in every direction, so a coast by a pole is not left far denser than one by the equator; the points kept are the ring's own. Where thinning would make a ring cross itself the tolerance is halved, twice at the most; a ring that still crosses itself then (a narrow neck of land or sea) is thinned at the tolerance all the same, its crossings no wider than the tolerance.
- **Neighbours are thinned apart.** Maria that meet along a line are separate polygons, each thinned alone, so a hairline can open between them: a renderer fills a layer with a hairline stroke of its own colour, as skink3-engine's globe does.

`globe.json`, format `globe-geo/1`, holds `body`, `radiusKm` (the body's mean radius: the areas are of a sphere of it) and `made`, then `layers` in the order they are painted, an entry a line, and the Earth's `places`. Seen from outside, an outer ring runs counter-clockwise round what it holds and a hole clockwise: on a map with north up, it lies to the left of the line.

| Layer | What |
|---|---|
| `layers.land[]` | the Earth's land: `{ id, areaKm2, rings }`, an outer ring, then its holes, the largest polygon first |
| `layers.lakes[]` | `{ id, areaKm2, name, rings }`: its large lakes, painted over the land |
| `layers.ice[]` | `{ id, areaKm2, rings }`: ice sheets and caps (glaciated areas) and the Antarctic ice shelves, painted over the land and the sea |
| `layers.maria[]` | the Moon's maria: `{ id, areaKm2, name, rings }`, painted over its highlands, which are the rest of the sphere |
| `places[]` | `{ name, at, pop }`: the Earth's towns by their greatest population, the largest first: for the lights of a night side |

```ts
import { globeFaults, loadGlobe } from 'skink3-geo';

const earth = loadGlobe(new URL('./earth/globe.json', import.meta.url));
const land = earth.layers.land!.flatMap((p) => p.rings);                    // fill them at once, even-odd: the holes stay open
const lights = earth.places!.slice(0, 800).map((p) => [...p.at, p.pop]);    // the largest towns, by their people
const maria = loadGlobe(new URL('./moon/globe.json', import.meta.url)).layers.maria!.flatMap((p) => p.rings);
globeFaults(earth);                                                         // [] when it keeps to the format
```

A project builds its own globes with `runGlobe(argv, { root, command })` from `skink3-geo/globe.mjs`, as it builds its cities with `run`. `lib/shapefile.mjs` reads the polygons and fields of an ESRI shapefile, which is how the mare boundaries come.

## A world map

`world.mjs` builds a flat map with the outline of every country, from Natural Earth's admin-0 countries (public domain): the whole world at once, or the countries of a box round a place. The whole world is drawn on the Equal Earth projection, whose parallels are straight and whose areas are true, every continent in a shape one knows; a box on the plane of a city's region (Lambert's azimuthal equal-area round its middle), so a map of a country among its neighbours lies on the same plane as the cities in it.

```
node world.mjs --root examples --lakes 2 --preview                                   # the whole world at 1:50m: examples/world/
node world.mjs --map slovenia --name Slovenia --bbox 8.5,42.6,21.5,49.6 --lakes 6 --root examples   # a box at 1:10m: examples/slovenia/
node world.mjs --offline                                                             # from the cache alone; --update takes a changed source
```

- `--scale` is that of Natural Earth: 50 for the world, 10 for a box by default. `--detail` thins the outlines to that many metres (by default half a unit of a 1920 by 1080 stage that the map covers), `--min-area` leaves out islands smaller than that many km² (by default a square six times `--detail` on a side), but every country keeps its largest piece, so the smallest states stay. `--lakes` takes the lakes up to that rank of Natural Earth (0 the largest alone); there are none without it. `--centre` moves the middle of a box's plane.
- **Thinned together.** The countries are cut into arcs where a shared border begins and ends, each arc is thinned once and every country is put together again from its arcs (`lib/topology.mjs`), so two neighbours share their border point for point, with no gap and no overlap. Where thinning makes a ring cross itself the arcs there are thinned less, down to not at all; where the data itself crosses, the point that makes it cross is taken out, and `SOURCES.md` counts them.
- **The land is the countries as one:** the arcs that one country alone runs along are the coast. A box's layers are cut along its edge.

`world.json`, format `world-geo/1`, holds `made` (the options as used) and `frame`, then its layers, an entry a line, in metres on the plane of the frame, x east and y north. Every ring runs counter-clockwise and none crosses itself.

| Key | What |
|---|---|
| `frame` | `{ projection, centre, box, lonlat }`: `equal-earth` round 0° 0° for the world, with its `outline`, the edge of the world, a ring the sea fills; `laea` round `centre` for a box |
| `land[]` | `{ id, ring }`: all the land, the largest first |
| `gaps[]` | `{ id, ring }`: water inside the land that no country holds (the Caspian Sea), painted over the land |
| `countries[]` | `{ id, name, iso?, continent, label, areaKm2, rings }`, the largest first: `id` is Natural Earth's code in lower case (`fra`), `iso` the ISO 3166-1 alpha-3 code where the country has one of its own, `label` a point inside its main land, `rings` its pieces, the largest first. An enclave is a country of its own, painted after the one round it |
| `boundaries[]` | `{ id, between, lines }`: each land border once, between two countries (`between`, their ids in order; `id` is `a-b`), as lines |
| `lakes[]` | `{ id, name, ring }`: the lakes asked for, the largest first, painted over the countries |

```ts
import { fitView, loadWorld, toFrame, worldFaults, worldOnStage } from 'skink3-geo';

const world = loadWorld(new URL('./world/world.json', import.meta.url));
const view = fitView(world.frame.box, { w: 1800, h: 1000 }, { mode: 'contain' });   // the whole world on the stage
const map = worldOnStage(view, world);                  // { sea, land, gaps, countries, borders, lakes } in stage units
const fr = map.countries.find((c) => c.id === 'fra')!;  // its rings, and its label on the stage
const paris = view.project(toFrame(world.frame)([2.35, 48.86]));                      // a place on the map
worldFaults(world);                                                                  // [] when it keeps to the format
```

`worldOnStage(view, world, { detail?, minArea?, margin? })` fits the map to the stage as the map was built: the countries cut to the view and its margin (120 units) and thinned together again to `detail` (0.3 units), so a border is the same points in both its countries and in its line of `borders`, and an enclave borders the country round it; islands and lakes under `minArea` (2 square units) are left out, but a country keeps its largest piece while it covers anything on the stage (on the whole world 1800 wide, only the Vatican is lost). No outline crosses itself, even where a narrow spit comes closer than the stage's tenths: there a point is taken out of the outline alone, and its border is no longer shared exactly at that spot. Each is the `points` of a flat region: the whole world on a stage 1800 wide takes about 3200 points for its largest land, within the 4000 of a flat region. `ringsOnStage` and `linesOnStage` thin each outline alone, so neighbours drawn with them can part by a hairline, and `ringsOnStage` leaves out a ring that the stage's tenths would make cross itself (the largest lands of the whole world); `ringsInTiles` serves a country larger than a renderer's limit. A project builds its own maps with `runWorld(argv, { root, command })` from `skink3-geo/world.mjs`; a world for a small inset is built with a larger `--detail`.

## The spec

`examples/cities/valletta.json` is what the command for a new city writes. A spec may ask for more:

| Key | What it asks for |
|---|---|
| `city`, `name`, `centre`, `views` | the id (the file's name), the name, the centre of the city frame `[lon, lat]`, and the named boxes `[west, south, east, north]` |
| `region` | `bbox`, `centre`, `country` (ISO A3), `rivers.names` or `rivers.rank`, `lakes.rank`: the country context, from Natural Earth |
| `water` | `view`, `from` (any of `ohm`, `osm`, `copernicus`), `mask` (the classes of the Copernicus water mask: `ocean`, `lake`, `river`), `cell` (metres), `rivers` (names, or `{ id, name, match }` with a regular expression) |
| `relief` | `view`, `cell`, `smooth` (metres), `contours` (the heights wanted, as a list, or `{ step }` for a line every so many metres), `hills`, `within`, and `grid`: `true` for the ground as a grid of heights at the relief's `cell`, smoothed as the lines are; `{ cell, smooth }` at a cell and a smoothing (metres) of its own, either left out for the relief's |
| `relief.hills[]` | `{ id, name, summit \| spine, floor, reach }`: a hill is the ground that falls away from its `summit` `[lon, lat]`, down to `floor` metres and out to `reach` metres; neighbours part along the hollow between them. A ridge with no one top is given by a `spine`, a line along its crest |
| `relief.within` | `{ wall, margin }`: no hill reaches more than `margin` metres outside that wall. For hills that are spurs of higher ground and have no foot on one side |
| `terrain` | `view` (a wide one), and, each with a default by the scale: `cell` (metres; about 800 cells from the south of the view to its north, in whole tens, 30 at the least), `smooth` (metres, two cells), `levels` (the heights the bands part at; of 25, 50, 100, 200, 400, 800, 1600, 3200 and 6400 m, those the ground reaches), `detail`, `minArea`, `grid` (as the relief's, at the terrain's `cell`), and `source`, a sentence for `SOURCES.md` on what the layer rests on |
| `terrain.coast` | `{ from, file?, note? }`: `copernicus` (the default) is the sea of the water body mask, of 2011-2015; `awmc` is the open water of the Ancient World Mapping Center, with the coast as it reconstructs it for antiquity, from the GeoJSON `file` named by its path in its repository (`Physical Data/open_water_osm_edits/...`). `note` goes into `SOURCES.md`: how old that coast is, and where it differs from today's |
| `terrain.lakes` | lakes come from the water body mask; `{ skip: [[lon, lat], ...], note? }` leaves out those at the places given (a reservoir of today on a map of the past), `minArea` sets the smallest kept, and `false` asks for none |
| `terrain.rivers` | `{ from, list }`: `osm` (the default) or `ohm`, and the rivers as names or `{ id, name, match }`. They are asked for by name alone, so a wide box does not fetch every stream in it |
| `walls[]` | `{ id, name, built, from: { ohm \| osm: [elements] }, draw?, check?, source }`: the circuit joined from the ways of the elements named; `draw` adds stretches by hand where the map has gaps, and `check` holds the result to another map's fragments |
| `streets` | `view`, `from` (`ohm`, `osm` or `natural-earth`), `classes`, `minLength`, `year`. From OpenStreetMap and OpenHistoricalMap the classes are values of `highway` (`motorway`, `trunk`, `primary` by default); from Natural Earth's roads of 1:10m (a country's whole view) they are its road types: `major-highway`, `secondary-highway` (the default), `beltway`, `bypass`, `road`, `track`, `unknown`, `ferry-route`, `ferry-seasonal` |
| `divisions` | `view`, `from` (`osm`, the only source), `level` (an `admin_level` of OpenStreetMap, 1 to 12, or a list of them: what a level holds differs by country, so it is read off the map of that country first), `names` (only the divisions of those names, as their `name` or `name:en`; a name not found stops the build), `detail` (metres, by default the view's height over 2200), `minArea` (m², the least piece kept, by default a square six times `detail` on a side) |
| `places` | `view`, `from` (`osm`, the only source), `kinds` (values of OpenStreetMap's `place`: `suburb`, `quarter`, `neighbourhood` by default; also `city`, `borough`, `city_block`, `town`, `village`, `hamlet`, `isolated_dwelling`, `farm`, `locality`, `square`, `island`, `islet`), `detail` (metres, the thinning of the outline of a place mapped as an area, 4) |
| `builtUp` | `view`, `from` (`ghsl`, `osm` or `natural-earth`), `years` (of `ghsl`), `share` (the share of the ground built on from which a cell counts, 0.2), `bridge` (gaps under twice this many metres are closed, so the city is one body), `round`, `minPiece` |
| `epochs[]` | `{ id, year, name, outline, source, note? }`; the outline is `{ hill }`, `{ wall }`, `{ points: [[lon, lat], ...] }` drawn by hand, `{ builtUp: 2020 }` (the built-up city of that year) or `{ builtUp: true }` (the latest) |
| `landmarks[]` | `{ id, name, built?, at \| ohm \| osm }`: a place given by hand, or the middle of a mapped element |
| `features[]` | `{ id, name, kind, from, start?, built?, until?, under?, view?, detail?, smooth?, source }`: `kind` is `line` or `area`; `from` is `{ ohm?, osm?, points? }`, the ways and relations of OpenHistoricalMap or OpenStreetMap (`way/<id>`, `relation/<id>`), points `[[lon, lat], ...]` drawn by hand after a written source, or both; `start` (a line, `[lon, lat]`) the end it begins at; `built` and `until` the years it stood; `under` (a line) its stretches below the ground, `[[from, to], ...]` in kilometres from its start, in order and none over another; `view` the view it is cut to (the whole city frame by default); `detail` the thinning in metres (2); `smooth` how many times its corners are cut, a quarter of each side at a time (0); `source` the sentence `SOURCES.md` gives for it: the written source it is drawn after, or what the map shows. Its elements are asked for only when a feature names them |

Every source a layer names in `from` is required: a source that does not answer stops the build, and nothing falls back in silence, so the layers are a function of the spec and the downloads alone.

## Sources and licences

Only open data is read. The table of sources is `lib/sources.mjs`; a source comes into it after its terms are read on its own page.

| Source | For | Licence | In a film's description |
|---|---|---|---|
| Natural Earth 5.1.2, 1:10m | the region; a country's main roads (`streets` from `natural-earth`) | public domain | not required |
| Natural Earth 5.1.2, 1:50m and 1:110m land, lakes, glaciated areas, Antarctic ice shelves, and 1:10m populated places | the Earth for a globe (`globe.mjs`) | public domain | not required |
| Natural Earth 5.1.2, 1:10m, 1:50m and 1:110m admin-0 countries and lakes | a world map (`world.mjs`) | public domain | not required |
| LROC Global Mare Boundaries (Nelson et al. 2014), in NASA's Planetary Data System | the Moon's maria for a globe | public domain | not required, the line in `SOURCES.md` |
| Copernicus DEM GLO-30 and its water body mask | relief and terrain; sea, lakes and wide rivers | free with attribution | **required**, the line in `SOURCES.md` |
| Global Human Settlement Layer, GHS-BUILT-S R2023A (European Commission, JRC) | the built-up city of 1975 to today | free and open, reuse with acknowledgment of the source | **required**, the line in `SOURCES.md` |
| OpenHistoricalMap | walls, rivers, streets with their years, landmarks, features | CC0 | not required |
| OpenStreetMap | water, streets, land use, a wall check, administrative divisions, named places, features | ODbL | **required**: © OpenStreetMap contributors |
| Ancient World Mapping Center geodata, at a fixed commit | the coast of the ancient world, where a terrain asks for it | ODbL | **required**, the line in `SOURCES.md` |
| SRTM | relief, where a spec names an HGT file | public domain | not required |

- `<city>/SOURCES.md` is written by the build: the credit lines for the description of a film that shows the layers, the source of every layer, and what was drawn by hand from which written source.
- **Layers made from OpenStreetMap data are a database derived from it**, and the ODbL's share-alike holds for them. The same goes for the geodata of the Ancient World Mapping Center, which is under the ODbL and contains OpenStreetMap data. This repository holds none of either: its example reads Natural Earth, Copernicus and the Global Human Settlement Layer only.
- **The credit of OpenStreetMap in a film.** Its [attribution guidelines](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines) ask a video that shows a map made from its data for "© OpenStreetMap contributors" with the address of its copyright page, in the end credits or the description; where such a map is a large part of the frame, also on the map itself, in a corner, where it can be read.
- A download is untrusted data. Each lands in a directory of its own under `cache/` and is only ever read as data. `sources.lock.json` holds its SHA-256, and a build whose download differs from the lock stops until it is run with `--update`.
- A request carries a generic client name and nothing of the project that sends it.
- The output is deterministic: the same spec and the same downloads give the same `layers.json`, byte for byte.

## The tests

`test/geom.test.ts` holds the plane geometry and the projection; `test/pipeline.test.mjs` the readers (TIFF, BigTIFF, LZW, ZIP), the grids and contours, the hills, the tiles read by the scale, the terrain of an island made in the test, the grids of heights of a relief and a terrain, the built-up outline, walls, epochs, the spec of a new city and the options of a project of its own, all on inputs made in the test; `test/example.test.ts` holds the committed example to the format and to what `map.ts` makes of it on a stage, its terrain in tiles included; `test/stage.test.ts` the shores of water cut by a view, a grid of heights fitted to a stage, the height at a place, a fine grid eased into a coarse one, and the faults of a grid; `test/globe.test.ts` the committed Earth and Moon to their format, rings measured, oriented, made whole and thinned on the sphere, a shapefile made in the test, and globes built from collections made in the test; `test/world.test.ts` the committed world and box to their format, the Equal Earth projection, outlines thinned together, and maps built from collections made in the test; `test/osm-layers.test.mjs` the divisions (a shared border, the cut, the label, the levels, the names, what is refused), the named places, the roads of Natural Earth, their requests, and a build from a cache made in the test, a spec that asks for none of them included; `test/features.test.mjs` the features (a line joined from ways and points, its start, its cut and its stretches below the ground, an area from a closed way, a relation without its hole, points drawn and a cut into pieces, what is refused, the faults they are held to, their requests, and a build from a cache made in the test, a spec without them included); `test/stage.test.ts` also the divisions on a stage and the faults of divisions and places. They download nothing.

## Rules

- **General code only.** No name of a production, a channel or a video, and none of its decisions: those live in the project that uses this library. The example and the tests use a neutral city.
- **English only:** code, comments, docs and commit messages.
- **Determinism.** The layers are a pure function of the spec and the downloads. Dependency versions are pinned exactly.
- **Open data only,** each source under its own licence, with its credit written into `SOURCES.md`.
- **Commit explicit paths only.** Before a push, search the diff for production-specific names, personal data, keys and paths of a specific machine.

## Open

- On 2026-11-22 the OpenStreetMap paths of `streets`, `divisions`, `places` and a terrain's `rivers` ran on real answers of Overpass, for a city view (a capital's communes, quarters and main streets) and a small country's whole view (its rivers, main roads, communes and towns), built outside this repository, which keeps no layer made from OpenStreetMap. `water` and `builtUp` with `from: "osm"`, and a wall's `check`, have not run on a real answer yet. The rivers of a terrain had run on OpenHistoricalMap's before.
- Overpass is often busy: its mirrors fail in turn before one answers, and a build that asks it for several layers can take a quarter of an hour. Each answer is fetched once; the cache serves it after.
- Natural Earth's roads are coarse: a point every few kilometres, and in some countries only a handful of roads, with no numbers. For a country's main roads in detail, `streets` from `osm` with `trunk` and `primary` over the country's view.
- Divisions keep no holes, and the levels are thinned apart: where a border of one level is also one of the next, the two lines may part by up to `detail`. What a level holds differs by country, and a view across a border holds the divisions of that level on both sides (`names` keeps those wanted; there is no filter by country yet). A boundary is drawn as OpenStreetMap maps it: on a coast it may run out over the sea (a municipality's waters), which a scene covers with the sea; this has not been tried on a coast yet.
- A terrain whose view reaches the open sea does not build `--offline`: the tiles the elevation model lacks there are not in the cache, and only a run online learns that they are missing.
- Only the GeoJSON files of the Ancient World Mapping Center are read: its open water by sea, one coast for all antiquity. Its shapefiles of the water of single periods are not.
- Heights are of a surface model: a hill's `height` includes roofs, and a terrain's bands the woods.
- Features have run on answers made in the tests only, not yet on a real answer of Overpass. Their years and their stretches below the ground come from the spec: the dates and the tunnel tags of the elements are not read.

## License

The code of this repository is under the MIT License: see [`LICENSE`](LICENSE). Third-party components keep their own licenses: skia-canvas (MIT) and Skia (BSD-3-Clause) draw the previews.

**The data is not under it.** What the pipeline downloads, and the layers it makes of it (the example's `layers.json` among them), stay under the licences of their sources. Whoever publishes layers, or a picture made from them, gives the credit each source asks for. The build writes those lines into a city's `SOURCES.md`; they are, each checked on the source's own page:

| Source | Its terms | The credit it asks for |
|---|---|---|
| [Natural Earth](https://www.naturalearthdata.com/about/terms-of-use/) | public domain: "All versions of Natural Earth raster + vector map data found on this website are in the public domain." | none: "No permission is needed to use Natural Earth. Crediting the authors is unnecessary." For those who wish to cite it: "Made with Natural Earth." |
| [Copernicus DEM GLO-30](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM) and its water body mask | free of charge under the licence of the Copernicus DEM: "The GLO-30 and GLO-90 datasets are available worldwide with a free license." | **required.** Where the data has been adapted or modified, as in every layer made from it: "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved". For the data as it is: "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved." |
| [Global Human Settlement Layer](https://human-settlement.emergency.copernicus.eu/download.php), GHS-BUILT-S R2023A (European Commission, Joint Research Centre) | the European Commission's reuse notice: "Reuse of this data is authorised with proper acknowledgment of the source." The pages of the layer name no licence beyond that notice; under the Commission's reuse policy, content it owns is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) unless otherwise indicated, which also asks that changes be indicated | **required:** the source acknowledged, as in "Built-up areas: GHS-BUILT-S R2023A, Global Human Settlement Layer, European Commission, Joint Research Centre." Its citation: Pesaresi, Martino; Politis, Panagiotis: GHS-BUILT-S R2023A - GHS built-up surface grid, derived from Sentinel2 composite and Landsat, multitemporal (1975-2030). European Commission, Joint Research Centre. doi:10.2905/9F06F36F-4B11-47EC-ABB0-4F8B7B1D72EA |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) | ODbL 1.0; layers made from it are a derived database, shared alike | **required:** "© OpenStreetMap contributors" |
| [Ancient World Mapping Center geodata](https://github.com/AWMC/geodata#license) | ODbL 1.0: "The GeoJson files are offered under the ODC Open Database License". It is derived from the Barrington Atlas of the Greek and Roman World and holds the Center's modifications to OpenStreetMap; layers made from it are a derived database, shared alike | **required:** the Center and the licence named, and "© OpenStreetMap contributors" |
| [OpenHistoricalMap](https://www.openhistoricalmap.org/copyright) | CC0 1.0 | none |
| [LROC Global Mare Boundaries](https://lroc.im-ldi.com/about/terms), from the [PDS archive](https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/EXTRAS/SHAPEFILE/LROC_GLOBAL_MARE/) | public domain: "Data products available through the LROC Data Node of the PDS or through NASA PDS interfaces are in the public domain." | none required; its readme asks the product be cited: Nelson, D. M., et al. (2014), "Mapping lunar maria extents and lobate scarps using LROC image products", Lunar and Planetary Science Conference 45, 2861. LROC asks its images be credited "NASA/GSFC/Arizona State University" |
| [SRTM](https://www.earthdata.nasa.gov/data/instruments/srtm) | public domain | none |

The example city in this repository is made from the first three alone; the example globes from Natural Earth and the LROC mare boundaries.

