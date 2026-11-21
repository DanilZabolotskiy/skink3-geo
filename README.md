# skink3-geo

Real geographic data turned into the simplified vector layers a city's map is drawn from: the country round it, the terrain of its surroundings in bands of height, the sea and the rivers in their true width, the relief, walls, main streets, the built-up land, and the city's outline through time, ready to grow from one epoch into the next; and a round body for a globe, the Earth or the Moon, in degrees. One spec a city, one command, and the same bytes every time, with the credit of every source written out.

It is made for animated maps (the scenes of [skink3-engine](https://github.com/DanilZabolotskiy/skink3-engine) among them), but it draws nothing and depends on no renderer: its output is one JSON file of points in metres (in degrees, for a globe).

```
build.mjs, lib/             the pipeline: plain Node, no package needed to build
globe.mjs                   a round body for a globe, the Earth or the Moon, in degrees ("A globe")
map.ts                      for a scene: the types of the layers, loading, the fit into a stage
test/                       the tests
examples/                   a root of cities, with one small city built: Valletta
  cities/<city>.json        the spec: the frames, the layers wanted, the epochs and their sources
  <city>/layers.json        the layers: the only file a scene reads
  <city>/SOURCES.md         where each layer comes from, what was drawn by hand, the credit lines
  <city>/sources.lock.json  every download: its request, its SHA-256, its size, its date
  earth/, moon/             the Earth at 1:110m and the Moon, for a globe, each with its SOURCES.md and its lock
  cache/, out/              not in git: the raw downloads, and the previews
```

```
npm ci                                                  # the pinned packages (the canvas of the previews, the type checker)
node build.mjs valletta --root examples --preview       # build; download what the cache lacks; draw the previews
node build.mjs valletta --root examples --offline       # build from the cache alone
node build.mjs valletta --root examples --update        # take a source that has changed since the lock
npm run check                                           # the type check and the tests
```

`--root` is the directory that holds `cities/` (the working directory when it is not given). The previews, 1920 x 1080, go to `out/<city>/`: `region.png`, `city-<view>.png`, `terrain.png`, `hills.png`, `epochs-morph.png`, `epochs-morph-whole.png` (the view a terrain covers is shown by `terrain.png` alone). They check that every layer is in its place. They are not a design.

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
| `city.streets[]` | `{ id, class, name?, ref?, from?, to?, lengthKm, lines[] }`: main streets, the widest class first; `from` and `to` are the years a street stood, where the source dates it |
| `city.builtUp[]` | `{ id, year?, areaHa, ring, pieces[] }`: the built-up city of a year, the earliest first. `ring` is the body that holds the centre; `pieces` are the other large bodies, which a strait or a valley parts from it |
| `city.epochs[]` | `{ id, year, name, areaHa, ring, morph }`: the city's outline through time, the earliest first; a year BC is negative |
| `city.landmarks[]` | `{ id, name, built?, at, lonlat }` |
| `city.terrain` | `{ view?, box, cell, levels[], land[], bands[], lakes[], rivers[], grid? }`: the country round the city, for a map with depth, in the city's own plane with points to 1 m. See "The terrain" |

**The terrain.** A wide view (a coast, a plain, the hills round it) is too large for the city's fine layers and too close for the region's, so it has a layer of its own, made from the elevation model at the scale of the view: the tiles are read in blocks, each cell of the grid is the mean height of the ground it covers, and the grid is smoothed, so that a form is soft and nothing is a speck.

- `land[]`, `{ id, areaHa, ring }`: the land that stands out of the sea, the largest first, an island a ring of its own. The sea is what the land leaves.
- `bands[]`, `{ id, band, height, pit?, areaHa, ring }`: the ground by height, **in the order to paint it** over the land, a ring before those inside it. A ring at `height` holds the ground at least that high, and `band` is its place among the `levels`: band 0 is the land below `levels[0]`, band *k* the ground from `levels[k - 1]` up. A ring with `pit` holds a hollow below `height` within higher ground (a crater, a closed valley) and is painted as the band it goes down into. One colour a band, painted in the order given, makes the map; a small shift of each band, or a shadow under it, makes it a relief.
- `lakes[]`, `{ id, areaHa, ring }`: standing water apart from the sea, painted over the bands.
- `rivers[]`, `{ id, name, lengthKm, lines[] }`: the rivers the spec names, each cut where it meets the sea. A river lies in its valley, because the bands round it are the same ground.
- `cell` is the size of the grid in metres: a form smaller than a few cells is not in the layer. No band comes nearer the sea than about a cell, so a cliff keeps a rim of the land below it and the bands always lie on the land.

The heights are those of today. The coast is today's too, unless the spec takes it from a map of another age; then the land and the heights are of two dates, and the city's `SOURCES.md` says so.

**The grid of heights.** A relief or a terrain whose spec asks for it (`grid`) also holds the ground it was traced from, smoothed as its lines are or as the spec says (`grid: { smooth }`), as a grid of heights for a renderer that lights the ground itself (relief shading), which reads as one rolling surface where bands read as steps. `cols` by `rows` points lie `cell` metres apart, from the north-west corner of `box` to its south-east corner, so the points lie on its edges; `values` holds their heights in metres, to a tenth, row by row from the north, each row from the west, as an image holds its pixels. A terrain's grid is held to the first of its `levels` along the sea, as its bands are. It is large (a value a point): a scene takes the part its view shows with `gridOnStage`, and a spec that covers a wide box asks for a coarser `cell`.

**The morph.** Every epoch of a city has a second outline, `morph`, of the same number of points (160) set at equal steps along it, counter-clockwise and turned so that point *k* of one epoch lies nearest to point *k* of the next. A scene that draws the two as one region with the same point count grows the city from one epoch into the next with no further work. An outline with far more detail than 160 points can hold (a city of today, with its inlets and arms) is calmed first, so its `morph` follows its body and its `ring` keeps the detail.

Heights come from a surface model, so they include buildings and trees, and are smoothed: a hill's `height` is good to a few metres and is not a figure to put on screen.

## In a scene

`map.ts` reads the layers and fits them into a stage. It draws nothing and names no colour.

```ts
import { blendGrid, fitView, gridOnStage, heightAt, linesOnStage, loadLayers, morphOnStage, ringsInTiles, ringsOnStage, shoresOnStage } from 'skink3-geo';

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
```

- `fitView(box, { w, h, at? }, { mode?, zoom?, shift? })` shows a box of the plane on the stage: `cover` (the default) fills the stage, `contain` shows the whole box; `zoom` and `shift` (metres) frame a part of it. The view turns y down.
- `ringsOnStage` and `linesOnStage` cut the layer to the view with a margin (120 units, room for a camera's push), drop what is too small to see, and thin each outline to at most 200 points without letting it cross itself.
- `ringsInTiles` is for forms too rich for one outline of 200 points, the land and the bands of a terrain: it cuts the stage into tiles and each ring into the pieces that lie in each, so that every piece keeps to the limit and the form keeps its detail. The pieces of a ring come together and overlap by a hair, for fills of one colour: a stroke along them would show the tiles.
- `shoresOnStage` gives the outlines `ringsOnStage` gives for the same rings and options as open lines, without their stretches along the edge they were cut at: a shore line drawn along them never runs along the edge of the map. A ring the cut does not touch comes as one closed line.
- `gridOnStage(view, grid, { margin? })` takes the part of a grid of heights that the view shows (with its margin, 120 units), as the rect it covers on the stage (`at` its middle, `w` by `h`, the first point at the top left), its heights row by row from the top, and `vertical`, the stage units to a metre of height that draw its slopes true. It is what a relief node of skink3-engine takes: `relief({ id, ...lit, vertical: lit.vertical * 3, dark, bright, tints })`.
- `heightAt(grid, [x, y])` reads the height of the ground at a place of the frame (metres) off a grid of heights, between its four nearest points; null outside the grid.
- `blendGrid(fine, coarse, { margin })` eases a fine grid into a coarse one: within `margin` metres of its edge its heights turn along a smooth curve to those of the coarse grid, which they are on the edge itself. A relief of a city's core drawn from it over a relief of its country meets it without a seam.
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
| `streets` | `view`, `from` (`ohm` or `osm`), `classes`, `minLength`, `year` |
| `builtUp` | `view`, `from` (`ghsl`, `osm` or `natural-earth`), `years` (of `ghsl`), `share` (the share of the ground built on from which a cell counts, 0.2), `bridge` (gaps under twice this many metres are closed, so the city is one body), `round`, `minPiece` |
| `epochs[]` | `{ id, year, name, outline, source, note? }`; the outline is `{ hill }`, `{ wall }`, `{ points: [[lon, lat], ...] }` drawn by hand, `{ builtUp: 2020 }` (the built-up city of that year) or `{ builtUp: true }` (the latest) |
| `landmarks[]` | `{ id, name, built?, at \| ohm \| osm }`: a place given by hand, or the middle of a mapped element |

Every source a layer names in `from` is required: a source that does not answer stops the build, and nothing falls back in silence, so the layers are a function of the spec and the downloads alone.

## Sources and licences

Only open data is read. The table of sources is `lib/sources.mjs`; a source comes into it after its terms are read on its own page.

| Source | For | Licence | In a film's description |
|---|---|---|---|
| Natural Earth 5.1.2, 1:10m | the region | public domain | not required |
| Natural Earth 5.1.2, 1:50m and 1:110m land, lakes, glaciated areas, Antarctic ice shelves, and 1:10m populated places | the Earth for a globe (`globe.mjs`) | public domain | not required |
| LROC Global Mare Boundaries (Nelson et al. 2014), in NASA's Planetary Data System | the Moon's maria for a globe | public domain | not required, the line in `SOURCES.md` |
| Copernicus DEM GLO-30 and its water body mask | relief and terrain; sea, lakes and wide rivers | free with attribution | **required**, the line in `SOURCES.md` |
| Global Human Settlement Layer, GHS-BUILT-S R2023A (European Commission, JRC) | the built-up city of 1975 to today | free and open, reuse with acknowledgment of the source | **required**, the line in `SOURCES.md` |
| OpenHistoricalMap | walls, rivers, streets with their years, landmarks | CC0 | not required |
| OpenStreetMap | water, streets, land use, a wall check | ODbL | **required**: © OpenStreetMap contributors |
| Ancient World Mapping Center geodata, at a fixed commit | the coast of the ancient world, where a terrain asks for it | ODbL | **required**, the line in `SOURCES.md` |
| SRTM | relief, where a spec names an HGT file | public domain | not required |

- `<city>/SOURCES.md` is written by the build: the credit lines for the description of a film that shows the layers, the source of every layer, and what was drawn by hand from which written source.
- **Layers made from OpenStreetMap data are a database derived from it**, and the ODbL's share-alike holds for them. The same goes for the geodata of the Ancient World Mapping Center, which is under the ODbL and contains OpenStreetMap data. This repository holds none of either: its example reads Natural Earth, Copernicus and the Global Human Settlement Layer only.
- A download is untrusted data. Each lands in a directory of its own under `cache/` and is only ever read as data. `sources.lock.json` holds its SHA-256, and a build whose download differs from the lock stops until it is run with `--update`.
- A request carries a generic client name and nothing of the project that sends it.
- The output is deterministic: the same spec and the same downloads give the same `layers.json`, byte for byte.

## The tests

`test/geom.test.ts` holds the plane geometry and the projection; `test/pipeline.test.mjs` the readers (TIFF, BigTIFF, LZW, ZIP), the grids and contours, the hills, the tiles read by the scale, the terrain of an island made in the test, the grids of heights of a relief and a terrain, the built-up outline, walls, epochs, the spec of a new city and the options of a project of its own, all on inputs made in the test; `test/example.test.ts` holds the committed example to the format and to what `map.ts` makes of it on a stage, its terrain in tiles included; `test/stage.test.ts` the shores of water cut by a view, a grid of heights fitted to a stage, the height at a place, a fine grid eased into a coarse one, and the faults of a grid; `test/globe.test.ts` the committed Earth and Moon to their format, rings measured, oriented, made whole and thinned on the sphere, a shapefile made in the test, and globes built from collections made in the test. They download nothing.

## Rules

- **General code only.** No name of a production, a channel or a video, and none of its decisions: those live in the project that uses this library. The example and the tests use a neutral city.
- **English only:** code, comments, docs and commit messages.
- **Determinism.** The layers are a pure function of the spec and the downloads. Dependency versions are pinned exactly.
- **Open data only,** each source under its own licence, with its credit written into `SOURCES.md`.
- **Commit explicit paths only.** Before a push, search the diff for production-specific names, personal data, keys and paths of a specific machine.

## Open

- OpenStreetMap's Overpass servers did not answer on the days this was built, so the layers taken from OpenStreetMap (`water`, `streets` and `builtUp` with `from: "osm"`, and a wall's `check`) are written but have not run on a real answer yet. The paths through OpenHistoricalMap, Natural Earth, Copernicus and the Global Human Settlement Layer have.
- The rivers of a terrain have run on a real answer of OpenHistoricalMap, in a project that uses this library; not on OpenStreetMap's, for the same reason.
- Only the GeoJSON files of the Ancient World Mapping Center are read: its open water by sea, one coast for all antiquity. Its shapefiles of the water of single periods are not.
- Heights are of a surface model: a hill's `height` includes roofs, and a terrain's bands the woods.

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

